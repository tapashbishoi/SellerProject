require('dotenv').config();
const { connect, onReady, getMQStatus } = require('./connection');
const pool = require('../db');

async function processOrder(orderData) {
  const { messageId, payload } = orderData;
  const { buyer_name, buyer_email, buyer_phone, notes, items, staged_order_id } = payload;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Validate stock (lock rows)
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT p.name, i.quantity
         FROM products p JOIN inventory i ON i.product_id = p.id
         WHERE p.id = $1 FOR UPDATE`,
        [item.product_id]
      );
      if (!rows.length) throw new Error(`Product ID ${item.product_id} not found`);
      if (rows[0].quantity < item.quantity)
        throw new Error(`Insufficient stock for "${rows[0].name}". Requested: ${item.quantity}, Available: ${rows[0].quantity}`);
    }

    // 2. Upsert order row
    let orderId;
    if (staged_order_id) {
      // Clear any leftover items from a previous failed attempt
      await client.query(`DELETE FROM order_items WHERE order_id = $1`, [staged_order_id]);
      await client.query(
        `UPDATE orders SET status='pending', failure_reason=NULL, updated_at=NOW() WHERE id=$1`,
        [staged_order_id]
      );
      orderId = staged_order_id;
    } else {
      const { rows } = await client.query(
        `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, notes, status, mq_message_id)
         VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
        [buyer_name, buyer_email, buyer_phone, notes, messageId]
      );
      orderId = rows[0].id;
    }

    // 3. Insert items + deduct inventory
    let totalAmount = 0;
    for (const item of items) {
      const { rows: p } = await client.query(`SELECT price FROM products WHERE id=$1`, [item.product_id]);
      // Use negotiated_price if provided (from price negotiation), else use list price
      const unitPrice = item.negotiated_price ? parseFloat(item.negotiated_price) : parseFloat(p[0].price);
      totalAmount += unitPrice * item.quantity;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
        [orderId, item.product_id, item.quantity, unitPrice]
      );
      // Deduct from DC inventory if order has an assigned DC, else deduct from global
      const { rows: orderRow } = await client.query(`SELECT assigned_dc_id FROM orders WHERE id=$1`, [orderId]);
      const dcId = orderRow[0]?.assigned_dc_id;
      if (dcId) {
        await client.query(
          `UPDATE dc_inventory SET quantity = quantity - $1, updated_at = NOW()
           WHERE dc_id=$2 AND product_id=$3`,
          [item.quantity, dcId, item.product_id]
        );
      }
      // Always keep global inventory in sync
      await client.query(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }

    // 4. Confirm
    await client.query(
      `UPDATE orders SET total_amount=$1, status='confirmed', updated_at=NOW() WHERE id=$2`,
      [totalAmount, orderId]
    );
    await client.query('COMMIT');
    console.log(`[Consumer] ✅ Order #${orderId} confirmed — total $${totalAmount.toFixed(2)}`);
    return { success: true, orderId };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (payload.staged_order_id) {
      await pool.query(
        `UPDATE orders SET status='failed', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
        [err.message, payload.staged_order_id]
      ).catch(() => {});
    }
    console.error(`[Consumer] ❌ Order failed — ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    client.release();
  }
}

// Reset stuck pending/queued orders on startup and re-publish them
async function requeueStuckOrders() {
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_phone, o.notes,
             json_agg(json_build_object('product_id', oi.product_id, 'quantity', oi.quantity)) AS items
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status IN ('pending', 'queued')
      GROUP BY o.id`
    );

    if (!rows.length) return;

    const { publishOrder } = require('./publisher');
    console.log(`[Consumer] Found ${rows.length} stuck order(s) — re-queuing...`);

    for (const order of rows) {
      await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);
      await pool.query(`UPDATE orders SET status='queued', failure_reason=NULL, updated_at=NOW() WHERE id=$1`, [order.id]);
      await publishOrder({ staged_order_id: order.id, buyer_name: order.buyer_name, buyer_email: order.buyer_email, buyer_phone: order.buyer_phone, notes: order.notes, items: order.items });
      console.log(`[Consumer] Re-queued order #${order.id}`);
    }
  } catch (err) {
    console.error('[Consumer] requeueStuckOrders error:', err.message);
  }
}

// Called every time MQ connects (initial + after reconnect)
async function registerConsumer(channel) {
  await requeueStuckOrders();

  channel.consume(process.env.RABBITMQ_QUEUE || 'order_staging', async (msg) => {
    if (!msg) return;
    let orderData;
    try {
      orderData = JSON.parse(msg.content.toString());
      console.log(`[Consumer] Received messageId: ${orderData.messageId}`);
    } catch {
      console.error('[Consumer] Invalid JSON — discarding');
      channel.nack(msg, false, false);
      return;
    }
    const result = await processOrder(orderData);
    result.success ? channel.ack(msg) : channel.nack(msg, false, false);
  });

  console.log('[Consumer] Listening for orders...');
}

function startConsumer() {
  // Register handler — runs on initial connect AND every reconnect
  onReady(registerConsumer);
  // Kick off the connection (with auto-retry built in)
  connect();
}

module.exports = { startConsumer };
