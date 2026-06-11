/**
 * EDI Receiver — transport-agnostic inbound handler
 * Called by both AS2 and HTTPS routes.
 * Protocol abstraction layer: normalise → store → publish to MQ
 * Future: SFTP poller would call receiveEDI() after reading file.
 */
require('dotenv').config();
const pool       = require('../db');
const { parseX12, detectTransactionType } = require('./parser');
const { publishEDI }                       = require('./mq');

const OUR_ISA_ID   = process.env.EDI_ISA_ID   || 'SELLERAGENT';
const OUR_AS2_ID   = process.env.EDI_AS2_ID   || 'SELLERAGENT-AS2';

/**
 * receiveEDI — called by any inbound channel (HTTPS, AS2, future SFTP)
 * @param rawEdi   Raw X12 string
 * @param source   'https' | 'as2' | 'sftp'
 * @param partnerId optional: override partner lookup
 * @returns { edi_message_id, transaction_type, po_number, isa_control }
 */
async function receiveEDI(rawEdi, source = 'https', partnerId = null) {
  // 1. Detect transaction type
  const txType = detectTransactionType(rawEdi);
  if (!['850','860'].includes(txType))
    throw new Error(`Unsupported EDI transaction type: ${txType || 'unknown'}. Supported: 850, 860`);

  // 2. Parse envelope (ISA/GS only — don't parse full detail yet, that's the processor's job)
  let envelope, isaControl, senderId, poNumber;
  try {
    envelope   = parseX12(rawEdi);
    isaControl = envelope.isa?.control_number;
    senderId   = envelope.isa?.sender_id?.trim();
  } catch (err) {
    throw new Error(`EDI parse error: ${err.message}`);
  }

  // 3. Duplicate detection — same ISA control number from same partner
  if (isaControl) {
    const { rows } = await pool.query(
      `SELECT id FROM edi_messages WHERE isa_control_no=$1 AND partner_id=$2 AND direction='inbound'`,
      [isaControl, partnerId || senderId]
    );
    if (rows.length > 0) {
      throw new Error(`DUPLICATE: ISA control number ${isaControl} already received from partner ${partnerId || senderId}`);
    }
  }

  // 4. Look up trading partner
  const { rows: partners } = await pool.query(
    `SELECT * FROM edi_trading_partners WHERE (isa_id=$1 OR partner_id=$2) AND is_active=true LIMIT 1`,
    [senderId, partnerId || senderId]
  );
  const partner = partners[0];

  // 5. Store raw EDI in edi_messages
  const { rows: msgRows } = await pool.query(
    `INSERT INTO edi_messages
       (direction, transaction_set, isa_control_no, gs_control_no, partner_id, raw_edi, status)
     VALUES ('inbound',$1,$2,$3,$4,$5,'received') RETURNING id`,
    [txType, isaControl, envelope.gs?.control_number, partner?.partner_id || senderId, rawEdi]
  );
  const messageId = msgRows[0].id;

  // 6. Publish to RabbitMQ topic based on transaction type
  await publishEDI(`edi.inbound.${txType}`, {
    edi_message_id: messageId,
    transaction_type: txType,
    raw_edi:        rawEdi,
    partner_id:     partner?.partner_id || senderId,
    partner:        partner || { isa_id: senderId, gs_id: senderId, company_name: senderId },
    source,
    isa_control:    isaControl,
    gs_control:     envelope.gs?.control_number,
  });

  console.log(`[EDI-Receiver] ${txType} from ${senderId} → message #${messageId} → edi.inbound.${txType}`);

  return {
    edi_message_id:   messageId,
    transaction_type: txType,
    isa_control:      isaControl,
    partner_id:       partner?.partner_id || senderId,
    status:           'received',
  };
}

module.exports = { receiveEDI, OUR_ISA_ID, OUR_AS2_ID };
