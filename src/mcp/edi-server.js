/**
 * EDI MCP Server — mounted at /edi-mcp on the main Express app.
 *
 * STRICTLY for EDI trading partners. No JSON orders, no catalogue browsing.
 * All orders MUST come through EDI 850. We respond with 997/855/856/810.
 *
 * Tools:
 *  1. get_edi_setup          — our ISA IDs, endpoints, product ID reference
 *  2. register_trading_partner — onboard as EDI partner (one-time)
 *  3. configure_delivery      — set callback URL and document preferences
 *  4. send_850               — submit Purchase Order (raw X12 or structured JSON)
 *  5. send_860               — submit PO Change / Cancellation
 *  6. send_997               — send 997 Functional Ack for our outbound docs
 *  7. get_edi_status         — track inbound 850/860 and all responses
 *  8. get_outbound_documents — poll pending 855/856/810 we sent you
 */
const path = require('path');
const mcpServerDir = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/cjs/server');
const { McpServer }                     = require(path.join(mcpServerDir, 'mcp.js'));
const { StreamableHTTPServerTransport } = require(path.join(mcpServerDir, 'streamableHttp.js'));
const z    = require('zod');
const pool = require('../db');
const { receiveEDI, OUR_ISA_ID, OUR_AS2_ID } = require('../edi/receiver');

// ── X12 builder helpers ───────────────────────────────────────

function ediDate() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function ediTime() { return new Date().toTimeString().slice(0,5).replace(':',''); }
function ctrl9()   { return String(Math.floor(Math.random()*999999999)).padStart(9,'0'); }

/**
 * Build a minimal valid X12 850 from structured input.
 */
function buildX12_850({ partner_id, isa_id, po_number, items, productMap,
                        shipping_name, shipping_street, shipping_city, shipping_state, shipping_zip }) {
  const senderId = (isa_id || partner_id || 'BUYER').padEnd(15).substring(0,15);
  const ourId    = OUR_ISA_ID.padEnd(15).substring(0,15);
  const date     = ediDate();
  const time     = ediTime();
  const isaCtrl  = ctrl9();

  let x12 = '';
  x12 += `ISA*00*          *00*          *ZZ*${senderId}*ZZ*${ourId}*${date.slice(2)}*${time}*^*00501*${isaCtrl}*0*P*:\n`;
  x12 += `GS*PO*${(isa_id||partner_id).trim()}*${OUR_ISA_ID}*${date}*${time}*1*X*005010\n`;
  x12 += `ST*850*0001\n`;
  x12 += `BEG*00*SA*${po_number}**${date}\n`;

  if (shipping_city || shipping_state) {
    x12 += `N1*ST*${shipping_name||''}*92*BUYER\n`;
    if (shipping_street) x12 += `N3*${shipping_street}\n`;
    x12 += `N4*${shipping_city||''}*${shipping_state||''}*${shipping_zip||''}*US\n`;
  }

  items.forEach((item, i) => {
    const p     = productMap[item.product_id];
    const price = item.unit_price ?? (p?.price ? parseFloat(p.price) : 0);
    x12 += `PO1*${i+1}*${item.quantity}*EA*${price.toFixed(2)}*PE*VP*${item.product_id}\n`;
  });

  const shipSegments = (shipping_city || shipping_state) ? 3 + (shipping_street ? 1 : 0) : 0;
  const segCount = 4 + shipSegments + items.length;
  x12 += `CTT*${items.length}\n`;
  x12 += `SE*${segCount + 2}*0001\n`;
  x12 += `GE*1*1\n`;
  x12 += `IEA*1*${isaCtrl}\n`;

  // Replace \n with ~ (X12 segment terminator) keeping newlines for readability
  return x12.replace(/\n/g, '~\n');
}

/**
 * Build a minimal X12 860 (PO Change) from structured input.
 */
