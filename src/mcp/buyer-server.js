/**
 * Buyer MCP Server — mounted at /mcp on the main Express app.
 * Buyers connect with any MCP client to https://sellerpos.onrender.com/mcp
 *
 * Tools exposed:
 *  1. browse_catalogue      — list/search/filter products with stock status
 *  2. get_product           — single product detail + availability
 *  3. check_inventory       — full inventory or specific product stock
 *  4. place_order           — submit order via RabbitMQ
 *  5. track_order           — get order status + items by order ID
 *  6. list_my_orders        — all orders for a buyer email
 */
const path = require('path');
const mcpServerDir = path.resolve(__dirname, '../../node_modules/@modelcontextprotocol/sdk/dist/cjs/server');
const { McpServer }                     = require(path.join(mcpServerDir, 'mcp.js'));
const { StreamableHTTPServerTransport } = require(path.join(mcpServerDir, 'streamableHttp.js'));
const z = require('zod');
const pool                             = require('../db');
const { publishOrder }                 = require('../mq/publisher');
const { handleNegotiation }            = require('../negotiation/agent');
const { routeOrderToDC, getProductDCStock } = require('../dc/router');
const { getDCCodeForState, estimateShippingDays, estimateShippingCost } = require('../dc/zones');

// ── Tool helpers ──────────────────────────────────────────────

