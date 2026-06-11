/**
 * EDI Processor — async MQ consumer for edi_850_processing and edi_860_processing
 * Validates parsed EDI, generates 997, creates/modifies orders.
 */
require('dotenv').config();
const pool = require('../db');
const { consumeEDI, publishEDI } = require('./mq');
const { parseX12, parse850, parse860 } = require('./parser');
const { publishOrder } = require('../mq/publisher');
const { OUR_ISA_ID } = require('./receiver');

// ── Validate 850 ──────────────────────────────────────────────
function validate850(order850) {
  const errors = [];
  if (!order850.po_number)      errors.push({ segment_id: 'BEG', position: 1, code: '5', msg: 'Missing PO Number (BEG03)' });
  if (!order850.items?.length)  errors.push({ segment_id: 'PO1', position: 1, code: '5', msg: 'No line items found' });
  order850.items?.forEach((item, i) => {
    if (!item.product_id)   errors.push({ segment_id: 'PO1', position: i+1, code: '5', msg: `Line ${i+1}: missing product ID` });
    if (!item.quantity || item.quantity <= 0) errors.push({ segment_id: 'PO1', position: i+1, code: '6', msg: `Line ${i+1}: invalid quantity` });
  });
  if (!order850.ship_to?.state) errors.push({ segment_id: 'N4', position: 1, code: '5', msg: 'Missing ship-to state (N4)' });
  return errors;
}

// ── Map 850 product IDs to internal product IDs ───────────────
async function resolveProducts(items) {
  const resolved = [];
  const missing  = [];
  for (const item of items) {
    // Try: exact match on name (ILIKE), or ID if numeric
    const { rows } = await pool.query(
      `SELECT id, name, price FROM products
       WHERE id::text = $1 OR UPPER(name) = UPPER($1)
       LIMIT 1`,
      [item.product_id]
    );
    if (rows.length) {
      resolved.push({ ...item, internal_product_id: rows[0].id, product_name: rows[0].name, list_price: rows[0].price });
    } else {
      missing.push(item.product_id);
    }
  }
  return { resolved, missing };
}

// ── Process 850 ───────────────────────────────────────────────
async function process850(payload) {
  const { edi_message_id, raw_edi, partner, isa_control, gs_control } = payload;

  let order850, validationErrors;
  try {
    const envelope = parseX12(raw_edi);
    order850 = parse850(envelope);
    validationErrors = validate850(order850);
  } catch (err) {
    await logError(edi_message_id, `Parse/validation error: ${err.message}`);
    await send997(partner, isa_control, gs_control, order850?.st_control, false, [{ segment_id: 'ISA', position: 1, code: '5', msg: err.message }]);
    return;
  }

  // Store parsed JSON
  await pool.query(`UPDATE edi_messages SET parsed_json=$1, po_number=$2 WHERE id=$3`,
    [order850, order850.po_number, edi_message_id]);

  // Validation errors → 997 rejected
  if (validationErrors.length > 0) {
    console.log(`[EDI-Processor] 850 #${edi_message_id} REJECTED: ${validationErrors.map(e=>e.msg).join('; ')}`);
    await pool.query(`UPDATE edi_messages SET status='rejected', error_detail=$1 WHERE id=$2`,
      [validationErrors.map(e=>e.msg).join('\n'), edi_message_id]);
    await send997(partner, isa_control, gs_control, order850.st_control, false, validationErrors);
    return;
  }

  // Resolve products
  const { resolved, missing } = await resolveProducts(order850.items);
  if (missing.length > 0) {
    const errMsg = `Unknown product IDs: ${missing.join(', ')}`;
    await logError(edi_message_id, errMsg);
    await send997(partner, isa_control, gs_control, order850.st_control, false,
      [{ segment_id: 'PO1', position: 1, code: '5', msg: errMsg }]);
    return;
  }

  // Send 997 Accepted (unless partner opted out)
  if (partner.send_997 !== false) {
    await send997(partner, isa_control, gs_control, order850.st_control, true);
  } else {
    console.log(`[EDI-Processor] Partner ${partner.partner_id} has opted out of 997 — skipping`);
  }

  // Stage order via existing MQ pipeline
  const { rows } = await pool.query(
    `INSERT INTO orders
       (buyer_name, buyer_email, notes, status, channel, edi_po_number, edi_partner_id, edi_message_id,
        shipping_name, shipping_city, shipping_state, shipping_zip, shipping_country)
     VALUES ($1,$2,$3,'queued','edi',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
    [
      partner.company_name || partner.partner_id,
      partner.buyer_email || null,
      `EDI 850 | PO# ${order850.po_number} | Via ${payload.source?.toUpperCase()}`,
      order850.po_number,
      partner.partner_id,
      edi_message_id,
      order850.ship_to.name,
      order850.ship_to.city,
      order850.ship_to.state,
      order850.ship_to.zip,
      order850.ship_to.country || 'US',
    ]
  );
  const orderId = rows[0].id;

  const mqItems = resolved.map(i => ({
    product_id: i.internal_product_id,
    quantity:   i.quantity,
    negotiated_price: i.unit_price || null,
  }));

  const messageId = await publishOrder({
    staged_order_id: orderId,
    buyer_name:   partner.company_name || partner.partner_id,
    buyer_email:  partner.buyer_email || null,
    notes:        `EDI 850 PO# ${order850.po_number}`,
    items:        mqItems,
  });

  await pool.query(
    `UPDATE orders SET mq_message_id=$1 WHERE id=$2`,
    [messageId, orderId]
  );
  await pool.query(
    `UPDATE edi_messages SET status='processed', order_id=$1, processed_at=NOW() WHERE id=$2`,
    [orderId, edi_message_id]
  );

  console.log(`[EDI-Processor] ✅ 850 PO#${order850.po_number} → Order #${orderId}`);
}

