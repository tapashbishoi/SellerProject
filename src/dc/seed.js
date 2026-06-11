const pool = require('../db');

const DCS = [
  { dc_code:'US_EAST',    name:'US East DC',    address:'100 Commerce Blvd', city:'New York',    state:'NY', zip:'10001', country:'US' },
  { dc_code:'US_WEST',    name:'US West DC',    address:'200 Pacific Ave',   city:'Los Angeles', state:'CA', zip:'90001', country:'US' },
  { dc_code:'US_CENTRAL', name:'US Central DC', address:'300 Midway Dr',     city:'Chicago',     state:'IL', zip:'60601', country:'US' },
];

async function seedDCs() {
  for (const dc of DCS) {
    await pool.query(`
      INSERT INTO distribution_centers (dc_code, name, address, city, state, zip, country)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (dc_code) DO UPDATE SET
        name=EXCLUDED.name, city=EXCLUDED.city, state=EXCLUDED.state,
        zip=EXCLUDED.zip, is_active=true
    `, [dc.dc_code, dc.name, dc.address, dc.city, dc.state, dc.zip, dc.country]);
  }

  // Mirror existing global inventory into each DC (equal split for seed)
  const { rows: dcs } = await pool.query(`SELECT id FROM distribution_centers WHERE is_active=true`);
  const { rows: inv } = await pool.query(`SELECT product_id, quantity, low_stock_threshold FROM inventory`);

  for (const item of inv) {
    const splitQty = Math.floor(item.quantity / dcs.length);
    for (const dc of dcs) {
      await pool.query(`
        INSERT INTO dc_inventory (dc_id, product_id, quantity, low_stock_threshold)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (dc_id, product_id) DO NOTHING
      `, [dc.id, item.product_id, splitQty, item.low_stock_threshold]);
    }
  }

  console.log('[DC] Seeded 3 distribution centers and mirrored inventory');
}

module.exports = seedDCs;
