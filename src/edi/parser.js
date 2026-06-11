/**
 * X12 EDI Parser
 * Parses raw X12 EDI strings into structured JavaScript objects.
 * Supports: 850 (Purchase Order), 860 (PO Change Request)
 */

const SEGMENT_TERMINATOR  = '~';
const ELEMENT_SEPARATOR   = '*';

function parseX12(rawEdi) {
  const cleaned = rawEdi.replace(/\r\n|\r|\n/g, '').trim();
  const segments = cleaned.split(SEGMENT_TERMINATOR).map(s => s.trim()).filter(Boolean);

  const envelope = { isa: null, gs: null, transactions: [], iea: null, ge: null };

  let currentTx = null;
  let currentLoop = null;

  for (const seg of segments) {
    const els = seg.split(ELEMENT_SEPARATOR);
    const id  = els[0];

    switch (id) {
      case 'ISA':
        envelope.isa = {
          auth_info_qualifier:     els[1]?.trim(),
          auth_info:               els[2]?.trim(),
          security_info_qualifier: els[3]?.trim(),
          security_info:           els[4]?.trim(),
          sender_qualifier:        els[5]?.trim(),
          sender_id:               els[6]?.trim(),
          receiver_qualifier:      els[7]?.trim(),
          receiver_id:             els[8]?.trim(),
          interchange_date:        els[9]?.trim(),
          interchange_time:        els[10]?.trim(),
          control_standards:       els[11]?.trim(),
          version:                 els[12]?.trim(),
          control_number:          els[13]?.trim(),
          ack_requested:           els[14]?.trim(),
          usage:                   els[15]?.trim(), // P=production, T=test
        };
        break;
      case 'GS':
        envelope.gs = {
          functional_id:   els[1]?.trim(), // PO=850, PC=860
          sender_id:       els[2]?.trim(),
          receiver_id:     els[3]?.trim(),
          date:            els[4]?.trim(),
          time:            els[5]?.trim(),
          control_number:  els[6]?.trim(),
          responsible_agency: els[7]?.trim(),
          version:         els[8]?.trim(),
        };
        break;
      case 'ST':
        currentTx = {
          transaction_set: els[1]?.trim(), // 850, 860
          control_number:  els[2]?.trim(),
          segments:        [],
          raw_segments:    [seg],
        };
        envelope.transactions.push(currentTx);
        break;
      case 'SE':
        if (currentTx) {
          currentTx.segments.push({ id, segment_count: els[1], control_number: els[2]?.trim() });
          currentTx.raw_segments.push(seg);
          currentTx = null;
        }
        break;
      case 'GE': envelope.ge = { transaction_count: els[1], control_number: els[2]?.trim() }; break;
      case 'IEA': envelope.iea = { group_count: els[1], control_number: els[2]?.trim() }; break;
      default:
        if (currentTx) {
          currentTx.segments.push({ id, elements: els.slice(1), raw: seg });
          currentTx.raw_segments.push(seg);
        }
    }
  }

  return envelope;
}