// ── Process 860 (PO Change Request) ───────────────────────────
async function process860(payload) {
  const { edi_message_id, raw_edi, partner, isa_control, gs_control } = payload;

  let change860;
  try {
    const envelope = parseX12(raw_edi);
    change860 = parse860(envelope);
  } catch (err) {
    await logError(edi_message_id, `Parse error: ${err.message}`);
    await send997(partner, isa_control, gs_control, null, false, [{ segment_id: 'ISA', position:1, code:'5', msg: err.message }]);
    return;
  }

  await pool.query(`UPDATE edi_messages SET parsed_json=$1, po_number=$2 WHERE id=$3`,
    [change860, change860.po_number, edi_message_id]);

  // Find existing order by PO number
  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE edi_po_number=$1 AND edi_partner_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [change860.po_number, partner.partner_id]
  );

  if (!orders.length) {
    const errMsg = `No order found for PO# ${change860.po_number}`;
    await logError(edi_message_id, errMsg);
    await send997(partner, isa_control, gs_control, change860.st_control, false,
      [{ segment_id: 'BCH', position: 1, code: '5', msg: errMsg }]);
    return;
  }

  const order = orders[0];

  // Cannot change delivered/cancelled orders
  if (['delivered','cancelled','rejected'].includes(order.status)) {
    const errMsg = `Cannot modify order #${order.id} — status is ${order.status}`;
    await logError(edi_message_id, errMsg);
    await send997(partner, isa_control, gs_control, change860.st_control, false,
      [{ segment_id: 'BCH', position: 1, code: '5', msg: errMsg }]);
    return;
  }

  // Apply cancellations
  if (change860.cancelled_items?.length > 0) {
    await pool.query(`UPDATE orders SET status='cancelled', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
      [`Cancelled via EDI 860 by ${partner.company_name}`, order.id]);
    // Restore inventory
    const { rows: items } = await pool.query(`SELECT product_id, quantity FROM order_items WHERE order_id=$1`, [order.id]);
    for (const item of items) {
      await pool.query(`UPDATE inventory SET quantity=quantity+$1 WHERE product_id=$2`, [item.quantity, item.product_id]);
    }
    console.log(`[EDI-Processor] 860 — Order #${order.id} CANCELLED via EDI`);
  }

  // Apply modifications (quantity changes)
  if (change860.modified_items?.length > 0) {
    await pool.query(
      `UPDATE orders SET notes=CONCAT(notes, $1), updated_at=NOW() WHERE id=$2`,
      [`\nEDI 860 change: ${change860.change_reason || 'Modified'}`, order.id]
    );
    console.log(`[EDI-Processor] 860 — Order #${order.id} modification noted (full qty change in v2)`);
  }

  await pool.query(`UPDATE edi_messages SET status='processed', order_id=$1, processed_at=NOW(), related_msg_id=$2 WHERE id=$3`,
    [order.id, edi_message_id, edi_message_id]);

  await send997(partner, isa_control, gs_control, change860.st_control, true);
  console.log(`[EDI-Processor] ✅ 860 PO#${change860.po_number} processed`);
}

// ── Send 997 helper ───────────────────────────────────────────
async function send997(partner, isaControl, gsControl, stControl, accepted, errors = []) {
  const { generate997 } = require('./generator');
  const edi997 = generate997({
    sender_id:            OUR_ISA_ID,
    receiver_id:          partner.isa_id || partner.partner_id,
    original_isa_control: isaControl,
    original_gs_control:  gsControl,
    original_st_control:  stControl,
    accepted,
    errors,
  });

  await publishEDI('edi.outbound.997', {
    edi_type:         '997',
    partner_id:       partner.partner_id,
    partner:          partner,
    raw_edi:          edi997,
    accepted,
    related_isa:      isaControl,
  });
}

async function logError(messageId, detail) {
  await pool.query(`UPDATE edi_messages SET status='error', error_detail=$1 WHERE id=$2`, [detail, messageId]);
}

// ── Start consumers ───────────────────────────────────────────
async function startEDIProcessor() {
  await consumeEDI('edi_850_processing', process850);
  await consumeEDI('edi_860_processing', process860);
  console.log('[EDI-Processor] Listening for 850/860 messages');
}

module.exports = { startEDIProcessor };
