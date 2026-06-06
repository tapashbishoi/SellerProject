const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/inventory — all inventory with product info
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id AS product_id, p.name, p.category, p.unit, p.price,
           i.quantity, i.low_stock_threshold, i.updated_at,
      CASE
        WHEN i.quantity = 0 THEN 'out_of_stock'
        WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    ORDER BY p.name
  `);
  res.json(rows);
});

// PATCH /api/inventory/:productId — update stock quantity
router.patch('/:productId', async (req, res) => {
  const { quantity, low_stock_threshold } = req.body;
  if (quantity === undefined && low_stock_threshold === undefined)
    return res.status(400).json({ error: 'Provide quantity or low_stock_threshold' });

  const { rows } = await pool.query(
    `UPDATE inventory
     SET quantity = COALESCE($1, quantity),
         low_stock_threshold = COALESCE($2, low_stock_threshold),
         updated_at = NOW()
     WHERE product_id = $3
     RETURNING *`,
    [quantity, low_stock_threshold, req.params.productId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Inventory record not found' });
  res.json(rows[0]);
});

// POST /api/inventory/:productId/restock — add stock
router.post('/:productId/restock', async (req, res) => {
  const { add_quantity } = req.body;
  if (!add_quantity || add_quantity <= 0)
    return res.status(400).json({ error: 'add_quantity must be a positive number' });

  const { rows } = await pool.query(
    `UPDATE inventory
     SET quantity = quantity + $1, updated_at = NOW()
     WHERE product_id = $2
     RETURNING *`,
    [add_quantity, req.params.productId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Inventory record not found' });
  res.json(rows[0]);
});

module.exports = router;
