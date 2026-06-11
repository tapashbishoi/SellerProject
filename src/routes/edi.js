/**
 * EDI HTTP Routes
 * POST /edi/receive   — plain HTTPS (raw X12 in body)
 * POST /edi/as2       — AS2 transport (X12 in MIME body, AS2 headers)
 * GET  /edi/partners  — list trading partners
 * POST /edi/partners  — register/update trading partner
 * GET  /edi/messages  — EDI transaction log
 * GET  /edi/status/:isa_control — check status by ISA control number
 */
const express      = require('express');
const router       = express.Router();
const pool         = require('../db');
const { receiveEDI, OUR_ISA_ID, OUR_AS2_ID } = require('../edi/receiver');

// ── Middleware: accept raw X12 body ───────────────────────────
router.use(express.text({ type: ['application/edi-x12', 'text/plain', '*/*'], limit: '5mb' }));

// ── POST /edi/receive — plain HTTPS inbound ───────────────────
router.post('/receive', async (req, res) => {
  const rawEdi = req.body;
  if (!rawEdi || typeof rawEdi !== 'string' || !rawEdi.includes('ISA'))
    return res.status(400).json({ error: 'Invalid EDI: expected raw X12 in request body' });

  try {
    const result = await receiveEDI(rawEdi, 'https');
    res.status(202).json({
      message:          'EDI received and queued for processing',
      edi_message_id:   result.edi_message_id,
      transaction_type: result.transaction_type,
      isa_control:      result.isa_control,
      partner_id:       result.partner_id,
      status:           'queued',
      info:             `997 Functional Acknowledgment will be sent to your registered callback URL. Poll GET /edi/status/${result.isa_control} for updates.`,
    });
  } catch (err) {
    if (err.message.startsWith('DUPLICATE:'))
      return res.status(409).json({ error: err.message });
    res.status(422).json({ error: err.message });
  }
});

// ── POST /edi/as2 — AS2 transport ─────────────────────────────
router.post('/as2', async (req, res) => {
  const as2From    = req.headers['as2-from'];
  const as2To      = req.headers['as2-to'];
  const messageId  = req.headers['message-id'];
  const mdnOptions = req.headers['disposition-notification-options'];

  // Basic AS2 header validation
  if (!as2From || !as2To)
    return res.status(400).json({ error: 'Missing AS2-From or AS2-To headers' });
  if (as2To?.trim() !== OUR_AS2_ID && as2To?.trim() !== OUR_ISA_ID)
    return res.status(400).json({ error: `AS2-To "${as2To}" does not match our AS2 ID "${OUR_AS2_ID}"` });

  const rawEdi = req.body;
  if (!rawEdi || typeof rawEdi !== 'string' || !rawEdi.includes('ISA'))
    return res.status(400).json({ error: 'Invalid EDI payload in AS2 message' });

  let result;
  try {
    result = await receiveEDI(rawEdi, 'as2', as2From);
  } catch (err) {
    // Return AS2 MDN with failure
    return res.status(200)
      .set({
        'AS2-From':    OUR_AS2_ID,
        'AS2-To':      as2From,
        'Message-ID':  `<mdn-${Date.now()}@selleragent>`,
        'Original-Message-ID': messageId,
        'Content-Type': 'multipart/report; report-type=disposition-notification',
      })
      .send(buildMDN(as2From, messageId, 'failed/failure', err.message));
  }

  // Synchronous MDN — acknowledge AS2 receipt
  res.status(200)
    .set({
      'AS2-From':    OUR_AS2_ID,
      'AS2-To':      as2From,
      'Message-ID':  `<mdn-${Date.now()}@selleragent>`,
      'Original-Message-ID': messageId,
      'Content-Type': 'message/disposition-notification',
    })
    .send(buildMDN(as2From, messageId, 'processed/success', null, result));
});

function buildMDN(recipient, originalMsgId, disposition, error = null, result = null) {
  return [
    `Reporting-UA: SellerAgent/2.0`,
    `Original-Recipient: rfc822; ${OUR_AS2_ID}`,
    `Final-Recipient: rfc822; ${OUR_AS2_ID}`,
    `Original-Message-ID: ${originalMsgId || ''}`,
    `Disposition: automatic-action/MDN-sent-automatically; ${disposition}`,
    error ? `Error: ${error}` : '',
    result ? `X-EDI-Message-ID: ${result.edi_message_id}` : '',
    result ? `X-Transaction-Type: ${result.transaction_type}` : '',
  ].filter(Boolean).join('\r\n');
}

// ── GET /edi/status/:isa_control ──────────────────────────────
router.get('/status/:isa_control', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.*, o.status AS order_status, o.id AS order_id,
      (SELECT json_agg(json_build_object('type', r.transaction_set, 'status', r.status, 'created_at', r.created_at))
       FROM edi_messages r WHERE r.direction='outbound' AND (r.related_msg_id=m.id OR r.order_id=o.id)
      ) AS responses
    FROM edi_messages m
    LEFT JOIN orders o ON o.id = m.order_id
    WHERE m.isa_control_no=$1 AND m.direction='inbound'
    ORDER BY m.created_at DESC LIMIT 1
  `, [req.params.isa_control]);
  if (!rows.length) return res.status(404).json({ error: 'ISA control number not found' });
  res.json(rows[0]);
});

// ── GET /edi/messages — transaction log ───────────────────────
router.get('/messages', async (req, res) => {
  const { direction, transaction_set, partner_id, limit = 50 } = req.query;
  let query = `
    SELECT m.*, o.status AS order_status
    FROM edi_messages m
    LEFT JOIN orders o ON o.id = m.order_id
    WHERE 1=1
  `;
  const params = [];
  if (direction)       { params.push(direction);       query += ` AND m.direction=$${params.length}`; }
  if (transaction_set) { params.push(transaction_set); query += ` AND m.transaction_set=$${params.length}`; }
  if (partner_id)      { params.push(partner_id);      query += ` AND m.partner_id=$${params.length}`; }
  params.push(limit);
  query += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// ── GET/POST /edi/partners — trading partner management ───────
router.get('/partners', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM edi_trading_partners ORDER BY company_name`);
  res.json(rows);
});

