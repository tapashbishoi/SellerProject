require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('../db');

const PRICE_FLOOR_PCT      = parseFloat(process.env.PRICE_FLOOR_PCT      || '0.70'); // 70% — negotiable floor
const PRICE_HARD_REJECT_PCT = parseFloat(process.env.PRICE_HARD_REJECT_PCT || '0.60'); // 60% — instant reject, no counter

let gemini = null;
function getGemini() {
  if (!gemini) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return gemini;
}

// ── Load buyer history for context ───────────────────────────
async function getBuyerHistory(buyer_email) {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS total_orders,
           COALESCE(SUM(total_amount), 0) AS total_spent,
           MAX(created_at) AS last_order
    FROM orders
    WHERE LOWER(buyer_email) = LOWER($1)
      AND status NOT IN ('failed','cancelled')
  `, [buyer_email]);
  return rows[0];
}

// ── Gemini negotiation evaluator ─────────────────────────────
async function evaluateOffer({ product, quantity, buyer_offer, floor_price, buyer_history, round, previous_counter, shipping_info }) {
  const model = getGemini().getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-flash-latest' });

  const prompt = `You are a professional sales negotiation agent for a stationery business.

PRODUCT DETAILS:
- Name: ${product.name}
- Category: ${product.category}
- List Price: $${product.price} per ${product.unit}
- Minimum Acceptable Price (floor): $${floor_price.toFixed(2)} per unit
- Quantity requested: ${quantity} unit(s)
- Total at list price: $${(product.price * quantity).toFixed(2)}

BUYER DETAILS:
- Email: ${product.buyer_email || 'unknown'}
- Previous orders: ${buyer_history.total_orders}
- Total spent with us: $${parseFloat(buyer_history.total_spent).toFixed(2)}
- Last order: ${buyer_history.last_order ? new Date(buyer_history.last_order).toLocaleDateString() : 'First time buyer'}

SHIPPING & LOGISTICS:
${shipping_info ? `- Buyer ships to: ${shipping_info.city}, ${shipping_info.state}
- Fulfilling DC: ${shipping_info.dc_name} (${shipping_info.dc_city})
- Estimated shipping: $${shipping_info.shipping_cost} for this order
- Shipping as % of order value at buyer's offer: ${((shipping_info.shipping_cost / (buyer_offer * quantity)) * 100).toFixed(1)}%
- Delivery: ${shipping_info.shipping_days} business days` : '- Shipping details not available'}

NEGOTIATION:
- Round: ${round}
- Buyer's offer: $${buyer_offer} per unit (total: $${(buyer_offer * quantity).toFixed(2)})
${previous_counter ? `- Our previous counter-offer was: $${previous_counter} per unit` : ''}

RULES:
1. NEVER accept below the floor price of $${floor_price.toFixed(2)} per unit
2. For loyal buyers (3+ orders or $500+ spent), you may offer up to 5% extra discount
3. For large orders (50+ units), you may go closer to floor price
4. If buyer is FAR from DC (shipping > 15% of order value), be less flexible on discount — shipping eats margin
5. If buyer is NEAR DC (shipping < 5% of order value), you can offer slightly more discount
6. If the buyer's offer is at or above list price, accept immediately
7. If the buyer is offering below floor, REJECT with a clear reason and a fair counter-offer
8. On round 3+, be firmer — state this is your best and final offer
9. Always be professional and friendly

Respond in this EXACT JSON format (no markdown, just JSON):
{
  "decision": "accept" | "counter" | "reject",
  "counter_price": <number or null — your counter-offer per unit, null if accepting>,
  "message": "<friendly professional message to the buyer — 2-3 sentences>",
  "reasoning": "<internal reasoning — why you made this decision>"
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences if present
  const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

// ── Main negotiation handler ──────────────────────────────────
async function handleNegotiation({ product_id, buyer_offer, buyer_email, buyer_name, quantity = 1, negotiation_id = null }) {
  // Load product
  const { rows: pRows } = await pool.query(
    `SELECT p.*, i.quantity AS stock FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.id = $1`,
    [product_id]
  );
  if (!pRows.length) throw new Error(`Product ID ${product_id} not found`);
  const product = pRows[0];

  // Check stock
  if (product.stock < quantity) {
    return {
      status: 'rejected',
      reason: `Insufficient stock. Only ${product.stock} unit(s) available, you requested ${quantity}.`,
      negotiation_id: null,
    };
  }

  const list_price       = parseFloat(product.price);
  const floor_price      = parseFloat((list_price * PRICE_FLOOR_PCT).toFixed(2));
  const hard_reject_price = parseFloat((list_price * PRICE_HARD_REJECT_PCT).toFixed(2));

  // Hard reject — offer is so low we won't even counter
  if (buyer_offer < hard_reject_price) {
    const { rows } = await pool.query(
      `INSERT INTO negotiations
         (product_id, buyer_email, buyer_name, quantity, list_price, floor_price,
          buyer_offer, counter_offer, status, round, ai_reasoning, ai_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'rejected',1,$8,$9) RETURNING id`,
      [
        product_id, buyer_email, buyer_name, quantity, list_price, floor_price, buyer_offer,
        `Offer of $${buyer_offer} is below hard reject threshold of $${hard_reject_price} (${PRICE_HARD_REJECT_PCT * 100}% of list price).`,
        `We appreciate your interest in ${product.name}, but your offer of $${buyer_offer}/unit is significantly below our minimum acceptable price. Our list price is $${list_price}/unit. We are unable to accept or counter this offer. Please consider our list price or reach out to discuss volume-based arrangements.`,
      ]
    );
    return {
      negotiation_id: rows[0].id,
      status:         'rejected',
      round:          1,
      product:        product.name,
      list_price,
      floor_price,
      your_offer:     buyer_offer,
      counter_offer:  null,
      agreed_price:   null,
      message:        `Your offer of $${buyer_offer}/unit is too far below our minimum price of $${hard_reject_price}/unit. We cannot proceed with this negotiation. Please submit a new offer closer to the list price of $${list_price}/unit.`,
      order_id:       null,
      next_steps:     'Negotiation closed. Start a new negotiation with a higher offer.',
    };
  }

  // Load buyer history
  const buyer_history = await getBuyerHistory(buyer_email);

  // Load existing negotiation if continuing
  let round = 1;
  let previous_counter = null;
  let existing = null;

  if (negotiation_id) {
    const { rows: nRows } = await pool.query(
      `SELECT * FROM negotiations WHERE id = $1 AND buyer_email = $2`,
      [negotiation_id, buyer_email]
    );
    if (nRows.length) {
      existing = nRows[0];
      round = existing.round + 1;
      previous_counter = existing.counter_offer;
    }
  }

  // Load buyer profile for shipping context
  const { rows: profileRows } = await pool.query(
    `SELECT b.shipping_city, b.shipping_state, b.shipping_zip,
            dc.name AS dc_name, dc.city AS dc_city, dc.dc_code
     FROM buyer_profiles b
     LEFT JOIN distribution_centers dc ON dc.id = b.preferred_dc_id
     WHERE LOWER(b.buyer_email) = LOWER($1)`, [buyer_email]
  );
  let shipping_info = null;
  if (profileRows.length && profileRows[0].shipping_state) {
    const p = profileRows[0];
    const dcCode = p.dc_code || require('../dc/zones').getDCCodeForState(p.shipping_state);
    shipping_info = {
      city: p.shipping_city, state: p.shipping_state,
      dc_name: p.dc_name || 'Nearest DC', dc_city: p.dc_city || '',
      shipping_cost: require('../dc/zones').estimateShippingCost(dcCode, p.shipping_state, quantity),
      shipping_days: require('../dc/zones').estimateShippingDays(dcCode, p.shipping_state),
    };
  }

  // Ask Gemini to evaluate
  product.buyer_email = buyer_email;
  const ai = await evaluateOffer({ product, quantity, buyer_offer, floor_price, buyer_history, round, previous_counter, shipping_info });

  // Determine final status
  let status = ai.decision === 'accept' ? 'accepted' : ai.decision === 'reject' ? 'rejected' : 'countered';
  const agreed_price = ai.decision === 'accept' ? buyer_offer : null;
  const counter_price = ai.counter_price || null;

  // Save negotiation to DB
  let negId;
  if (existing) {
    await pool.query(
      `UPDATE negotiations
       SET buyer_offer=$1, counter_offer=$2, status=$3, round=$4,
           ai_reasoning=$5, ai_message=$6, updated_at=NOW()
       WHERE id=$7`,
      [buyer_offer, counter_price, status, round, ai.reasoning, ai.message, negotiation_id]
    );
    negId = negotiation_id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO negotiations
         (product_id, buyer_email, buyer_name, quantity, list_price, floor_price,
          buyer_offer, counter_offer, status, round, ai_reasoning, ai_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [product_id, buyer_email, buyer_name, quantity, list_price, floor_price,
       buyer_offer, counter_price, status, round, ai.reasoning, ai.message]
    );
    negId = rows[0].id;
  }

  // If accepted, auto-stage the order via MQ
  let order_id = null;
  if (ai.decision === 'accept') {
    const { publishOrder } = require('../mq/publisher');
    // Create the order with the agreed price
    const { rows: oRows } = await pool.query(
      `INSERT INTO orders (buyer_name, buyer_email, notes, status, channel)
       VALUES ($1,$2,$3,'queued','negotiation') RETURNING id, created_at`,
      [buyer_name || buyer_email, buyer_email, `Negotiated price: $${buyer_offer}/unit (list: $${list_price})`]
    );
    order_id = oRows[0].id;

    const messageId = await publishOrder({
      staged_order_id: order_id,
      buyer_name: buyer_name || buyer_email,
      buyer_email,
      notes: `Negotiated price: $${buyer_offer}/unit`,
      items: [{ product_id, quantity, negotiated_price: buyer_offer }],
    });
    await pool.query(`UPDATE orders SET mq_message_id=$1 WHERE id=$2`, [messageId, order_id]);
    await pool.query(`UPDATE negotiations SET order_id=$1 WHERE id=$2`, [order_id, negId]);
  }

  return {
    negotiation_id: negId,
    status,
    round,
    product:        product.name,
    list_price,
    floor_price,
    your_offer:     buyer_offer,
    counter_offer:  counter_price,
    agreed_price,
    message:        ai.message,
    order_id,
    next_steps: status === 'accepted'
      ? `Order #${order_id} has been placed. Track it with track_order(${order_id})`
      : status === 'countered'
      ? `Call negotiate_price again with negotiation_id=${negId} and your new offer`
      : 'Negotiation closed. You may start a new negotiation with a higher offer.',
  };
}

module.exports = { handleNegotiation };