function buildX12_860({ partner_id, isa_id, original_po_number, change_type, items, productMap }) {
  const senderId = (isa_id || partner_id || 'BUYER').padEnd(15).substring(0,15);
  const ourId    = OUR_ISA_ID.padEnd(15).substring(0,15);
  const date     = ediDate();
  const time     = ediTime();
  const isaCtrl  = ctrl9();
  // change_type: '00'=cancel, '01'=quantity change, '02'=price change
  const pcdCode  = change_type === 'cancel' ? '01' : '04'; // 01=cancel, 04=change

  let x12 = '';
  x12 += `ISA*00*          *00*          *ZZ*${senderId}*ZZ*${ourId}*${date.slice(2)}*${time}*^*00501*${isaCtrl}*0*P*:\n`;
  x12 += `GS*PC*${(isa_id||partner_id).trim()}*${OUR_ISA_ID}*${date}*${time}*1*X*005010\n`;
  x12 += `ST*860*0001\n`;
  x12 += `BCH*00*${pcdCode}*${original_po_number}**${date}\n`;

  (items||[]).forEach((item, i) => {
    const p     = productMap[item.product_id] || {};
    const price = item.unit_price ?? (p.price ? parseFloat(p.price) : 0);
    x12 += `PO1*${i+1}*${item.quantity}*EA*${price.toFixed(2)}*PE*VP*${item.product_id}\n`;
    x12 += `POC*${i+1}*${change_type==='cancel'?'CA':'QP'}*${item.quantity}*${item.quantity}*EA**VP*${item.product_id}\n`;
  });

  const segCount = 3 + (items||[]).length * 2;
  x12 += `CTT*${(items||[]).length}\n`;
  x12 += `SE*${segCount + 2}*0001\n`;
  x12 += `GE*1*1\n`;
  x12 += `IEA*1*${isaCtrl}\n`;

  return x12.replace(/\n/g, '~\n');
}

// ── MCP Server factory ────────────────────────────────────────

