const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/products — list catalogue with inventory status
router.get('/', async (req, res) => {
  const { category, search } = req.query;
  let query = `
    SELECT p.*, i.quantity, i.low_stock_threshold,
      CASE
        WHEN i.quantity = 0 THEN 'out_of_stock'
        WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (category) { params.push(category); query += ` AND p.category = $${params.length}`; }
  if (search)   { params.push(`%${search}%`); query += ` AND p.name ILIKE $${params.length}`; }
  query += ' ORDER BY p.name';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, i.quantity, i.low_stock_threshold,
      CASE
        WHEN i.quantity = 0 THEN 'out_of_stock'
        WHEN i.quantity <= i.low_stock_threshold THEN 'low_stock'
        ELSE 'in_stock'
      END AS stock_status
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.id = $1
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
});

// POST /api/products — create product + initial inventory
router.post('/', async (req, res) => {
  const { name, description, category, unit, price, initial_quantity = 0, low_stock_threshold = 10 } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'name and price are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (name, description, category, unit, price) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, description, category, unit || 'piece', price]
    );
    const product = rows[0];
    await client.query(
      `INSERT INTO inventory (product_id, quantity, low_stock_threshold) VALUES ($1,$2,$3)`,
      [product.id, initial_quantity, low_stock_threshold]
    );
    await client.query('COMMIT');
    res.status(201).json({ ...product, quantity: initial_quantity, low_stock_threshold });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// PUT /api/products/:id — update product details
router.put('/:id', async (req, res) => {
  const { name, description, category, unit, price } = req.body;
  const { rows } = await pool.query(
    `UPDATE products SET name=COALESCE($1,name), description=COALESCE($2,description),
      category=COALESCE($3,category), unit=COALESCE($4,unit), price=COALESCE($5,price)
     WHERE id=$6 RETURNING *`,
    [name, description, category, unit, price, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.json({ message: 'Product deleted' });
});

module.exports = router;