router.post('/partners', async (req, res) => {
  const {
    partner_id, company_name, buyer_email, isa_qualifier = 'ZZ', isa_id, gs_id,
    as2_id, callback_url, edi_version = '00501', notes,
    send_997 = true, send_855 = true, send_856 = true, send_810 = false,
    expects_ack = false, ack_timeout_hours = 24,
  } = req.body;
  if (!partner_id || !company_name || !isa_id || !gs_id)
    return res.status(400).json({ error: 'partner_id, company_name, isa_id and gs_id are required' });

  const { rows } = await pool.query(`
    INSERT INTO edi_trading_partners
      (partner_id, company_name, buyer_email, isa_qualifier, isa_id, gs_id, as2_id,
       callback_url, edi_version, notes, send_997, send_855, send_856, send_810, expects_ack, ack_timeout_hours)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (partner_id) DO UPDATE SET
      company_name=$2, buyer_email=$3, isa_qualifier=$4, isa_id=$5, gs_id=$6,
      as2_id=$7, callback_url=$8, edi_version=$9, notes=$10,
      send_997=$11, send_855=$12, send_856=$13, send_810=$14,
      expects_ack=$15, ack_timeout_hours=$16, updated_at=NOW()
    RETURNING *
  `, [partner_id, company_name, buyer_email, isa_qualifier, isa_id, gs_id, as2_id,
      callback_url, edi_version, notes, send_997, send_855, send_856, send_810, expects_ack, ack_timeout_hours]);
  res.status(201).json(rows[0]);
});

// PATCH /edi/partners/:id/preferences — update delivery preferences only
router.patch('/partners/:id/preferences', async (req, res) => {
  const { callback_url, send_997, send_855, send_856, send_810, expects_ack, ack_timeout_hours } = req.body;
  const { rows } = await pool.query(`
    UPDATE edi_trading_partners SET
      callback_url      = COALESCE($1, callback_url),
      send_997          = COALESCE($2, send_997),
      send_855          = COALESCE($3, send_855),
      send_856          = COALESCE($4, send_856),
      send_810          = COALESCE($5, send_810),
      expects_ack       = COALESCE($6, expects_ack),
      ack_timeout_hours = COALESCE($7, ack_timeout_hours),
      updated_at        = NOW()
    WHERE partner_id = $8
    RETURNING *
  `, [callback_url, send_997, send_855, send_856, send_810, expects_ack, ack_timeout_hours, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Partner not found' });
  res.json(rows[0]);
});

// GET /edi/ack-pending — outbound messages awaiting buyer 997
router.get('/ack-pending', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT m.*, p.company_name, p.ack_timeout_hours,
      EXTRACT(EPOCH FROM (NOW() - m.created_at))/3600 AS hours_since_sent,
      CASE WHEN EXTRACT(EPOCH FROM (NOW() - m.created_at))/3600 > p.ack_timeout_hours
           THEN true ELSE false END AS overdue
    FROM edi_messages m
    JOIN edi_trading_partners p ON p.partner_id = m.partner_id
    WHERE m.direction = 'outbound'
      AND m.ack_required = true
      AND m.ack_received_at IS NULL
      AND m.status NOT IN ('failed')
    ORDER BY m.created_at ASC
  `);
  res.json(rows);
});

// ── GET /edi/info — buyer guide for EDI setup ─────────────────
router.get('/info', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    our_isa_id:    OUR_ISA_ID,
    our_as2_id:    OUR_AS2_ID,
    edi_version:   '00501',
    endpoints: {
      https:  `${base}/edi/receive`,
      as2:    `${base}/edi/as2`,
    },
    supported_transactions: {
      inbound:  ['850 (Purchase Order)', '860 (PO Change Request)'],
      outbound: ['997 (Functional Ack)', '855 (PO Acknowledgment)', '856 (Ship Notice)', '810 (Invoice)'],
    },
    required_850_segments: {
      ISA: 'Interchange envelope — use our ISA ID as receiver',
      BEG: 'BEG02=SA (standing), BEG03=your PO number, BEG05=date (YYYYMMDD)',
      'N1*ST': 'Ship-to party with N3 (street) and N4 (city/state/zip)',
      PO1: 'One per line item: PO101=line#, PO102=qty, PO103=EA, PO104=price, PO106=VP, PO107=our_product_id',
      CTT: 'Total line item count',
      SE:  'Transaction trailer with segment count',
    },
    product_id_lookup: `${base}/api/products`,
    workflow: {
      '1_send_850':  `POST ${base}/edi/receive  or  POST ${base}/edi/as2`,
      '2_receive_997': 'Sent to your callback_url immediately on receipt',
      '3_receive_855': 'Sent when order is confirmed (status=confirmed)',
      '4_receive_856': 'Sent when order is shipped (status=shipped)',
      '5_receive_810': 'Sent when order is delivered (status=delivered)',
      '6_send_860':  `POST ${base}/edi/receive with EDI 860 to modify/cancel order`,
    },
  });
});

module.exports = router;
