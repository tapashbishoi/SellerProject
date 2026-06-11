/**
 * EDI Outbound Sender — async MQ consumer for edi_outbound and edi_order_events
 * Sends 997 (ack), 855 (PO ack), 856 (ship notice), 810 (invoice)
 * Delivers via HTTPS callback to partner URL (AS2 signing in Phase 2B)
 */
require('dotenv').config();
const pool   = require('../db');
const fetch  = require('node-fetch');
const { consumeEDI, publishEDI } = require('./mq');
const { generate855, generate856, generate810 } = require('./generator');
const { OUR_ISA_ID } = require('./receiver');

// ── Deliver outbound EDI to partner ───────────────────────────
async function deliverEDI(partner, rawEdi, ediType) {
  const ackRequired = partner.expects_ack && ['855','856','810'].includes(ediType);
  const { rows: msgRows } = await pool.query(
    `INSERT INTO edi_messages (direction, transaction_set, partner_id, raw_edi, status, ack_required)
     VALUES ('outbound',$1,$2,$3,'queued',$4) RETURNING id`,
    [ediType, partner.partner_id, rawEdi, ackRequired]
  );
  const msgId = msgRows[0].id;

  try {
    if (partner.callback_url) {
      // HTTPS delivery
      const res = await fetch(partner.callback_url, {
        method:  'POST',
        headers: {
          'Content-Type':      'application/edi-x12',
          'AS2-From':          process.env.EDI_AS2_ID || 'SELLERAGENT-AS2',
          'AS2-To':            partner.as2_id || partner.partner_id,
          'EDI-Transaction':   ediType,
          'Message-ID':        `<${msgId}@selleragent>`,
        },
        body: rawEdi,
        timeout: 15000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      console.log(`[EDI-Sender] ✅ Sent ${ediType} to ${partner.company_name} (${res.status})`);
    } else {
      // No callback URL — log only (manual pickup or future SFTP)
      console.log(`[EDI-Sender] ${ediType} stored for ${partner.partner_id} (no callback URL — awaiting pickup)`);
    }
    await pool.query(`UPDATE edi_messages SET status='sent', processed_at=NOW() WHERE id=$1`, [msgId]);
  } catch (err) {
    console.error(`[EDI-Sender] ❌ Failed to send ${ediType}:`, err.message);
    await pool.query(`UPDATE edi_messages SET status='failed', error_detail=$1 WHERE id=$2`, [err.message, msgId]);
  }
  return msgId;
}

// ── Handle outbound queue (997, 855, 856 from processor) ──────
async function handleOutbound(payload) {
  const { edi_type, partner, raw_edi } = payload;
  if (!raw_edi || !partner) {
    console.warn('[EDI-Sender] Missing raw_edi or partner in outbound message');
    return;
  }
  await deliverEDI(partner, raw_edi, edi_type);
}

// ── Handle order events → generate + send 855/856/810 ────────
async function handleOrderEvent(payload) {
  const { event, order_id } = payload;

  // Load order with items + partner + DC
  const { rows } = await pool.query(`
    SELECT o.*,
      dc.name AS dc_name, dc.dc_code, dc.city AS dc_city, dc.state AS dc_state,
      dc.address AS dc_address, dc.zip AS dc_zip,
      json_agg(json_build_object(
        'product_id',   oi.product_id,
        'product_name', p.name,
        'quantity',     oi.quantity,
        'unit_price',   oi.unit_price
      )) FILTER (WHERE oi.id IS NOT NULL) AS items
    FROM orders o
    LEFT JOIN distribution_centers dc ON dc.id = o.assigned_dc_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.id = $1
    GROUP BY o.id, dc.name, dc.dc_code, dc.city, dc.state, dc.address, dc.zip
  `, [order_id]);

  if (!rows.length) { console.warn(`[EDI-Sender] Order #${order_id} not found`); return; }
  const order = rows[0];

  // Only process EDI-sourced orders
  if (order.channel !== 'edi' || !order.edi_partner_id) {
    return; // Not an EDI order — skip
  }

  // Load partner
  const { rows: partners } = await pool.query(
    `SELECT * FROM edi_trading_partners WHERE partner_id=$1`, [order.edi_partner_id]
  );
  if (!partners.length) { console.warn(`[EDI-Sender] Partner ${order.edi_partner_id} not found`); return; }
  const partner = partners[0];

  const shipTo = {
    name:    order.shipping_name,
    street:  order.shipping_street,
    city:    order.shipping_city,
    state:   order.shipping_state,
    zip:     order.shipping_zip,
    country: order.shipping_country || 'US',
  };
  const dcInfo = {
    name:    order.dc_name,
    dc_code: order.dc_code,
    city:    order.dc_city,
    state:   order.dc_state,
    address: order.dc_address,
    zip:     order.dc_zip,
  };

  if (event === 'order.confirmed' && partner.send_855 !== false) {
    // Generate 855
    const edi855 = generate855({
      sender_id:   OUR_ISA_ID,
      receiver_id: partner.isa_id,
      po_number:   order.edi_po_number,
      po_date:     new Date(order.created_at).toISOString().slice(0,10).replace(/-/g,''),
      order_id:    order.id,
      status:      'confirmed',
      items:       order.items || [],
      ship_to:     shipTo,
      accepted:    true,
      notes:       `Order confirmed. Fulfilling from ${order.dc_name || 'DC'}`,
    });
    await deliverEDI(partner, edi855, '855');
    console.log(`[EDI-Sender] 855 sent for Order #${order_id}`);
  }

  if (event === 'order.shipped' && partner.send_856 !== false) {
    // Generate 856
    const edi856 = generate856({
      sender_id:     OUR_ISA_ID,
      receiver_id:   partner.isa_id,
      po_number:     order.edi_po_number,
      order_id:      order.id,
      items:         order.items || [],
      ship_from_dc:  dcInfo,
      ship_to:       shipTo,
      tracking_number: order.tracking_number || null,
    });
    await deliverEDI(partner, edi856, '856');
    console.log(`[EDI-Sender] 856 sent for Order #${order_id}`);
  }

  if (event === 'order.delivered' && partner.send_810 === true) {
    // Generate 810 invoice
    const invoiceNumber = `INV-${order.id}-${Date.now().toString().slice(-6)}`;
    const edi810 = generate810({
      sender_id:      OUR_ISA_ID,
      receiver_id:    partner.isa_id,
      po_number:      order.edi_po_number,
      order_id:       order.id,
      invoice_number: invoiceNumber,
      items:          order.items || [],
      ship_to:        shipTo,
      total_amount:   order.total_amount,
    });
    await deliverEDI(partner, edi810, '810');
    console.log(`[EDI-Sender] 810 invoice ${invoiceNumber} sent for Order #${order_id}`);
  }
}

// ── Start consumers ───────────────────────────────────────────
async function startEDISender() {
  await consumeEDI('edi_outbound',     handleOutbound);
  await consumeEDI('edi_order_events', handleOrderEvent);
  console.log('[EDI-Sender] Listening for outbound + order event messages');
}

module.exports = { startEDISender, publishEDI };
