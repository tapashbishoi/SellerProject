const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { getDCCodeForState } = require('../dc/zones');

// GET /api/buyers/:email
router.get('/:email', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, dc.name AS preferred_dc_name, dc.dc_code, dc.city AS dc_city
     FROM buyer_profiles b
     LEFT JOIN distribution_centers dc ON dc.id = b.preferred_dc_id
     WHERE LOWER(b.buyer_email) = LOWER($1)`,
    [req.params.email]
  );
  if (!rows.length) return res.status(404).json({ error: 'Buyer profile not found' });
  res.json(rows[0]);
});

// POST /api/buyers — create or update buyer profile
router.post('/', async (req, res) => {
  const { buyer_email, buyer_name, company_name,
          shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country = 'US' } = req.body;

  if (!buyer_email) return res.status(400).json({ error: 'buyer_email is required' });

  // Determine preferred DC from shipping state
  let preferred_dc_id = null;
  if (shipping_state) {
    const dcCode = getDCCodeForState(shipping_state);
    const { rows } = await pool.query(`SELECT id FROM distribution_centers WHERE dc_code=$1`, [dcCode]);
    if (rows.length) preferred_dc_id = rows[0].id;
  }

  const { rows } = await pool.query(`
    INSERT INTO buyer_profiles
      (buyer_email, buyer_name, company_name, shipping_street, shipping_city,
       shipping_state, shipping_zip, shipping_country, preferred_dc_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (buyer_email) DO UPDATE SET
      buyer_name       = COALESCE(EXCLUDED.buyer_name, buyer_profiles.buyer_name),
      company_name     = COALESCE(EXCLUDED.company_name, buyer_profiles.company_name),
      shipping_street  = COALESCE(EXCLUDED.shipping_street, buyer_profiles.shipping_street),
      shipping_city    = COALESCE(EXCLUDED.shipping_city, buyer_profiles.shipping_city),
      shipping_state   = COALESCE(EXCLUDED.shipping_state, buyer_profiles.shipping_state),
      shipping_zip     = COALESCE(EXCLUDED.shipping_zip, buyer_profiles.shipping_zip),
      shipping_country = COALESCE(EXCLUDED.shipping_country, buyer_profiles.shipping_country),
      preferred_dc_id  = COALESCE(EXCLUDED.preferred_dc_id, buyer_profiles.preferred_dc_id),
      updated_at       = NOW()
    RETURNING *
  `, [buyer_email, buyer_name, company_name, shipping_street, shipping_city,
      shipping_state, shipping_zip, shipping_country, preferred_dc_id]);

  // Load DC name for response
  const profile = rows[0];
  if (profile.preferred_dc_id) {
    const { rows: dc } = await pool.query(
      `SELECT name, dc_code, city FROM distribution_centers WHERE id=$1`, [profile.preferred_dc_id]
    );
    if (dc.length) { profile.preferred_dc_name = dc[0].name; profile.dc_code = dc[0].dc_code; profile.dc_city = dc[0].city; }
  }

  res.status(201).json(profile);
});

module.exports = router;