function createEdiMcpServer() {
  const server = new McpServer({
    name:    'seller-edi-agent',
    version: '2.0.0',
  });

  // ── Tool 1: get_edi_setup ─────────────────────────────────────
  server.tool(
    'get_edi_setup',
    'Get complete EDI setup guide: our ISA/GS IDs, HTTPS and AS2 endpoints, required 850 segments, product IDs, and the full O2C EDI flow (850→997→855→856→810). Start here.',
    {},
    async () => {
      const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const { rows: products } = await pool.query(
        `SELECT p.id, p.name, p.category, p.price, i.quantity
         FROM products p JOIN inventory i ON i.product_id=p.id
         ORDER BY p.category, p.name`
      );
      const productLines = products.map(p =>
        `  VP*${p.id} → "${p.name}" (${p.category}) @ $${parseFloat(p.price).toFixed(2)} | stock: ${p.quantity}`
      ).join('\n');

      return { content: [{ type: 'text', text: `📋 EDI Trading Partner Setup — SellerAgent
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 Our EDI Identity
  ISA Receiver ID : ${OUR_ISA_ID}   (qualifier: ZZ)
  AS2 ID          : ${OUR_AS2_ID}
  EDI Standard    : X12 005010 (00501)
  Segment term    : ~   (tilde)
  Element sep     : *   (asterisk)
  Sub-element sep : :

📨 Inbound Endpoints (you send to us)
  HTTPS : POST ${base}/edi/receive
          Header: Content-Type: application/edi-x12
  AS2   : POST ${base}/edi/as2
          Headers: AS2-From, AS2-To (must equal ${OUR_AS2_ID})

📤 Outbound (we send to your callback_url)
  997 Functional Ack   → immediately on receipt
  855 PO Ack           → when order confirmed (~2-5 sec)
  856 Ship Notice      → when seller marks "shipped"
  810 Invoice          → when seller marks "delivered"

📦 Required 850 Segments
  ISA : ISA06=your ISA ID, ISA08=${OUR_ISA_ID}, ISA12=00501
  BEG : BEG01=00, BEG02=SA, BEG03=<your-PO#>, BEG05=YYYYMMDD
  N1*ST : Ship-to name / N3 street / N4 city*state*zip*US
  PO1 : PO102=qty, PO103=EA, PO104=unit_price, PO106=VP, PO107=<product_id>
  CTT : total PO1 line count
  SE/GE/IEA : standard trailers

🔑 Product Catalogue (use product_id in PO107 with PO106=VP)
${productLines}

🔄 EDI O2C Workflow
  Step 1 : send_850()               → 850 Purchase Order
  Step 2 : receive 997 at callback  ← Functional Acknowledgment
  Step 3 : receive 855 at callback  ← PO Accepted / Confirmed
  Step 4 : receive 856 at callback  ← Ship Notice (when shipped)
  Step 5 : receive 810 at callback  ← Invoice (when delivered)
  Optional: send_860()              → PO Change or Cancel
  Optional: send_997()              → Ack our 855/856/810

⚡ Getting Started
  1. Call register_trading_partner() once
  2. Call configure_delivery() to set callback URL
  3. Call send_850() to place your first order
  4. Call get_edi_status(isa_control) to track responses` }] };
    }
  );

  // ── Tool 2: register_trading_partner ─────────────────────────
  server.tool(
    'register_trading_partner',
    'One-time registration as an EDI trading partner. Required before sending 850/860. Provide your ISA ID, company info, and optional callback URL.',
    {
      partner_id:   z.string().min(2).max(30).describe('Your unique partner identifier (e.g. ACMECORP)'),
      company_name: z.string().min(2).describe('Your company legal name'),
      isa_id:       z.string().min(2).max(15).describe('Your ISA Sender ID (ISA06 in your X12 envelope)'),
      gs_id:        z.string().min(2).max(15).describe('Your GS Application Sender ID (GS02)'),
      as2_id:       z.string().optional().describe('Your AS2 ID (if using AS2 transport)'),
      buyer_email:  z.string().email().optional().describe('Contact email for this trading relationship'),
      callback_url: z.string().url().optional().describe('HTTPS endpoint where we POST 997/855/856/810 (can set later via configure_delivery)'),
      wants_855:    z.boolean().default(true).describe('Receive 855 PO Acknowledgment? Default: true'),
      wants_856:    z.boolean().default(true).describe('Receive 856 Ship Notice? Default: true'),
      wants_810:    z.boolean().default(false).describe('Receive 810 Invoice? Default: false'),
    },
    async ({ partner_id, company_name, isa_id, gs_id, as2_id, buyer_email, callback_url, wants_855, wants_856, wants_810 }) => {
      const base   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const apiKey = (process.env.API_KEYS || '').split(',')[0];

      const res = await fetch(`${base}/edi/partners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          partner_id, company_name, isa_id, gs_id, as2_id, buyer_email, callback_url,
          send_997: true, send_855: wants_855, send_856: wants_856, send_810: wants_810,
        }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: 'text', text: `❌ Registration failed: ${data.error}` }] };

      return { content: [{ type: 'text', text: `✅ Trading Partner Registered!
━━━━━━━━━━━━━━━━━━━━━━━━━
Partner ID   : ${data.partner_id}
Company      : ${data.company_name}
ISA ID       : ${data.isa_id}
GS ID        : ${data.gs_id}
Callback URL : ${data.callback_url || '⚠️  Not set — call configure_delivery()'}
Receives 997 : ✅ Always
Receives 855 : ${wants_855 ? '✅' : '❌'}
Receives 856 : ${wants_856 ? '✅' : '❌'}
Receives 810 : ${wants_810 ? '✅' : '❌'}

${!callback_url ? '⚠️  Set your callback URL with configure_delivery() before sending 850s.\n' : ''}Next: call send_850() to place your first EDI purchase order.` }] };
    }
  );

  // ── Tool 3: configure_delivery ────────────────────────────────
  server.tool(
    'configure_delivery',
    'Set or update your EDI callback URL and choose which outbound documents to receive (855/856/810). Also configure whether you will send 997 acks back for our outbound docs.',
    {
      partner_id:         z.string().describe('Your registered partner ID'),
      callback_url:       z.string().url().describe('Your HTTPS endpoint — we POST raw X12 here with header Content-Type: application/edi-x12'),
      wants_855:          z.boolean().default(true).describe('Receive 855 PO Acknowledgment when order is confirmed'),
      wants_856:          z.boolean().default(true).describe('Receive 856 Ship Notice when order ships'),
      wants_810:          z.boolean().default(false).describe('Receive 810 Invoice when order is delivered'),
      will_send_997_back: z.boolean().default(false).describe('Set true if you will send 997 acks for each document we send you'),
      ack_timeout_hours:  z.number().int().positive().default(24).describe('Hours before we flag unacknowledged docs as overdue'),
    },
    async ({ partner_id, callback_url, wants_855, wants_856, wants_810, will_send_997_back, ack_timeout_hours }) => {
      const base   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const apiKey = (process.env.API_KEYS || '').split(',')[0];

      const res = await fetch(`${base}/edi/partners/${partner_id}/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          callback_url,
          send_997: true, send_855: wants_855, send_856: wants_856, send_810: wants_810,
          expects_ack: will_send_997_back, ack_timeout_hours,
        }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: 'text', text: `❌ ${data.error}` }] };

      const docs = [
        '997 (Functional Ack) — always',
        wants_855 ? '855 (PO Acknowledgment)' : null,
        wants_856 ? '856 (Ship Notice/ASN)'   : null,
        wants_810 ? '810 (Invoice)'            : null,
      ].filter(Boolean);

      return { content: [{ type: 'text', text: `✅ EDI Delivery Preferences Saved
━━━━━━━━━━━━━━━━━━━━━━━━━
Partner     : ${partner_id}
Callback URL: ${callback_url}

📤 Documents you will receive at your callback:
${docs.map(d => `  • ${d}`).join('\n')}

${will_send_997_back
  ? `🤝 You have agreed to send 997 acks back.\n   Use send_997() after receiving each document.\n   Unacked docs will be flagged after ${ack_timeout_hours}h.`
  : 'ℹ️  One-way delivery — no 997 expected from you.'}

Timing:
  997  → sent within seconds of your 850/860
  855  → sent when your order is confirmed
  856  → sent when seller marks order shipped
  810  → sent when seller marks order delivered` }] };
    }
  );

  // ── Tool 4: send_850 ─────────────────────────────────────────
  server.tool(
    'send_850',
    'Send an EDI 850 Purchase Order to place an order. Use mode=structured to provide JSON (we build X12), or mode=raw_x12 to send a pre-built X12 string. Returns ISA control number — use get_edi_status() to track responses.',
    {
      mode:            z.enum(['structured','raw_x12']).describe('structured = provide JSON, we build X12 | raw_x12 = send complete X12 string'),
      partner_id:      z.string().describe('Your registered EDI partner ID'),
      po_number:       z.string().optional().describe('Your PO reference number (required for structured mode)'),
      items:           z.array(z.object({
        product_id: z.number().int().positive().describe('Seller product ID (from get_edi_setup catalogue)'),
        quantity:   z.number().int().positive(),
        unit_price: z.number().positive().optional().describe('Your proposed unit price (list price used if omitted)'),
      })).optional().describe('Line items (required for structured mode)'),
      shipping_name:   z.string().optional().describe('Ship-to company/person name'),
      shipping_street: z.string().optional().describe('Ship-to street address'),
      shipping_city:   z.string().optional(),
      shipping_state:  z.string().optional().describe('2-letter US state code — used for DC routing'),
      shipping_zip:    z.string().optional(),
      raw_x12:         z.string().optional().describe('Complete raw X12 850 string (required for raw_x12 mode)'),
    },
    async ({ mode, partner_id, po_number, items, shipping_name, shipping_street,
             shipping_city, shipping_state, shipping_zip, raw_x12 }) => {

      let ediPayload;

      if (mode === 'raw_x12') {
        if (!raw_x12) return { content: [{ type: 'text', text: '❌ raw_x12 mode requires the raw_x12 parameter.' }] };
        ediPayload = raw_x12;
      } else {
        // structured mode
        if (!po_number || !items?.length) {
          return { content: [{ type: 'text', text: '❌ structured mode requires: po_number, items[]\nOptionally provide shipping_* for DC routing.' }] };
        }
        if (!shipping_state) {
          return { content: [{ type: 'text', text: '❌ shipping_state (2-letter US code) is required for DC routing.\nExample: "NY", "CA", "TX"' }] };
        }

        // Look up partner ISA ID
        const { rows: partners } = await pool.query(
          `SELECT isa_id FROM edi_trading_partners WHERE partner_id=$1 AND is_active=true`,
          [partner_id]
        );
        if (!partners.length) {
          return { content: [{ type: 'text', text: `❌ Partner "${partner_id}" not found. Call register_trading_partner() first.` }] };
        }

        // Load product prices
        const { rows: products } = await pool.query(
          `SELECT id, name, price FROM products WHERE id = ANY($1)`,
          [items.map(i => i.product_id)]
        );
        const productMap = Object.fromEntries(products.map(p => [p.id, p]));

        // Validate all product IDs exist
        const missing = items.filter(i => !productMap[i.product_id]);
        if (missing.length) {
          return { content: [{ type: 'text', text: `❌ Unknown product IDs: ${missing.map(i => i.product_id).join(', ')}\nCall get_edi_setup() to see valid product IDs.` }] };
        }

        ediPayload = buildX12_850({
          partner_id, isa_id: partners[0].isa_id, po_number, items, productMap,
          shipping_name, shipping_street, shipping_city, shipping_state, shipping_zip,
        });
      }

      // Submit to EDI receiver
      try {
        const result = await receiveEDI(ediPayload, 'mcp', partner_id);

        const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        return { content: [{ type: 'text', text: `✅ EDI 850 Purchase Order Submitted!
━━━━━━━━━━━━━━━━━━━━━━━━━
EDI Message ID  : ${result.edi_message_id}
ISA Control No  : ${result.isa_control}
Transaction     : 850 (Purchase Order)
Partner         : ${result.partner_id}
Status          : Received & Queued

📤 What happens next (async):
  1. 997 Functional Ack → sent to your callback URL within seconds
  2. Order processed → validated, DC assigned, inventory reserved
  3. 855 PO Ack      → sent to your callback when confirmed
  4. 856 Ship Notice → sent when your order ships
  5. 810 Invoice     → sent when delivered (if enabled)

📊 Track this order:
  call get_edi_status("${result.isa_control}")

${mode === 'structured' ? `\n📄 Generated X12 850 (preview):\n${ediPayload.split('~')[0]}~\n...(${ediPayload.split('~').length - 1} segments total)` : ''}` }] };
      } catch (err) {
        if (err.message.startsWith('DUPLICATE:'))
          return { content: [{ type: 'text', text: `⚠️ Duplicate 850: ${err.message}\n\nThis PO was already received. Use a new PO number.` }] };
        return { content: [{ type: 'text', text: `❌ EDI Error: ${err.message}` }] };
      }
    }
  );

  // ── Tool 5: send_860 ─────────────────────────────────────────
  server.tool(
    'send_860',
    'Send an EDI 860 Purchase Order Change Request — to modify quantities or cancel a previously submitted 850. You must reference the original PO number.',
    {
      mode:              z.enum(['structured','raw_x12']).describe('structured = JSON → X12 | raw_x12 = send complete X12 string'),
      partner_id:        z.string().describe('Your registered partner ID'),
      original_po_number: z.string().optional().describe('PO number from the original 850 (required for structured mode)'),
      change_type:       z.enum(['quantity','cancel']).optional().describe('quantity = change line qty | cancel = cancel entire PO'),
      items:             z.array(z.object({
        product_id: z.number().int().positive(),
        quantity:   z.number().int().min(0).describe('New quantity (0 to cancel that line)'),
        unit_price: z.number().positive().optional(),
      })).optional().describe('Updated line items (required for structured mode)'),
      raw_x12:           z.string().optional().describe('Complete raw X12 860 string (required for raw_x12 mode)'),
    },
    async ({ mode, partner_id, original_po_number, change_type = 'quantity', items, raw_x12 }) => {

      let ediPayload;

      if (mode === 'raw_x12') {
        if (!raw_x12) return { content: [{ type: 'text', text: '❌ raw_x12 mode requires the raw_x12 parameter.' }] };
        ediPayload = raw_x12;
      } else {
        if (!original_po_number || !items?.length)
          return { content: [{ type: 'text', text: '❌ structured mode requires: original_po_number, items[]' }] };

        const { rows: partners } = await pool.query(
          `SELECT isa_id FROM edi_trading_partners WHERE partner_id=$1 AND is_active=true`, [partner_id]
        );
        if (!partners.length)
          return { content: [{ type: 'text', text: `❌ Partner "${partner_id}" not found.` }] };

        const { rows: products } = await pool.query(
          `SELECT id, name, price FROM products WHERE id = ANY($1)`,
          [items.map(i => i.product_id)]
        );
        const productMap = Object.fromEntries(products.map(p => [p.id, p]));

        ediPayload = buildX12_860({
          partner_id, isa_id: partners[0].isa_id, original_po_number, change_type, items, productMap,
        });
      }

      try {
        const result = await receiveEDI(ediPayload, 'mcp', partner_id);
        return { content: [{ type: 'text', text: `✅ EDI 860 PO Change Submitted!
━━━━━━━━━━━━━━━━━━━━━━━━━
EDI Message ID  : ${result.edi_message_id}
ISA Control No  : ${result.isa_control}
Transaction     : 860 (PO Change)
Change Type     : ${change_type}
Partner         : ${result.partner_id}

📤 What happens next:
  997 Functional Ack → sent to your callback within seconds
  Order will be modified/cancelled based on your 860
  Updated 855 PO Ack may be sent

📊 Track: call get_edi_status("${result.isa_control}")` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ EDI 860 Error: ${err.message}` }] };
      }
    }
  );

  // ── Tool 6: send_997 ─────────────────────────────────────────
  server.tool(
    'send_997',
    'Send a 997 Functional Acknowledgment to confirm you received our outbound 855, 856, or 810. Provide the ISA control number from the document we sent you.',
    {
      partner_id:         z.string().describe('Your registered partner ID'),
      isa_control_number: z.string().describe('ISA control number from the 855/856/810 we sent you'),
      accepted:           z.boolean().default(true).describe('true = document accepted | false = rejected'),
      rejection_reason:   z.string().optional().describe('Required if accepted=false'),
    },
    async ({ partner_id, isa_control_number, accepted, rejection_reason }) => {
      const { rows } = await pool.query(
        `SELECT id, transaction_set, status FROM edi_messages
         WHERE isa_control_no=$1 AND direction='outbound' AND partner_id=$2
         LIMIT 1`,
        [isa_control_number, partner_id]
      );

      if (!rows.length) {
        return { content: [{ type: 'text', text: `❌ No outbound EDI document found with ISA control ${isa_control_number} for partner ${partner_id}.\n\nCall get_outbound_documents() to see what we sent you.` }] };
      }

      const msg = rows[0];
      if (!accepted) {
        await pool.query(
          `UPDATE edi_messages SET ack_received_at=NOW(), ack_isa_control=$1, status='ack_rejected', error_detail=$2 WHERE id=$3`,
          [isa_control_number, `Partner rejected: ${rejection_reason || 'No reason'}`, msg.id]
        );
        return { content: [{ type: 'text', text: `❌ Rejection recorded for our ${msg.transaction_set} (ISA: ${isa_control_number}).\nReason: ${rejection_reason || 'Not specified'}\nWe have been notified.` }] };
      }

      await pool.query(
        `UPDATE edi_messages SET ack_received_at=NOW(), ack_isa_control=$1 WHERE id=$2`,
        [isa_control_number, msg.id]
      );

      const typeLabel = { '855':'PO Acknowledgment','856':'Ship Notice','810':'Invoice','997':'Functional Ack' };
      return { content: [{ type: 'text', text: `✅ 997 Acknowledgment Recorded
━━━━━━━━━━━━━━━━━━━━━━━━━
Document    : ${msg.transaction_set} — ${typeLabel[msg.transaction_set]||''}
ISA Control : ${isa_control_number}
Partner     : ${partner_id}
Status      : Acknowledged ✓` }] };
    }
  );

  // ── Tool 7: get_edi_status ────────────────────────────────────
  server.tool(
    'get_edi_status',
    'Track the full status of a submitted 850 or 860 by its ISA control number. Shows: received, 997 sent, order status, and any 855/856/810 responses.',
    {
      isa_control_number: z.string().describe('ISA control number returned by send_850() or send_860()'),
      partner_id:         z.string().optional().describe('Your partner ID (helps disambiguate if needed)'),
    },
    async ({ isa_control_number, partner_id }) => {
      const params = [isa_control_number];
      let filter = '';
      if (partner_id) { params.push(partner_id); filter = ` AND m.partner_id=$${params.length}`; }

      const { rows } = await pool.query(`
        SELECT m.*, o.status AS order_status, o.id AS order_id, o.total_amount,
               o.shipping_city, o.shipping_state, o.shipping_days,
               dc.name AS dc_name, dc.city AS dc_city
        FROM edi_messages m
        LEFT JOIN orders o ON o.id = m.order_id
        LEFT JOIN distribution_centers dc ON dc.id = o.assigned_dc_id
        WHERE m.isa_control_no=$1 AND m.direction='inbound'${filter}
        ORDER BY m.created_at DESC LIMIT 1
      `, params);

      if (!rows.length)
        return { content: [{ type: 'text', text: `No EDI message found with ISA control: ${isa_control_number}` }] };

      const m = rows[0];

      // Get outbound responses for this partner/order
      const { rows: responses } = await pool.query(`
        SELECT transaction_set, status, isa_control_no, ack_received_at, created_at, processed_at
        FROM edi_messages
        WHERE direction='outbound' AND partner_id=$1
          AND (order_id=$2 OR created_at > $3)
        ORDER BY created_at ASC
      `, [m.partner_id, m.order_id || -1, m.created_at]);

      const statusIcon = { received:'⏳', processed:'✅', rejected:'❌', error:'🚫', queued:'🔄', acknowledged:'✅' };
      const orderStatusIcon = { queued:'⏳', pending:'🔄', confirmed:'✅', shipped:'🚚', delivered:'📦', cancelled:'❌', failed:'🚫' };
      const typeLabel = { '997':'Functional Ack','855':'PO Ack','856':'Ship Notice','810':'Invoice' };

      let text = `📨 EDI Status — ISA: ${isa_control_number}
━━━━━━━━━━━━━━━━━━━━━━━━━
Transaction : ${m.transaction_set} (${m.transaction_set==='850'?'Purchase Order':'PO Change'})
Status      : ${statusIcon[m.status]||''} ${m.status}
Partner     : ${m.partner_id}
PO Number   : ${m.po_number || '—'}
Received    : ${new Date(m.created_at).toLocaleString()}
${m.error_detail ? `\n❌ Error: ${m.error_detail}\n` : ''}`;

      if (m.order_id) {
        text += `\n📦 Order #${m.order_id}: ${orderStatusIcon[m.order_status]||''} ${m.order_status}`;
        if (m.total_amount) text += ` | $${parseFloat(m.total_amount).toFixed(2)}`;
        if (m.dc_name)      text += `\n   Fulfilling DC: ${m.dc_name} (${m.dc_city})`;
        if (m.shipping_city) text += `\n   Ship to: ${m.shipping_city}, ${m.shipping_state}`;
        if (m.shipping_days) text += ` | Est. ${m.shipping_days} days`;
      }

      if (responses.length) {
        text += '\n\n📤 EDI Responses Sent to Your Callback:\n';
        responses.forEach(r => {
          const ack = r.ack_received_at ? ` ← your 997 received ${new Date(r.ack_received_at).toLocaleDateString()}` : '';
          text += `  • ${r.transaction_set} (${typeLabel[r.transaction_set]||''}) — ${r.status}  ${new Date(r.created_at).toLocaleString()}${ack}\n`;
        });
      } else {
        text += '\n\n⏳ No outbound responses yet — processing in progress...';
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Tool 8: get_outbound_documents ───────────────────────────
  server.tool(
    'get_outbound_documents',
    'See all EDI documents we sent you (997/855/856/810) — their delivery status and whether we received your 997 ack. Use unacked_only=true to find documents still needing your acknowledgment.',
    {
      partner_id:   z.string().describe('Your registered partner ID'),
      order_id:     z.number().int().positive().optional().describe('Filter by specific order ID'),
      unacked_only: z.boolean().default(false).describe('Show only documents awaiting your 997 acknowledgment'),
      limit:        z.number().int().positive().default(20).describe('Max results to return'),
    },
    async ({ partner_id, order_id, unacked_only, limit }) => {
      let query = `
        SELECT m.id, m.transaction_set, m.status, m.ack_required,
               m.ack_received_at, m.isa_control_no, m.order_id,
               m.created_at, m.error_detail
        FROM edi_messages m
        WHERE m.direction='outbound' AND m.partner_id=$1
      `;
      const params = [partner_id];
      if (order_id)     { params.push(order_id);  query += ` AND m.order_id=$${params.length}`; }
      if (unacked_only) query += ` AND m.ack_required=true AND m.ack_received_at IS NULL`;
      params.push(limit);
      query += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);

      if (!rows.length)
        return { content: [{ type: 'text', text: `No outbound EDI documents found for partner: ${partner_id}${unacked_only ? ' (none awaiting ack)' : ''}.` }] };

      const typeLabel = { '997':'Functional Ack','855':'PO Acknowledgment','856':'Ship Notice/ASN','810':'Invoice' };
      const pendingAcks = rows.filter(m => m.ack_required && !m.ack_received_at).length;

      const lines = rows.map(m => {
        const ackStatus = !m.ack_required ? '' :
          m.ack_received_at ? ` ✅ acked ${new Date(m.ack_received_at).toLocaleDateString()}` : ' ⏳ your 997 pending';
        const errNote = m.error_detail ? `\n    ⚠ ${m.error_detail}` : '';
        return `• ${m.transaction_set} (${typeLabel[m.transaction_set]||''})
    ISA: ${m.isa_control_no || '—'} | Order: ${m.order_id ? '#'+m.order_id : '—'} | ${new Date(m.created_at).toLocaleString()}
    Status: ${m.status === 'sent' ? '✅ Delivered' : m.status}${ackStatus}${errNote}`;
      });

      return { content: [{ type: 'text', text: `📤 Outbound EDI for ${partner_id}
${rows.length} document(s)${pendingAcks > 0 ? ` — ⏳ ${pendingAcks} awaiting your 997` : ' — ✅ all up to date'}

${lines.join('\n\n')}

${pendingAcks > 0 ? `To acknowledge: call send_997(partner_id, isa_control_number) for each pending document.` : ''}` }] };
    }
  );

  return server;
}

// ── Express route handler ─────────────────────────────────────

function attachEdiMcpToExpress(app, mountPath = '/edi-mcp') {
  app.all(mountPath, async (req, res) => {
    try {
      const server    = createEdiMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[EDI-MCP] Request error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'EDI MCP server error' });
    }
  });

  console.log(`[EDI-MCP] EDI MCP server mounted at ${mountPath}`);
}

module.exports = { attachEdiMcpToExpress };
