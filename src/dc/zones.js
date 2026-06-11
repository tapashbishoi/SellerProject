/**
 * US state → DC zone mapping
 * Each state maps to the DC code that should fulfill orders for it.
 */
const STATE_TO_DC = {
  // US East
  CT:'US_EAST', DE:'US_EAST', FL:'US_EAST', GA:'US_EAST',
  MA:'US_EAST', MD:'US_EAST', ME:'US_EAST', NC:'US_EAST',
  NH:'US_EAST', NJ:'US_EAST', NY:'US_EAST', PA:'US_EAST',
  RI:'US_EAST', SC:'US_EAST', VA:'US_EAST', VT:'US_EAST',
  WV:'US_EAST', DC:'US_EAST',

  // US West
  AK:'US_WEST', AZ:'US_WEST', CA:'US_WEST', HI:'US_WEST',
  ID:'US_WEST', MT:'US_WEST', NV:'US_WEST', OR:'US_WEST',
  UT:'US_WEST', WA:'US_WEST', WY:'US_WEST',

  // US Central (everything else)
  AL:'US_CENTRAL', AR:'US_CENTRAL', CO:'US_CENTRAL', IA:'US_CENTRAL',
  IL:'US_CENTRAL', IN:'US_CENTRAL', KS:'US_CENTRAL', KY:'US_CENTRAL',
  LA:'US_CENTRAL', MI:'US_CENTRAL', MN:'US_CENTRAL', MO:'US_CENTRAL',
  MS:'US_CENTRAL', ND:'US_CENTRAL', NE:'US_CENTRAL', NM:'US_CENTRAL',
  OH:'US_CENTRAL', OK:'US_CENTRAL', SD:'US_CENTRAL', TN:'US_CENTRAL',
  TX:'US_CENTRAL', WI:'US_CENTRAL',
};

const SHIPPING_DAYS = {
  same_zone:  '1-2',
  one_zone:   '3-4',
  two_zones:  '5-6',
};

const ZONE_ORDER = ['US_EAST', 'US_CENTRAL', 'US_WEST'];

function getDCCodeForState(state) {
  return STATE_TO_DC[state?.toUpperCase()] || 'US_CENTRAL';
}

function estimateShippingDays(dcCode, buyerState) {
  const buyerZone = getDCCodeForState(buyerState);
  const dcIdx     = ZONE_ORDER.indexOf(dcCode);
  const buyerIdx  = ZONE_ORDER.indexOf(buyerZone);
  const diff      = Math.abs(dcIdx - buyerIdx);
  if (diff === 0) return SHIPPING_DAYS.same_zone;
  if (diff === 1) return SHIPPING_DAYS.one_zone;
  return SHIPPING_DAYS.two_zones;
}

function estimateShippingCost(dcCode, buyerState, totalUnits) {
  const days = estimateShippingDays(dcCode, buyerState);
  const base = days === SHIPPING_DAYS.same_zone ? 6 :
               days === SHIPPING_DAYS.one_zone  ? 12 : 22;
  // Volume discount
  const multiplier = totalUnits > 100 ? 1.5 : totalUnits > 50 ? 1.2 : 1;
  return parseFloat((base * multiplier).toFixed(2));
}

module.exports = { getDCCodeForState, estimateShippingDays, estimateShippingCost, ZONE_ORDER };
