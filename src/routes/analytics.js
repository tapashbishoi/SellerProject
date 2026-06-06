const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/analytics/channels — channel breakdown + negotiation stats
router.get('/channels', async (req, res) => {
  const { rows: channelStats } = await pool.query(`
    SELECT
      channel,
      COUNT(*)                                                      AS total_orders,
      COUNT(*) FILTER (WHERE status = 'confirmed')                  AS confirmed,
      COUNT(*) FILTER (WHERE status IN ('cancelled','rejected'))    AS cancelled,
      COUNT(*) FILTER (WHERE status = 'failed')                     AS failed,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rejected','failed')), 0) AS revenue
    FROM orders
    GROUP BY channel
    ORDER BY revenue DESC
  `);

  const { rows: negStats } = await pool.query(`
    SELECT
      COUNT(*)                                         AS total_negotiations,
      COUNT(*) FILTER (WHERE status = 'accepted')      AS accepted,
      COUNT(*) FILTER (WHERE status = 'countered')     AS countered,
      COUNT(*) FILTER (WHERE status = 'rejected')      AS rejected,
      ROUND(AVG(
        CASE WHEN status = 'accepted'
        THEN ((list_price - buyer_offer) / list_price * 100) END
      ), 1)                                            AS avg_discount_pct,
      COALESCE(SUM(
        CASE WHEN status = 'accepted' THEN buyer_offer * quantity END
      ), 0)                                            AS negotiated_revenue
    FROM negotiations
  `);

  const { rows: dailyTrend } = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      channel,
      COUNT(*)         AS orders,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rejected','failed')), 0) AS revenue
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at), channel
    ORDER BY date DESC, channel
  `);

  const { rows: topProducts } = await pool.query(`
    SELECT p.name, o.channel,
      SUM(oi.quantity)              AS units_sold,
      SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    JOIN orders   o ON o.id  = oi.order_id
    JOIN products p ON p.id  = oi.product_id
    WHERE o.status NOT IN ('cancelled','rejected','failed')
    GROUP BY p.name, o.channel
    ORDER BY revenue DESC
    LIMIT 20
  `);

  res.json({ channelStats, negStats: negStats[0], dailyTrend, topProducts });
});

// GET /api/analytics/negotiations — full negotiation history
router.get('/negotiations', async (req, res) => {
  const { status, limit = 50 } = req.query;
  let query = `
    SELECT
      n.id, n.status, n.round,
      p.name        AS product_name,
      p.price       AS list_price,
      n.floor_price,
      n.buyer_email, n.buyer_name,
      n.quantity,
      n.buyer_offer,
      n.counter_offer,
      ROUND(((n.list_price - n.buyer_offer) / n.list_price * 100), 1) AS discount_requested_pct,
      CASE WHEN n.status = 'accepted'
        THEN ROUND(((n.list_price - n.buyer_offer) / n.list_price * 100), 1)
      END                                                              AS discount_given_pct,
      n.ai_message,
      n.order_id,
      n.created_at,
      n.updated_at
    FROM negotiations n
    JOIN products p ON p.id = n.product_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { params.push(status); query += ` AND n.status = $${params.length}`; }
  query += ` ORDER BY n.updated_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// PATCH /api/analytics/orders/:id/reject — seller rejects an order with reason
router.patch('/orders/:id/reject', async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    if (['cancelled','rejected','delivered'].includes(rows[0].status))
      return res.status(400).json({ error: `Cannot reject an order with status: ${rows[0].status}` });

    // Restore inventory
    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id=$1', [req.params.id]
    );
    for (const item of items) {
      await client.query(
        'UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE product_id = $2',
        [item.quantity, item.product_id]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE orders SET status='rejected', failure_reason=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [reason, req.params.id]
    );
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
});

module.exports = router;
