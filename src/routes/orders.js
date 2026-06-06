const express = require('express');
const router = express.Router();
const pool = require('../db');
const { publishOrder } = require('../mq/publisher');

// POST /api/orders/stage — buyer submits order → goes to RabbitMQ for validation
router.post('/stage', async (req, res) => {
  const { buyer_name, buyer_email, buyer_phone, notes, items } = req.body;

  if (!buyer_name || !items || !items.length)
    return res.status(400).json({ error: 'buyer_name and items[] are required' });

  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity < 1)
      return res.status(400).json({ error: 'Each item needs product_id and quantity >= 1' });
  }

  // Pre-create a "queued" order row so the buyer gets an ID immediately
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, notes, status)
     VALUES ($1,$2,$3,$4,'queued') RETURNING id, created_at`,
    [buyer_name, buyer_email, buyer_phone, notes]
  );
  const stagedOrder = rows[0];

  // Publish to RabbitMQ
  const messageId = await publishOrder({
    staged_order_id: stagedOrder.id,
    buyer_name, buyer_email, buyer_phone, notes, items,
  });

  // Store the messageId back on the order row
  await pool.query(`UPDATE orders SET mq_message_id=$1 WHERE id=$2`, [messageId, stagedOrder.id]);

  res.status(202).json({
    message:    'Order received and queued for processing',
    order_id:   stagedOrder.id,
    status:     'queued',
    message_id: messageId,
    created_at: stagedOrder.created_at,
    tip:        `Poll GET /api/orders/${stagedOrder.id} to check when status changes to confirmed or failed`,
  });
});

// GET /api/orders — list all orders
router.get('/', async (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT o.*,
      json_agg(json_build_object(
        'product_id', oi.product_id,
        'product_name', p.name,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'subtotal', oi.quantity * oi.unit_price
      )) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { params.push(status); query += ` AND o.status = $${params.length}`; }
  query += ' GROUP BY o.id ORDER BY o.created_at DESC';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*,
      json_agg(json_build_object(
        'product_id', oi.product_id,
        'product_name', p.name,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'subtotal', oi.quantity * oi.unit_price
      )) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.id = $1
    GROUP BY o.id
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json(rows[0]);
});

// POST /api/orders — place a new order (auto-deducts inventory)
router.post('/', async (req, res) => {
  const { buyer_name, buyer_email, buyer_phone, notes, items } = req.body;
  if (!buyer_name || !items || !items.length)
    return res.status(400).json({ error: 'buyer_name and items[] are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate stock for each item
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT p.name, i.quantity FROM products p JOIN inventory i ON i.product_id = p.id WHERE p.id = $1 FOR UPDATE`,
        [item.product_id]
      );
      if (!rows.length) throw { status: 404, message: `Product ${item.product_id} not found` };
      if (rows[0].quantity < item.quantity)
        throw { status: 409, message: `Insufficient stock for "${rows[0].name}". Available: ${rows[0].quantity}` };
    }

    // Create order
    const orderRes = await client.query(
      `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [buyer_name, buyer_email, buyer_phone, notes]
    );
    const order = orderRes.rows[0];

    let totalAmount = 0;
    const insertedItems = [];

    for (const item of items) {
      const { rows: prodRows } = await client.query(`SELECT price FROM products WHERE id=$1`, [item.product_id]);
      const unitPrice = prodRows[0].price;
      totalAmount += unitPrice * item.quantity;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
        [order.id, item.product_id, item.quantity, unitPrice]
      );

      // Deduct inventory
      await client.query(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );

      insertedItems.push({ product_id: item.product_id, quantity: item.quantity, unit_price: unitPrice });
    }

    // Update total
    await client.query(`UPDATE orders SET total_amount=$1 WHERE id=$2`, [totalAmount, order.id]);

    await client.query('COMMIT');
    res.status(201).json({ ...order, total_amount: totalAmount, items: insertedItems });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally {
    client.release();
  }
});

// PATCH /api/orders/:id/status — update order status
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Order not found' });

    // If cancelling, restore inventory
    if (status === 'cancelled' && existing[0].status !== 'cancelled') {
      const { rows: items } = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id=$1', [req.params.id]
      );
      for (const item of items) {
        await client.query(
          `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE product_id = $2`,
          [item.quantity, item.product_id]
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

module.exports = router;
