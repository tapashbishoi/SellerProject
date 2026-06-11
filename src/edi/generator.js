/**
 * X12 EDI Generator
 * Generates outbound EDI: 997, 855, 856
 */

const { v4: uuidv4 } = require('uuid');
const SEP = '*';
const TERM = '~\n';

// Pad string to fixed length
const pad = (str, len) => String(str || '').padEnd(len, ' ').substring(0, len);

// Current date/time in EDI format
function ediDate()     { const d = new Date(); return d.toISOString().slice(0,10).replace(/-/g,''); }
function ediTime()     { const d = new Date(); return d.toTimeString().slice(0,5).replace(':',''); }
function controlNum()  { return String(Math.floor(Math.random() * 999999999)).padStart(9, '0'); }
function stControl()   { return String(Math.floor(Math.random() * 9999)).padStart(4, '0'); }

function buildEnvelope(senderId, receiverId, content, functionalId, version = '00501') {
  const isaCtrl = controlNum();
  const gsCtrl  = controlNum().slice(0,9);
  const segCount = content.trim().split('~').filter(s => s.trim()).length;

  return [
    `ISA${SEP}00${SEP}${pad('',10)}${SEP}00${SEP}${pad('',10)}${SEP}ZZ${SEP}${pad(senderId,15)}${SEP}ZZ${SEP}${pad(receiverId,15)}${SEP}${ediDate()}${SEP}${ediTime()}${SEP}^${SEP}${version}${SEP}${isaCtrl}${SEP}0${SEP}P${SEP}:${TERM}`,
    `GS${SEP}${functionalId}${SEP}${senderId.trim()}${SEP}${receiverId.trim()}${SEP}${ediDate()}${SEP}${ediTime()}${SEP}${gsCtrl}${SEP}X${SEP}${version === '00501' ? '005010' : '004010'}${TERM}`,
    content,
    `GE${SEP}1${SEP}${gsCtrl}${TERM}`,
    `IEA${SEP}1${SEP}${isaCtrl}${TERM}`,
  ].join('');
}

// ── 997 Functional Acknowledgment ─────────────────────────────
function generate997({ sender_id, receiver_id, original_isa_control, original_gs_control, original_st_control, accepted = true, errors = [] }) {
  const stCtrl = stControl();
  const ak5    = accepted && errors.length === 0 ? 'A' : errors.length > 0 ? 'E' : 'R';
  const ak9    = accepted ? 'A' : 'R';

  let body = '';
  body += `ST${SEP}997${SEP}${stCtrl}${TERM}`;
  body += `AK1${SEP}PO${SEP}${original_gs_control}${TERM}`;  // PO = 850 functional group
  body += `AK2${SEP}850${SEP}${original_st_control}${TERM}`; // reference to 850 ST
  if (errors.length > 0) {
    errors.forEach(err => {
      body += `AK3${SEP}${err.segment_id}${SEP}${err.position}${SEP}${SEP}${err.code}${TERM}`;
      if (err.element_errors) {
        err.element_errors.forEach(ee => {
          body += `AK4${SEP}${ee.position}${SEP}${SEP}${ee.code}${TERM}`;
        });
      }
    });
  }
  body += `AK5${SEP}${ak5}${TERM}`; // A=Accepted, R=Rejected, E=Accepted with errors
  body += `AK9${SEP}${ak9}${SEP}1${SEP}1${SEP}${accepted ? 1 : 0}${TERM}`;
  body += `SE${SEP}${body.split('~').filter(s => s.trim()).length + 1}${SEP}${stCtrl}${TERM}`;

  return buildEnvelope(sender_id, receiver_id, body, 'FA'); // FA = functional ack
}

// ── 855 Purchase Order Acknowledgment ─────────────────────────
function generate855({ sender_id, receiver_id, po_number, po_date, order_id, status, items, ship_to, accepted = true, notes = '' }) {
  const stCtrl  = stControl();
  const bakCode = accepted ? 'AC' : 'RD'; // AC=accepted, RD=rejected, AD=accepted with detail changes

  let body = '';
  body += `ST${SEP}855${SEP}${stCtrl}${TERM}`;
  body += `BAK${SEP}00${SEP}${bakCode}${SEP}${po_number}${SEP}${ediDate()}${SEP}${SEP}${SEP}${SEP}${SEP}${order_id}${TERM}`;
  body += `REF${SEP}CO${SEP}${order_id}${TERM}`; // our internal order number
  body += `DTM${SEP}004${SEP}${ediDate()}${TERM}`; // shipment date estimate

  if (ship_to?.state) {
    body += `N1${SEP}ST${SEP}${ship_to.name || ''}${SEP}92${SEP}${order_id}${TERM}`;
    if (ship_to.street) body += `N3${SEP}${ship_to.street}${TERM}`;
    body += `N4${SEP}${ship_to.city || ''}${SEP}${ship_to.state || ''}${SEP}${ship_to.zip || ''}${SEP}US${TERM}`;
  }

  // Line items
  let lineSegCount = 0;
  (items || []).forEach((item, idx) => {
    body += `PO1${SEP}${idx + 1}${SEP}${item.quantity}${SEP}EA${SEP}${parseFloat(item.unit_price).toFixed(2)}${SEP}PE${SEP}VP${SEP}${item.product_id}${TERM}`;
    body += `ACK${SEP}IA${SEP}${item.quantity}${SEP}EA${SEP}${ediDate()}${TERM}`; // IA=item accepted
    lineSegCount += 2;
  });

  if (notes) body += `MSG${SEP}${notes.substring(0, 264)}${TERM}`;
  const segCount = body.split('~').filter(s => s.trim()).length;
  body += `CTT${SEP}${(items || []).length}${TERM}`;
  body += `SE${SEP}${segCount + 2}${SEP}${stCtrl}${TERM}`;

  return buildEnvelope(sender_id, receiver_id, body, 'PR'); // PR = purchase order acknowledgment
}