async function getBrowseCatalogue({ category, search }) {
  let query = `
    SELECT p.id, p.name, p.description, p.category, p.unit, p.price,
           i.quantity,  i.low_stock_threshold,
           CASE
             WHEN i.quantity = 0           THEN 'out_of_stock'
             WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
             ELSE 'in_stock'
           END AS stock_status
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (category) { params.push(category);         query += ` AND p.category = $${params.length}`; }
  if (search)   { params.push(`%${search}%`);    query += ` AND p.name ILIKE $${params.length}`; }
  query += ' ORDER BY p.category, p.name';
  const { rows } = await pool.query(query, params);
  return rows;
}

async function getProduct(id) {
  const { rows } = await pool.query(`
    SELECT p.*, i.quantity, i.low_stock_threshold,
           CASE
             WHEN i.quantity = 0           THEN 'out_of_stock'
             WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
             ELSE 'in_stock'
           END AS stock_status
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.id = $1`, [id]);
  return rows[0] || null;
}

async function getInventory(productId) {
  let query = `
    SELECT p.id AS product_id, p.name, p.category, p.unit, p.price,
           i.quantity, i.low_stock_threshold, i.updated_at,
           CASE
             WHEN i.quantity = 0           THEN 'out_of_stock'
             WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
             ELSE 'in_stock'
           END AS stock_status
    FROM products p JOIN inventory i ON i.product_id = p.id
  `;
  if (productId) {
    const { rows } = await pool.query(query + ' WHERE p.id = $1', [productId]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(query + ' ORDER BY p.name');
  return rows;
}

async function getBuyerProfile(email) {
  const { rows } = await pool.query(
    `SELECT b.*, dc.name AS dc_name, dc.dc_code, dc.city AS dc_city
     FROM buyer_profiles b
     LEFT JOIN distribution_centers dc ON dc.id = b.preferred_dc_id
     WHERE LOWER(b.buyer_email) = LOWER($1)`,
    [email]
  );
  return rows[0] || null;
}

async function stageOrder({ buyer_name, buyer_email, buyer_phone, notes, items, channel = 'mcp',
                             shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country = 'US' }) {
  // If no shipping address provided, try to load from buyer profile
  let shippingState = shipping_state;
  let dcRoute = null;

  if (!shippingState) {
    const profile = await getBuyerProfile(buyer_email);
    if (profile) {
      shippingState    = profile.shipping_state;
      shipping_street  = profile.shipping_street;
      shipping_city    = profile.shipping_city;
      shipping_zip     = profile.shipping_zip;
      shipping_country = profile.shipping_country || 'US';
    }
  }

  // Route to best DC
  if (shippingState && items?.length) {
    try { dcRoute = await routeOrderToDC(shippingState, items); } catch (_) {}
  }

  // Create queued order row — tagged with source channel + shipping + DC
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, notes, status, channel,
                         shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country,
                         shipping_name, assigned_dc_id, shipping_days, shipping_cost)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
    [buyer_name, buyer_email, buyer_phone, notes, channel,
     shipping_street, shipping_city, shippingState, shipping_zip, shipping_country,
     buyer_name, dcRoute?.dc?.id || null, dcRoute?.shipping_days || null, dcRoute?.shipping_cost || null]
  );
  const staged = rows[0];

  // Publish to RabbitMQ
  const messageId = await publishOrder({
    staged_order_id: staged.id,
    buyer_name, buyer_email, buyer_phone, notes, items,
  });
  await pool.query(`UPDATE orders SET mq_message_id=$1 WHERE id=$2`, [messageId, staged.id]);

  return {
    order_id:      staged.id,
    status:        'queued',
    message_id:    messageId,
    created_at:    staged.created_at,
    fulfilling_dc: dcRoute?.dc ? { name: dcRoute.dc.name, city: dcRoute.dc.city, state: dcRoute.dc.state } : null,
    shipping_days: dcRoute?.shipping_days || null,
    shipping_cost: dcRoute?.shipping_cost || null,
  };
}

async function getOrder(id) {
  const { rows } = await pool.query(`
    SELECT o.*,
      json_agg(json_build_object(
        'product_id',   oi.product_id,
        'product_name', p.name,
        'quantity',     oi.quantity,
        'unit_price',   oi.unit_price,
        'subtotal',     oi.quantity * oi.unit_price
      )) FILTER (WHERE oi.id IS NOT NULL) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products    p  ON p.id = oi.product_id
    WHERE o.id = $1
    GROUP BY o.id`, [id]);
  return rows[0] || null;
}

async function getOrdersByEmail(email) {
  const { rows } = await pool.query(`
    SELECT o.id, o.buyer_name, o.status, o.total_amount, o.created_at, o.failure_reason,
      COUNT(oi.id) AS item_count
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE LOWER(o.buyer_email) = LOWER($1)
    GROUP BY o.id
    ORDER BY o.created_at DESC`, [email]);
  return rows;
}

// ── MCP Server factory ────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name:    'seller-buyer-agent',
    version: '1.0.0',
  });

  // ── Tool 1: browse_catalogue ──────────────────────────────
  server.tool(
    'browse_catalogue',
    'Browse the stationery product catalogue. Filter by category or search by name. Returns products with prices and live stock availability.',
    {
      category: z.string().optional().describe('Filter by category: Pen, Pencil, Notebook, Eraser, Ruler, Stapler, File, Other'),
      search:   z.string().optional().describe('Search term for product name (partial match)'),
    },
    async ({ category, search }) => {
      const products = await getBrowseCatalogue({ category, search });
      if (!products.length) return { content: [{ type: 'text', text: 'No products found matching your criteria.' }] };

      const lines = products.map(p =>
        `• [ID:${p.id}] ${p.name} — $${parseFloat(p.price).toFixed(2)} / ${p.unit} | Stock: ${p.quantity ?? 0} (${p.stock_status.replace('_', ' ')})${p.description ? `\n  ${p.description}` : ''}`
      );
      return { content: [{ type: 'text', text: `Found ${products.length} product(s):\n\n${lines.join('\n')}` }] };
    }
  );

  // ── Tool 2: get_product ───────────────────────────────────
  server.tool(
    'get_product',
    'Get full details of a single product including price, description, stock quantity and availability status.',
    { product_id: z.number().int().positive().describe('The product ID') },
    async ({ product_id }) => {
      const p = await getProduct(product_id);
      if (!p) return { content: [{ type: 'text', text: `Product ID ${product_id} not found.` }] };
      const text = `Product: ${p.name}
ID:          ${p.id}
Category:    ${p.category || 'N/A'}
Price:       $${parseFloat(p.price).toFixed(2)} / ${p.unit}
Stock:       ${p.quantity ?? 0} units
Availability: ${p.stock_status.replace(/_/g, ' ')}
${p.description ? `Description: ${p.description}` : ''}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Tool 3: check_inventory ───────────────────────────────
  server.tool(
    'check_inventory',
    'Check current stock levels. Omit product_id to see all products. Returns quantity available and stock status (in_stock / low_stock / out_of_stock).',
    { product_id: z.number().int().positive().optional().describe('Leave empty to get all inventory') },
    async ({ product_id }) => {
      const data = await getInventory(product_id);
      if (!data) return { content: [{ type: 'text', text: `Product ID ${product_id} not found.` }] };

      if (!Array.isArray(data)) {
        const i = data;
        return { content: [{ type: 'text', text: `${i.name}: ${i.quantity} units in stock (${i.stock_status.replace(/_/g, ' ')})` }] };
      }

      const inStock  = data.filter(i => i.stock_status === 'in_stock');
      const low      = data.filter(i => i.stock_status === 'low_stock');
      const outOf    = data.filter(i => i.stock_status === 'out_of_stock');

      const fmt = arr => arr.map(i => `  • ${i.name}: ${i.quantity} units`).join('\n');
      let text = `Inventory Summary (${data.length} products)\n\n`;
      if (inStock.length) text += `✅ In Stock (${inStock.length}):\n${fmt(inStock)}\n\n`;
      if (low.length)     text += `⚠️  Low Stock (${low.length}):\n${fmt(low)}\n\n`;
      if (outOf.length)   text += `❌ Out of Stock (${outOf.length}):\n${fmt(outOf)}\n`;
      return { content: [{ type: 'text', text: text.trim() }] };
    }
  );

  // ── Tool 4: place_order ───────────────────────────────────
  server.tool(
    'place_order',
    'Place a new order. Shipping address is auto-loaded from your buyer profile if registered. The fulfilling DC is shown before confirmation. Order is processed via RabbitMQ.',
    {
      buyer_name:       z.string().min(1).describe('Full name of the buyer'),
      buyer_email:      z.string().email().describe('Buyer email address'),
      buyer_phone:      z.string().optional().describe('Buyer phone number (optional)'),
      notes:            z.string().optional().describe('Delivery or special instructions (optional)'),
      shipping_street:  z.string().optional().describe('Shipping street address — auto-loaded from profile if registered'),
      shipping_city:    z.string().optional().describe('Shipping city'),
      shipping_state:   z.string().optional().describe('Shipping state (2-letter code e.g. NY, CA, IL)'),
      shipping_zip:     z.string().optional().describe('Shipping ZIP code'),
      items: z.array(z.object({
        product_id: z.number().int().positive().describe('Product ID from the catalogue'),
        quantity:   z.number().int().positive().describe('Quantity to order'),
      })).min(1).describe('List of items to order'),
    },
    async ({ buyer_name, buyer_email, buyer_phone, notes, items,
             shipping_street, shipping_city, shipping_state, shipping_zip }) => {

      // Load profile if no address given
      if (!shipping_state) {
        const profile = await getBuyerProfile(buyer_email);
        if (!profile) {
          return { content: [{ type: 'text', text: `⚠️ No shipping address found for ${buyer_email}.\n\nPlease either:\n• Use register_buyer to save your office address, OR\n• Provide shipping_state when placing the order.\n\nThis is needed to assign your nearest DC.` }] };
        }
      }

      // Pre-check stock
      const warnings = [];
      for (const item of items) {
        const inv = await getInventory(item.product_id);
        if (!inv) { warnings.push(`Product ID ${item.product_id} does not exist`); continue; }
        if (inv.quantity < item.quantity)
          warnings.push(`"${inv.name}": only ${inv.quantity} in stock, you requested ${item.quantity}`);
      }
      if (warnings.length)
        return { content: [{ type: 'text', text: `⚠️ Cannot place order — stock issues:\n${warnings.map(w => `• ${w}`).join('\n')}` }] };

      const result = await stageOrder({ buyer_name, buyer_email, buyer_phone, notes, items,
                                        shipping_street, shipping_city, shipping_state, shipping_zip });
      const dc   = result.fulfilling_dc;
      const text = `✅ Order placed successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Order ID:   ${result.order_id}
Status:     Queued for processing

📦 Fulfilling DC: ${dc ? `${dc.name} (${dc.city}, ${dc.state})` : 'To be assigned'}
🚚 Estimated shipping: ${result.shipping_days ? `${result.shipping_days} business days` : 'TBD'}
💲 Shipping cost: ${result.shipping_cost ? `$${result.shipping_cost}` : 'TBD'}

Use track_order(${result.order_id}) to check order status.`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Tool 5: track_order ───────────────────────────────────
  server.tool(
    'track_order',
    'Track the status of an order by its ID. Returns current status (queued/confirmed/shipped/delivered/cancelled/failed), items, and total amount.',
    { order_id: z.number().int().positive().describe('The order ID returned when the order was placed') },
    async ({ order_id }) => {
      const o = await getOrder(order_id);
      if (!o) return { content: [{ type: 'text', text: `Order #${order_id} not found.` }] };

      const statusEmoji = { queued: '⏳', pending: '🔄', confirmed: '✅', shipped: '🚚', delivered: '📦', cancelled: '❌', failed: '🚫' };
      const items = (o.items || []).map(i =>
        `  • ${i.product_name} × ${i.quantity} @ $${parseFloat(i.unit_price).toFixed(2)} = $${parseFloat(i.subtotal).toFixed(2)}`
      ).join('\n');

      // Load DC info
      let dcLine = '';
      if (o.assigned_dc_id) {
        const { rows: dcRows } = await pool.query(
          `SELECT name, city, state FROM distribution_centers WHERE id=$1`, [o.assigned_dc_id]
        );
        if (dcRows.length) dcLine = `\n📦 Fulfilling DC: ${dcRows[0].name} (${dcRows[0].city}, ${dcRows[0].state})`;
      }
      const shippingLine = o.shipping_city
        ? `\n🚚 Ship to: ${[o.shipping_city, o.shipping_state, o.shipping_zip].filter(Boolean).join(', ')} ${o.shipping_days ? `| Est. ${o.shipping_days} days` : ''}`
        : '';

      let text = `Order #${o.id} — ${statusEmoji[o.status] || ''} ${o.status.toUpperCase()}

Buyer:   ${o.buyer_name} (${o.buyer_email || 'no email'})
Placed:  ${new Date(o.created_at).toLocaleString()}
Total:   $${parseFloat(o.total_amount || 0).toFixed(2)}${dcLine}${shippingLine}
`;
      if (items) text += `\nItems:\n${items}`;
      if (o.failure_reason) text += `\n\n❌ Failure reason: ${o.failure_reason}`;
      if (o.notes) text += `\nNotes: ${o.notes}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Tool 6: list_my_orders ────────────────────────────────
  server.tool(
    'list_my_orders',
    'List all orders placed with a specific buyer email address. Shows order history with status and totals.',
    { buyer_email: z.string().email().describe('The email address used when placing orders') },
    async ({ buyer_email }) => {
      const orders = await getOrdersByEmail(buyer_email);
      if (!orders.length) return { content: [{ type: 'text', text: `No orders found for ${buyer_email}.` }] };

      const statusEmoji = { queued: '⏳', pending: '🔄', confirmed: '✅', shipped: '🚚', delivered: '📦', cancelled: '❌', failed: '🚫' };
      const lines = orders.map(o =>
        `• Order #${o.id} — ${statusEmoji[o.status] || ''} ${o.status} | $${parseFloat(o.total_amount || 0).toFixed(2)} | ${o.item_count} item(s) | ${new Date(o.created_at).toLocaleDateString()}`
      );
      return { content: [{ type: 'text', text: `Orders for ${buyer_email} (${orders.length} total):\n\n${lines.join('\n')}` }] };
    }
  );

  // ── Tool 7: register_buyer ───────────────────────────────────
  server.tool(
    'register_buyer',
    'Save your office shipping address so you never have to re-enter it. Also determines your nearest DC for fast fulfillment. Call this once before placing orders.',
    {
      buyer_email:     z.string().email().describe('Your email address (used as buyer ID)'),
      buyer_name:      z.string().min(1).describe('Your full name'),
      company_name:    z.string().optional().describe('Your company name'),
      shipping_street: z.string().optional().describe('Office street address'),
      shipping_city:   z.string().min(1).describe('Office city'),
      shipping_state:  z.string().min(2).max(2).describe('Office state (2-letter code e.g. NY, CA, IL, TX)'),
      shipping_zip:    z.string().optional().describe('Office ZIP code'),
    },
    async ({ buyer_email, buyer_name, company_name, shipping_street, shipping_city, shipping_state, shipping_zip }) => {
      const res = await fetch(`${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/api/buyers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': (process.env.API_KEYS || '').split(',')[0] },
        body: JSON.stringify({ buyer_email, buyer_name, company_name, shipping_street, shipping_city, shipping_state, shipping_zip })
      });
      const profile = await res.json();
      if (!res.ok) return { content: [{ type: 'text', text: `❌ Error: ${profile.error}` }] };

      return { content: [{ type: 'text', text: `✅ Buyer profile saved!

Name:         ${profile.buyer_name || buyer_name}
Email:        ${profile.buyer_email}
Company:      ${profile.company_name || '—'}
Ship to:      ${[shipping_street, shipping_city, shipping_state, shipping_zip].filter(Boolean).join(', ')}
Nearest DC:   ${profile.preferred_dc_name || 'US Central DC'} ${profile.dc_city ? `(${profile.dc_city})` : ''}

Your orders will now automatically route to ${profile.preferred_dc_name || 'the nearest DC'}.
You can place orders without providing a shipping address every time.` }] };
    }
  );

  // ── Tool 8: get_my_profile ────────────────────────────────────
  server.tool(
    'get_my_profile',
    'View your saved buyer profile including shipping address and assigned DC.',
    { buyer_email: z.string().email().describe('Your email address') },
    async ({ buyer_email }) => {
      const { rows } = await pool.query(
        `SELECT b.*, dc.name AS dc_name, dc.city AS dc_city, dc.state AS dc_state
         FROM buyer_profiles b
         LEFT JOIN distribution_centers dc ON dc.id = b.preferred_dc_id
         WHERE LOWER(b.buyer_email) = LOWER($1)`, [buyer_email]
      );
      if (!rows.length) return { content: [{ type: 'text', text: `No profile found for ${buyer_email}. Use register_buyer to create one.` }] };
      const p = rows[0];
      return { content: [{ type: 'text', text: `👤 Buyer Profile

Name:       ${p.buyer_name || '—'}
Company:    ${p.company_name || '—'}
Email:      ${p.buyer_email}
Ship to:    ${[p.shipping_street, p.shipping_city, p.shipping_state, p.shipping_zip].filter(Boolean).join(', ')}
Nearest DC: ${p.dc_name || '—'} ${p.dc_city ? `(${p.dc_city}, ${p.dc_state})` : ''}
Member since: ${new Date(p.created_at).toLocaleDateString()}` }] };
    }
  );

  // ── Tool 9: check_delivery_options ───────────────────────────
  server.tool(
    'check_delivery_options',
    'Check which DC will fulfill your order, estimated delivery days, and shipping cost BEFORE placing the order. Use this to confirm fulfillment details.',
    {
      buyer_email: z.string().email().describe('Your email — shipping address loaded from profile'),
      items: z.array(z.object({
        product_id: z.number().int().positive(),
        quantity:   z.number().int().positive(),
      })).min(1).describe('Items you plan to order'),
      shipping_state: z.string().optional().describe('Override state if different from your profile (2-letter code)'),
    },
    async ({ buyer_email, items, shipping_state }) => {
      // Get shipping state from profile or param
      let state = shipping_state;
      let profileCity = '';
      if (!state) {
        const profile = await getBuyerProfile(buyer_email);
        if (!profile?.shipping_state)
          return { content: [{ type: 'text', text: `No shipping address found. Register with register_buyer first, or provide shipping_state.` }] };
        state = profile.shipping_state;
        profileCity = profile.shipping_city;
      }

      let route;
      try { route = await routeOrderToDC(state, items); }
      catch (e) { return { content: [{ type: 'text', text: `❌ ${e.message}` }] }; }

      const dc   = route.dc;
      const totalUnits = items.reduce((s,i) => s + i.quantity, 0);

      // Stock summary per item
      const stockLines = [];
      for (const item of items) {
        const { rows } = await pool.query(
          `SELECT p.name, i.quantity AS dc_qty FROM products p
           LEFT JOIN dc_inventory i ON i.product_id=p.id AND i.dc_id=$1
           WHERE p.id=$2`, [dc.id, item.product_id]
        );
        if (rows.length) {
          const avail = rows[0].dc_qty || 0;
          const ok = avail >= item.quantity;
          stockLines.push(`  ${ok ? '✅' : '⚠️'} ${rows[0].name}: need ${item.quantity}, ${dc.name} has ${avail}`);
        }
      }

      const partial = route.partial ? '\n⚠️  Note: No single DC has full stock — may route to secondary DC.' : '';

      return { content: [{ type: 'text', text: `📦 Delivery Options for ${profileCity || state}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Fulfilling DC:    ${dc.name}
DC Location:      ${dc.city}, ${dc.state}
Est. Delivery:    ${route.shipping_days} business days
Shipping Cost:    $${route.shipping_cost}
Total Units:      ${totalUnits}
${route.is_preferred ? '✅ This is your nearest DC' : 'ℹ️  Nearest DC has insufficient stock — routed to next available'}
${partial}

Stock at ${dc.name}:
${stockLines.join('\n')}

Ready to order? Use place_order() — DC will be auto-assigned.` }] };
    }
  );

  // ── Tool 10: negotiate_price ──────────────────────────────────
  server.tool(
    'negotiate_price',
    'Propose a price for a product. The AI seller agent will evaluate your offer and respond with accept, counter-offer, or rejection in real-time. Use negotiation_id to continue a previous round.',
    {
      product_id:     z.number().int().positive().describe('Product ID to negotiate for'),
      proposed_price: z.number().positive().describe('Your proposed price per unit in USD'),
      quantity:       z.number().int().positive().describe('Number of units you want to buy'),
      buyer_email:    z.string().email().describe('Your email address'),
      buyer_name:     z.string().optional().describe('Your name (optional)'),
      negotiation_id: z.number().int().positive().optional().describe('Provide this to continue a previous negotiation round'),
    },
    async ({ product_id, proposed_price, quantity, buyer_email, buyer_name, negotiation_id }) => {
      try {
        const result = await handleNegotiation({
          product_id, buyer_offer: proposed_price, buyer_email, buyer_name, quantity, negotiation_id,
        });
        const icon = { accepted: '✅', countered: '🔄', rejected: '❌' }[result.status] || '';
        let text = `${icon} Negotiation ${result.status.toUpperCase()} — Round ${result.round}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Product:      ${result.product}
List Price:   $${result.list_price.toFixed(2)}/unit
Your Offer:   $${result.your_offer.toFixed(2)}/unit × ${quantity} = $${(result.your_offer * quantity).toFixed(2)}
`;
        if (result.counter_offer) text += `Counter Offer: $${result.counter_offer.toFixed(2)}/unit × ${quantity} = $${(result.counter_offer * quantity).toFixed(2)}\n`;
        if (result.agreed_price)  text += `Agreed Price:  $${result.agreed_price.toFixed(2)}/unit\n`;
        text += `\n💬 ${result.message}\n\n📋 ${result.next_steps}`;
        if (result.negotiation_id) text += `\n\nNegotiation ID: ${result.negotiation_id}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }] };
      }
    }
  );

  // ── Tool 11: get_negotiation ───────────────────────────────────
  server.tool(
    'get_negotiation',
    'Check the current status of a price negotiation by its ID.',
    {
      negotiation_id: z.number().int().positive().describe('The negotiation ID'),
      buyer_email:    z.string().email().describe('Your email (must match the negotiation)'),
    },
    async ({ negotiation_id, buyer_email }) => {
      const { rows } = await pool.query(
        `SELECT n.*, p.name AS product_name FROM negotiations n
         JOIN products p ON p.id = n.product_id
         WHERE n.id = $1 AND LOWER(n.buyer_email) = LOWER($2)`,
        [negotiation_id, buyer_email]
      );
      if (!rows.length) return { content: [{ type: 'text', text: 'Negotiation not found or email does not match.' }] };
      const n = rows[0];
      const icon = { accepted: '✅', countered: '🔄', rejected: '❌', open: '⏳' }[n.status] || '';
      return { content: [{ type: 'text', text: `${icon} Negotiation #${n.id} — ${n.status.toUpperCase()}
Product:       ${n.product_name}
Your offer:    $${n.buyer_offer}/unit × ${n.quantity} units
Counter offer: ${n.counter_offer ? `$${n.counter_offer}/unit` : 'N/A'}
Round:         ${n.round}
Message:       ${n.ai_message || 'N/A'}
${n.order_id ? `Order placed:  #${n.order_id}` : ''}` }] };
    }
  );

  // ── Tool 12: accept_counter_offer ─────────────────────────────
  server.tool(
    'accept_counter_offer',
    "Accept the seller's counter-offer from a negotiation. This immediately places the order at the counter price via RabbitMQ.",
    {
      negotiation_id: z.number().int().positive().describe('The negotiation ID with a pending counter-offer'),
      buyer_email:    z.string().email().describe('Your email (must match the negotiation)'),
    },
    async ({ negotiation_id, buyer_email }) => {
      const { rows } = await pool.query(
        `SELECT n.*, p.name AS product_name FROM negotiations n
         JOIN products p ON p.id = n.product_id
         WHERE n.id=$1 AND LOWER(n.buyer_email)=LOWER($2) AND n.status='countered'`,
        [negotiation_id, buyer_email]
      );
      if (!rows.length) return { content: [{ type: 'text', text: 'No active counter-offer found for this negotiation ID and email.' }] };
      const n = rows[0];
      const result = await handleNegotiation({
        product_id: n.product_id, buyer_offer: parseFloat(n.counter_offer),
        buyer_email, buyer_name: n.buyer_name, quantity: n.quantity, negotiation_id: n.id,
      });
      const text = result.status === 'accepted'
        ? `✅ Counter-offer accepted!\n\nProduct:      ${n.product_name}\nAgreed Price: $${n.counter_offer}/unit × ${n.quantity} = $${(n.counter_offer * n.quantity).toFixed(2)}\nOrder ID:     #${result.order_id}\n\nOrder placed and queued. Use track_order(${result.order_id}) to follow progress.`
        : `🔄 ${result.message}\n\n${result.next_steps}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}

// ── Express route handler factory ────────────────────────────

/**
 * Attach MCP HTTP endpoint to an Express app at the given path.
 * Each request gets its own transport+server pair (stateless HTTP).
 */
function attachMcpToExpress(app, path = '/mcp') {
  // Handle POST (client messages) and GET (SSE stream)
  app.all(path, async (req, res) => {
    try {
      const server    = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] Request error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'MCP server error' });
    }
  });

  console.log(`[MCP] Buyer MCP server mounted at ${path}`);
}

module.exports = { attachMcpToExpress };