// ── 850 Parser ─────────────────────────────────────────────────
function parse850(envelope) {
  const tx = envelope.transactions.find(t => t.transaction_set === '850');
  if (!tx) throw new Error('No 850 transaction set found');

  const order = {
    transaction_type: '850',
    po_number:        null,
    po_date:          null,
    purpose_code:     null, // 00=original, 01=cancellation
    ship_to:          {},
    bill_to:          {},
    items:            [],
    notes:            [],
    isa_control:      envelope.isa?.control_number,
    gs_control:       envelope.gs?.control_number,
    st_control:       tx.control_number,
    sender_id:        envelope.isa?.sender_id?.trim(),
    sender_qualifier: envelope.isa?.sender_qualifier?.trim(),
  };

  let currentN1Loop = null;
  let itemIndex = 0;

  for (const seg of tx.segments) {
    switch (seg.id) {
      case 'BEG':
        order.purpose_code = seg.elements[0]; // 00=original, 05=replace
        order.po_type_code = seg.elements[1]; // SA=standing, NE=new order
        order.po_number    = seg.elements[2];
        order.po_date      = seg.elements[4];
        break;
      case 'REF':
        if (seg.elements[0] === 'DP') order.department = seg.elements[1];
        if (seg.elements[0] === 'IA') order.account_number = seg.elements[1];
        break;
      case 'DTM':
        if (seg.elements[0] === '002') order.delivery_date = seg.elements[1];
        if (seg.elements[0] === '037') order.cancel_by_date = seg.elements[1];
        break;
      case 'N1':
        currentN1Loop = seg.elements[0]; // ST=ship-to, BT=bill-to, BY=buying party
        const party = { entity_code: seg.elements[0], name: seg.elements[1], id_code_qualifier: seg.elements[2], id_code: seg.elements[3] };
        if (currentN1Loop === 'ST') order.ship_to = { ...order.ship_to, ...party };
        if (currentN1Loop === 'BT') order.bill_to = { ...order.bill_to, ...party };
        break;
      case 'N3':
        if (currentN1Loop === 'ST') order.ship_to.street = seg.elements[0];
        if (currentN1Loop === 'BT') order.bill_to.street = seg.elements[0];
        break;
      case 'N4':
        if (currentN1Loop === 'ST') { order.ship_to.city = seg.elements[0]; order.ship_to.state = seg.elements[1]; order.ship_to.zip = seg.elements[2]; order.ship_to.country = seg.elements[3] || 'US'; }
        if (currentN1Loop === 'BT') { order.bill_to.city = seg.elements[0]; order.bill_to.state = seg.elements[1]; order.bill_to.zip = seg.elements[2]; }
        break;
      case 'PER':
        order.contact = { name: seg.elements[1], comm_qualifier: seg.elements[2], comm_number: seg.elements[3] };
        break;
      case 'PO1': {
        itemIndex++;
        const item = {
          line_number:     seg.elements[0] || String(itemIndex),
          quantity:        parseFloat(seg.elements[1]) || 0,
          unit_of_measure: seg.elements[2], // EA=each, DZ=dozen, BX=box
          unit_price:      parseFloat(seg.elements[3]) || null,
          basis_of_price:  seg.elements[4],
          product_id_qualifier: seg.elements[5],
          product_id:      seg.elements[6], // Vendor product code
          product_id_2_qualifier: seg.elements[7],
          product_id_2:    seg.elements[8], // Buyer's item number
          description:     null,
        };
        order.items.push(item);
        currentN1Loop = null; // reset N1 loop context
        break;
      }
      case 'PID':
        if (order.items.length > 0) order.items[order.items.length - 1].description = seg.elements[4];
        break;
      case 'MSG':
        order.notes.push(seg.elements[0]);
        break;
      case 'CTT':
        order.total_line_items = parseInt(seg.elements[0]);
        order.hash_total_qty   = parseFloat(seg.elements[1]) || null;
        break;
    }
  }

  return order;
}

// ── 860 Parser (PO Change Request) ────────────────────────────
function parse860(envelope) {
  const tx = envelope.transactions.find(t => t.transaction_set === '860');
  if (!tx) throw new Error('No 860 transaction set found');

  const change = {
    transaction_type: '860',
    po_number:        null,
    change_reason:    null,
    changes:          [],
    cancelled_items:  [],
    added_items:      [],
    modified_items:   [],
    isa_control:      envelope.isa?.control_number,
    sender_id:        envelope.isa?.sender_id?.trim(),
  };

  let currentItem = null;

  for (const seg of tx.segments) {
    switch (seg.id) {
      case 'BCH':
        change.purpose_code = seg.elements[0]; // 00=original, 03=change
        change.po_number    = seg.elements[2];
        change.po_date      = seg.elements[3];
        change.change_date  = seg.elements[5];
        break;
      case 'MSG':
        change.change_reason = seg.elements[0];
        break;
      case 'POC': { // PO Line Item Change
        currentItem = {
          line_number:     seg.elements[0],
          change_reason:   seg.elements[1], // AI=add, QI=qty increase, QD=qty decrease, CA=cancelled
          quantity_orig:   parseFloat(seg.elements[2]) || 0,
          quantity_new:    parseFloat(seg.elements[3]) || 0,
          unit_of_measure: seg.elements[4],
          unit_price:      parseFloat(seg.elements[5]) || null,
          product_id:      seg.elements[7],
        };
        if (currentItem.change_reason === 'CA') change.cancelled_items.push(currentItem);
        else if (currentItem.change_reason === 'AI') change.added_items.push(currentItem);
        else change.modified_items.push(currentItem);
        change.changes.push(currentItem);
        break;
      }
    }
  }

  return change;
}

function detectTransactionType(rawEdi) {
  if (rawEdi.includes('*850*')) return '850';
  if (rawEdi.includes('*860*')) return '860';
  return 'unknown';
}

module.exports = { parseX12, parse850, parse860, detectTransactionType };
