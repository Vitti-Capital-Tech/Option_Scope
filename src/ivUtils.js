// Black-Scholes pricing and implied-vol inversion for Delta options (European, cash-settled
// on the spot index, r = 0, no carry). Used by the IV Analysis tab to turn Delta's public
// MARK price candles back into IV: Delta's mark price is built from its mark IV, so the
// inversion reproduces Delta's mark_vol to within ~0.05 IV points (checked 2026-11-17
// across 30 BTC strikes, calls and puts).

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf, |error| < 1.5e-7).
function normCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Black-Scholes price, r = 0. `T` in years, `vol` as a fraction (0.45 = 45%). */
export function bsPrice(spot, strike, T, vol, isCall) {
  if (!(T > 0) || !(vol > 0)) return isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const sd = vol * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return isCall
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Implied vol in PERCENT from an option price, or null when it can't be solved (price at or
 * below intrinsic, above the no-arbitrage bound, or expiry passed). Bisection on 1%–500%.
 */
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

/** Years from `atMs` to the settlement time `expiryIso`. */
export function yearsToExpiry(expiryIso, atMs) {
  return (new Date(expiryIso).getTime() - atMs) / YEAR_MS;
}
