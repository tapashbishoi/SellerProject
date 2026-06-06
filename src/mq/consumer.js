require('dotenv').config();
const { getChannel, QUEUE } = require('./connection');
const pool = require('../db');
const initSchema = require('../schema');

/**
 * Validate and place an order from a queued message.
 * This is the worker process — run separately: node src/mq/consumer.js
 */
async function processOrder(orderData) {
  const { messageId, payload } = orderData;
  const { buyer_name, buyer_email, buyer_phone, notes, items, staged_order_id } = payload;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Validate every item has enough stock (lock rows)
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT p.name, i.quantity
         FROM products p
         JOIN inventory i ON i.product_id = p.id
         WHERE p.id = $1 FOR UPDATE`,
        [item.product_id]
      );

      if (!rows.length) {
        throw new Error(`Product ID ${item.product_id} not found`);
      }
      if (rows[0].quantity < item.quantity) {
        throw new Error(
          `Insufficient stock for "${rows[0].name}". Requested: ${item.quantity}, Available: ${rows[0].quantity}`
        );
      }
    }

    // 2. If staged_order_id exists (pre-created row), update it; else create fresh
    let orderId;
    if (staged_order_id) {
      await client.query(
        `UPDATE orders SET status='pending', updated_at=NOW(), failure_reason=NULL WHERE id=$1`,
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

    // 3. Insert order items + deduct inventory
    let totalAmount = 0;
    for (const item of items) {
      const { rows: prodRows } = await client.query(
        `SELECT price FROM products WHERE id=$1`, [item.product_id]
      );
      const unitPrice = parseFloat(prodRows[0].price);
      totalAmount += unitPrice * item.quantity;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
         VALUES ($1,$2,$3,$4)`,
        [orderId, item.product_id, item.quantity, unitPrice]
      );

      await client.query(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }

    // 4. Finalise total
    await client.query(
      `UPDATE orders SET total_amount=$1, status='confirmed', updated_at=NOW() WHERE id=$2`,
      [totalAmount, orderId]
    );

    await client.query('COMMIT');
    console.log(`[Consumer] ✅ Order #${orderId} confirmed — total $${totalAmount.toFixed(2)}`);
    return { success: true, orderId, totalAmount };

  } catch (err) {
    await client.query('ROLLBACK');

    // Mark the staged row as failed if we have one
    if (payload.staged_order_id) {
      await pool.query(
        `UPDATE orders SET status='failed', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
        [err.message, payload.staged_order_id]
      );
    }

    console.error(`[Consumer] ❌ Order failed — ${err.message}`);
    return { success: false, error: err.message };

  } finally {
    client.release();
  }
}

async function startConsumer() {
  await initSchema();
  const channel = await getChannel();

  // Process one message at a time (fair dispatch)
  channel.prefetch(1);

  console.log('[Consumer] Waiting for orders...');

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    let orderData;
    try {
      orderData = JSON.parse(msg.content.toString());
      console.log(`[Consumer] Received messageId: ${orderData.messageId}`);
    } catch {
      console.error('[Consumer] Invalid JSON — rejecting message');
      channel.nack(msg, false, false); // discard
      return;
    }

    const result = await processOrder(orderData);

    if (result.success) {
      channel.ack(msg);                  // remove from queue
    } else {
      // Reject without requeue — bad orders shouldn't loop forever
      channel.nack(msg, false, false);
    }
  });
}

startConsumer().catch(err => {
  console.error('[Consumer] Fatal error:', err);
  process.exit(1);
});
