// Black-Scholes (r = 0) price and implied-vol bisection. Twin of src/ivUtils.js — keep identical.
// Used by the Cosmic adapter to derive bid / ask IV from Cosmic's bid / ask prices.

function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export function bsPrice(spot, strike, T, vol, isCall) {
  if (!(T > 0) || !(vol > 0)) return isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return isCall
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
}

/** Implied vol in PERCENT, or null when unsolvable. Bisection on 1%–500%. */
export function impliedVol(price, spot, strike, T, isCall) {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(T > 0)) return null;
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const upper = isCall ? spot : strike;
  if (price <= intrinsic + 1e-9 || price >= upper) return null;
  let lo = 0.01, hi = 5;
  if (bsPrice(spot, strike, T, hi, isCall) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(spot, strike, T, mid, isCall) > price) hi = mid; else lo = mid;
  }
  return ((lo + hi) / 2) * 100;
}
