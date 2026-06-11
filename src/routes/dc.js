const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/dc — list all DCs with order + inventory summary
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      dc.*,
      COUNT(DISTINCT o.id)  FILTER (WHERE o.status NOT IN ('cancelled','rejected','failed')) AS active_orders,
      COUNT(DISTINCT o.id)  FILTER (WHERE o.status = 'confirmed')                            AS confirmed_orders,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.status NOT IN ('cancelled','rejected','failed')), 0) AS total_revenue,
      COALESCE(SUM(i.quantity), 0) AS total_stock_units
    FROM distribution_centers dc
    LEFT JOIN orders     o ON o.assigned_dc_id = dc.id
    LEFT JOIN dc_inventory i ON i.dc_id = dc.id
    GROUP BY dc.id
    ORDER BY dc.dc_code
  `);
  res.json(rows);
});

// GET /api/dc/:id/inventory — inventory at a specific DC
router.get('/:id/inventory', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.id AS product_id, p.name, p.category, p.unit, p.price,
      COALESCE(i.quantity, 0)              AS quantity,
      COALESCE(i.low_stock_threshold, 10)  AS low_stock_threshold,
      i.updated_at,
      CASE
        WHEN COALESCE(i.quantity,0) = 0                              THEN 'out_of_stock'
        WHEN COALESCE(i.quantity,0) <= COALESCE(i.low_stock_threshold,10) THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM products p
    LEFT JOIN dc_inventory i ON i.product_id = p.id AND i.dc_id = $1
    ORDER BY p.name
  `, [req.params.id]);
  res.json(rows);
});

// PATCH /api/dc/:dcId/inventory/:productId — update stock at a DC
router.patch('/:dcId/inventory/:productId', async (req, res) => {
  const { quantity, low_stock_threshold } = req.body;
  const { rows } = await pool.query(`
    INSERT INTO dc_inventory (dc_id, product_id, quantity, low_stock_threshold)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (dc_id, product_id) DO UPDATE SET
      quantity            = COALESCE($3, dc_inventory.quantity),
      low_stock_threshold = COALESCE($4, dc_inventory.low_stock_threshold),
      updated_at          = NOW()
    RETURNING *
  `, [req.params.dcId, req.params.productId, quantity ?? null, low_stock_threshold ?? null]);
  res.json(rows[0]);
});

// GET /api/dc/orders — orders grouped by DC
router.get('/orders/by-dc', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      dc.id AS dc_id, dc.name AS dc_name, dc.city, dc.state, dc.dc_code,
      o.id, o.buyer_name, o.buyer_email, o.status, o.total_amount,
      o.shipping_city, o.shipping_state, o.shipping_days, o.shipping_cost,
      o.channel, o.created_at
    FROM orders o
    JOIN distribution_centers dc ON dc.id = o.assigned_dc_id
    ORDER BY dc.dc_code, o.created_at DESC
    LIMIT 200
  `);
  res.json(rows);
});

module.exports = router;