// ── 856 Ship Notice / ASN ─────────────────────────────────────
function generate856({ sender_id, receiver_id, po_number, order_id, items, ship_from_dc, ship_to, tracking_number = null, carrier = 'UPSG', ship_date = null }) {
  const stCtrl   = stControl();
  const shipDate = ship_date || ediDate();

  let body = '';
  body += `ST${SEP}856${SEP}${stCtrl}${TERM}`;
  body += `BSN${SEP}00${SEP}${order_id}${SEP}${shipDate}${SEP}${ediTime()}${SEP}0001${TERM}`; // BSN = ship notice header
  body += `DTM${SEP}011${SEP}${shipDate}${TERM}`; // ship date

  // Shipment HL loop
  body += `HL${SEP}1${SEP}${SEP}S${TERM}`; // S = shipment level
  body += `TD1${SEP}CTN${SEP}1${SEP}${SEP}${SEP}${SEP}G${SEP}${(items || []).reduce((s,i) => s + i.quantity, 0)}${TERM}`; // carton count
  body += `TD5${SEP}B${SEP}2${SEP}${carrier}${SEP}${SEP}${tracking_number || 'PENDING'}${TERM}`; // carrier info
  body += `REF${SEP}BM${SEP}${order_id}${TERM}`; // bill of lading

  // Ship from (DC)
  body += `N1${SEP}SF${SEP}${ship_from_dc?.name || 'Distribution Center'}${SEP}92${SEP}${ship_from_dc?.dc_code || 'DC'}${TERM}`;
  body += `N3${SEP}${ship_from_dc?.address || ''}${TERM}`;
  body += `N4${SEP}${ship_from_dc?.city || ''}${SEP}${ship_from_dc?.state || ''}${SEP}${ship_from_dc?.zip || ''}${SEP}US${TERM}`;

  // Ship to
  if (ship_to) {
    body += `N1${SEP}ST${SEP}${ship_to.name || ''}${SEP}92${SEP}BUYER${TERM}`;
    if (ship_to.street) body += `N3${SEP}${ship_to.street}${TERM}`;
    body += `N4${SEP}${ship_to.city || ''}${SEP}${ship_to.state || ''}${SEP}${ship_to.zip || ''}${SEP}US${TERM}`;
  }

  // Order HL loop
  body += `HL${SEP}2${SEP}1${SEP}O${TERM}`; // O = order level
  body += `PRF${SEP}${po_number}${TERM}`; // PO reference

  // Item HL loops
  (items || []).forEach((item, idx) => {
    body += `HL${SEP}${idx + 3}${SEP}2${SEP}I${TERM}`; // I = item level
    body += `LIN${SEP}${idx + 1}${SEP}VP${SEP}${item.product_id}${SEP}VN${SEP}${item.product_name || item.product_id}${TERM}`;
    body += `SN1${SEP}${SEP}${item.quantity}${SEP}EA${TERM}`; // shipped qty
  });

  const segCount = body.split('~').filter(s => s.trim()).length;
  body += `CTT${SEP}${(items || []).length}${TERM}`;
  body += `SE${SEP}${segCount + 2}${SEP}${stCtrl}${TERM}`;

  return buildEnvelope(sender_id, receiver_id, body, 'SH'); // SH = ship notice
}

// ── 810 Invoice ───────────────────────────────────────────────
function generate810({ sender_id, receiver_id, po_number, order_id, invoice_number, items, ship_to, total_amount }) {
  const stCtrl = stControl();

  let body = '';
  body += `ST${SEP}810${SEP}${stCtrl}${TERM}`;
  body += `BIG${SEP}${ediDate()}${SEP}${invoice_number}${SEP}${ediDate()}${SEP}${po_number}${TERM}`;
  body += `REF${SEP}CO${SEP}${order_id}${TERM}`;
  body += `DTM${SEP}003${SEP}${ediDate()}${TERM}`; // invoice date

  if (ship_to?.state) {
    body += `N1${SEP}ST${SEP}${ship_to.name || ''}${SEP}92${SEP}BUYER${TERM}`;
    body += `N4${SEP}${ship_to.city || ''}${SEP}${ship_to.state || ''}${SEP}${ship_to.zip || ''}${SEP}US${TERM}`;
  }

  (items || []).forEach((item, idx) => {
    const subtotal = (item.quantity * item.unit_price).toFixed(2);
    body += `IT1${SEP}${idx + 1}${SEP}${item.quantity}${SEP}EA${SEP}${parseFloat(item.unit_price).toFixed(2)}${SEP}PE${SEP}VP${SEP}${item.product_id}${TERM}`;
    body += `TXI${SEP}TX${SEP}${subtotal}${TERM}`;
  });

  body += `TDS${SEP}${Math.round(parseFloat(total_amount || 0) * 100)}${TERM}`; // total in cents
  const segCount = body.split('~').filter(s => s.trim()).length;
  body += `CTT${SEP}${(items || []).length}${TERM}`;
  body += `SE${SEP}${segCount + 2}${SEP}${stCtrl}${TERM}`;

  return buildEnvelope(sender_id, receiver_id, body, 'IN'); // IN = invoice
}

module.exports = { generate997, generate855, generate856, generate810 };
