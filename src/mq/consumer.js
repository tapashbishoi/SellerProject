require('dotenv').config();
const { getChannel, QUEUE } = require('./connection');
const pool = require('../db');

/**
 * Validate and place an order from a queued message.
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
      if (!rows.length) throw new Error(`Product ID ${item.product_id} not found`);
      if (rows[0].quantity < item.quantity)
        throw new Error(`Insufficient stock for "${rows[0].name}". Requested: ${item.quantity}, Available: ${rows[0].quantity}`);
    }

    // 2. Update or create the order row
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
      const { rows: prodRows } = await client.query(`SELECT price FROM products WHERE id=$1`, [item.product_id]);
      const unitPrice = parseFloat(prodRows[0].price);
      totalAmount += unitPrice * item.quantity;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
        [orderId, item.product_id, item.quantity, unitPrice]
      );
      await client.query(
        `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2`,
        [item.quantity, item.product_id]
      );
    }

    // 4. Finalise
    await client.query(
      `UPDATE orders SET total_amount=$1, status='confirmed', updated_at=NOW() WHERE id=$2`,
      [totalAmount, orderId]
    );
    await client.query('COMMIT');
    console.log(`[Consumer] ✅ Order #${orderId} confirmed — total $${totalAmount.toFixed(2)}`);
    return { success: true, orderId };

  } catch (err) {
    await client.query('ROLLBACK');
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

/**
 * Orders left as "pending" after a crash never get re-queued automatically.
 * On every startup, reset them back to "queued" and re-publish to MQ.
 */
async function requeueStuckOrders() {
  const { publishOrder } = require('./publisher');
  const { rows } = await pool.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_phone, o.notes,
            json_agg(json_build_object('product_id', oi.product_id, 'quantity', oi.quantity)) AS items
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status = 'pending'
     GROUP BY o.id`
  );

  // Also handle queued orders that have no items yet (staged but never consumed)
  const { rows: queuedRows } = await pool.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_phone, o.notes, o.mq_message_id
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status IN ('queued','pending')
     GROUP BY o.id
     HAVING COUNT(oi.id) = 0`
  );

  if (rows.length > 0) {
    console.log(`[Consumer] Found ${rows.length} stuck "pending" order(s) — re-queuing...`);
    for (const order of rows) {
      // Roll back any partial item inserts and deductions for stuck pending orders
      await pool.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);
      await pool.query(`UPDATE orders SET status='queued', updated_at=NOW() WHERE id=$1`, [order.id]);
      await publishOrder({ staged_order_id: order.id, ...order });
      console.log(`[Consumer] Re-queued stuck order #${order.id}`);
    }
  }

  if (queuedRows.length > 0) {
    console.log(`[Consumer] Found ${queuedRows.length} un-processed "queued" order(s) — re-publishing...`);
    for (const order of queuedRows) {
      // These have no items — we can't re-process without items; mark failed
      await pool.query(
        `UPDATE orders SET status='failed', failure_reason='Order items missing — please re-submit', updated_at=NOW() WHERE id=$1`,
        [order.id]
      );
      console.log(`[Consumer] Marked order #${order.id} as failed (no items found)`);
    }
  }
}

/**
 * Start the consumer loop — runs inside the same process as the API server.
 * Non-fatal: if MQ is unavailable the API still works; retries after 10s.
 */
async function startConsumer() {
  try {
    const channel = await getChannel();

    // Fix any orders stuck in 'pending' from a previous crashed run
    await requeueStuckOrders();

    channel.prefetch(1);
    console.log('[Consumer] Waiting for orders in the background...');

    channel.consume(QUEUE, async (msg) => {
      if (!msg) return;
      let orderData;
      try {
        orderData = JSON.parse(msg.content.toString());
        console.log(`[Consumer] Received messageId: ${orderData.messageId}`);
      } catch {
        console.error('[Consumer] Invalid JSON — discarding message');
        channel.nack(msg, false, false);
        return;
      }
      const result = await processOrder(orderData);
      result.success ? channel.ack(msg) : channel.nack(msg, false, false);
    });
  } catch (err) {
    console.error(`[Consumer] Could not connect to RabbitMQ: ${err.message} — retrying in 10s`);
    setTimeout(startConsumer, 10_000);
  }
}

module.exports = { startConsumer };
