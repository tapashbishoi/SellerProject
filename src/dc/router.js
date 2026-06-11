const pool = require('../db');
const { getDCCodeForState, estimateShippingDays, estimateShippingCost } = require('./zones');

/**
 * Find the best DC to fulfill an order for a given shipping state.
 * Priority: 1) Nearest zone DC with full stock
 *           2) Any DC with full stock
 *           3) DC with most stock (partial — flag for review)
 */
async function routeOrderToDC(shippingState, items) {
  const preferredCode = getDCCodeForState(shippingState);

  // Load all active DCs ordered by preference (preferred first)
  const { rows: dcs } = await pool.query(`
    SELECT * FROM distribution_centers
    WHERE is_active = true
    ORDER BY CASE dc_code WHEN $1 THEN 0 ELSE 1 END, name
  `, [preferredCode]);

  if (!dcs.length) throw new Error('No active distribution centers found');

  // Check stock at each DC
  for (const dc of dcs) {
    const canFulfill = await checkDCStock(dc.id, items);
    if (canFulfill.ok) {
      return {
        dc,
        shipping_days:  estimateShippingDays(dc.dc_code, shippingState),
        shipping_cost:  estimateShippingCost(dc.dc_code, shippingState, items.reduce((s,i) => s + i.quantity, 0)),
        is_preferred:   dc.dc_code === preferredCode,
        stock_check:    canFulfill,
      };
    }
  }

  // No DC has full stock — return the one with most coverage
  const { dc, stockCheck } = await getBestPartialDC(dcs, items);
  return {
    dc,
    shipping_days:    estimateShippingDays(dc.dc_code, shippingState),
    shipping_cost:    estimateShippingCost(dc.dc_code, shippingState, items.reduce((s,i) => s + i.quantity, 0)),
    is_preferred:     dc.dc_code === preferredCode,
    stock_check:      stockCheck,
    partial:          true,
  };
}

async function checkDCStock(dcId, items) {
  const issues = [];
  for (const item of items) {
    const { rows } = await pool.query(
      `SELECT quantity FROM dc_inventory WHERE dc_id=$1 AND product_id=$2`,
      [dcId, item.product_id]
    );
    const available = rows[0]?.quantity || 0;
    if (available < item.quantity) {
      issues.push({ product_id: item.product_id, requested: item.quantity, available });
    }
  }
  return { ok: issues.length === 0, issues };
}

async function getBestPartialDC(dcs, items) {
  let best = null, bestCoverage = -1;
  for (const dc of dcs) {
    const check = await checkDCStock(dc.id, items);
    const coverage = items.length - check.issues.length;
    if (coverage > bestCoverage) { bestCoverage = coverage; best = { dc, stockCheck: check }; }
  }
  return best;
}

/**
 * Get DC stock summary for a product across all DCs
 */
async function getProductDCStock(productId) {
  const { rows } = await pool.query(`
    SELECT dc.name, dc.dc_code, dc.city, dc.state,
           COALESCE(i.quantity, 0) AS quantity,
           COALESCE(i.low_stock_threshold, 10) AS low_stock_threshold,
           CASE
             WHEN COALESCE(i.quantity,0) = 0 THEN 'out_of_stock'
             WHEN COALESCE(i.quantity,0) <= COALESCE(i.low_stock_threshold,10) THEN 'low_stock'
             ELSE 'in_stock'
           END AS stock_status
    FROM distribution_centers dc
    LEFT JOIN dc_inventory i ON i.dc_id = dc.id AND i.product_id = $1
    WHERE dc.is_active = true
    ORDER BY dc.dc_code
  `, [productId]);
  return rows;
}

module.exports = { routeOrderToDC, checkDCStock, getProductDCStock };
