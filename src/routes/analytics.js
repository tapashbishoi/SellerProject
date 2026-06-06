const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/analytics/channels — full channel breakdown
router.get('/channels', async (req, res) => {
  const { rows: channelStats } = await pool.query(`
    SELECT
      channel,
      COUNT(*)                                                      AS total_orders,
      COUNT(*) FILTER (WHERE status = 'confirmed')                  AS confirmed,
      COUNT(*) FILTER (WHERE status = 'cancelled')                  AS cancelled,
      COUNT(*) FILTER (WHERE status = 'failed')                     AS failed,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','failed')), 0) AS revenue
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
        THEN ((list_price - buyer_offer) / list_price * 100)
        END
      ), 1)                                            AS avg_discount_pct,
      COALESCE(SUM(
        CASE WHEN status = 'accepted' THEN buyer_offer * quantity END
      ), 0)                                            AS negotiated_revenue
    FROM negotiations
  `);

  const { rows: dailyTrend } = await pool.query(`
    SELECT
      DATE(created_at)          AS date,
      channel,
      COUNT(*)                  AS orders,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','failed')), 0) AS revenue
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at), channel
    ORDER BY date DESC, channel
  `);

  const { rows: topProducts } = await pool.query(`
    SELECT
      p.name,
      o.channel,
      SUM(oi.quantity)                     AS units_sold,
      SUM(oi.quantity * oi.unit_price)     AS revenue
    FROM order_items oi
    JOIN orders  o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.status NOT IN ('cancelled','failed')
    GROUP BY p.name, o.channel
    ORDER BY revenue DESC
    LIMIT 20
  `);

  res.json({ channelStats, negStats: negStats[0], dailyTrend, topProducts });
});

module.exports = router;
