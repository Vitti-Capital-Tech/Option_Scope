export function formatTime(d) {
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true
  }).format(d);
}

/**
 * Short-leg leverage, per underlying — the browser-side twin of engine/lib/utils.js's
 * leverageFor(). ETH sits at 100x where BTC sits at 200x, so the same short notional costs
 * an ETH account twice the margin. Both copies must move together: the scanner's displayed
 * margin/ROI is the number a user checks the engine's decision against.
 *
 * Accepts either the underlying code ('ETH') or a full Delta symbol ('C-ETH-2800-030926').
 * The $195,000 short-notional cap is NOT per-underlying — it stays the same for both.
 */
export function leverageFor(underlyingOrSymbol) {
  return /ETH/i.test(String(underlyingOrSymbol ?? '')) ? 100 : 200;
}

/**
 * Hedge (3rd long) strike for a ratio spread. Among quoted strikes BEYOND the short on the
 * same side (call: above it, put: below it), keep those whose price is below `maxPrice`
 * and whose IV differs from the short's IV by an amount inside [ivMin, ivMax]
 * (|hedge IV − short IV|), then pick the one NEAREST the short (the most protective).
 * `candidates` are same-type, same-expiry tickers the caller has already filtered (not
 * excluded, not the spread's own legs). Price = ask (fallback last / mark), IV = ask IV
 * (fallback iv). Returns the ticker, or null if none qualifies (→ with Hedge on, the spread is dropped / not entered).
 *
 * Twin of engine/lib/utils.js pickHedgeStrike — keep the two identical.
 */
export function pickHedgeStrike(candidates, type, sellStrike, sellIv, { maxPrice = 10, ivMin = 0, ivMax = 2 } = {}) {
  const isCall = String(type).toLowerCase() === 'call';
  const short = Number(sellStrike);
  const shortIv = Number(sellIv);
  if (!Number.isFinite(short) || !Number.isFinite(shortIv)) return null;
  let best = null;
  for (const t of candidates || []) {
    const k = Number(t?.strike);
    if (!Number.isFinite(k)) continue;
    if (isCall ? !(k > short) : !(k < short)) continue;
    const px = Number(t.ask ?? t.lastPrice ?? t.markPrice);
    if (!(px > 0) || !(px < maxPrice)) continue;
    const iv = Number(t.askIv ?? t.iv);
    if (!Number.isFinite(iv)) continue;
    const ivDiff = Math.abs(iv - shortIv);
    if (ivDiff < ivMin || ivDiff > ivMax) continue;
    if (best == null || Math.abs(k - short) < Math.abs(Number(best.strike) - short)) best = t;
  }
  return best;
}


/**
 * Every qualifying hedge (3rd long) strike for a ratio spread, nearest the short first.
 * Range: strikes BEYOND the short on the same side (call: above, put: below) from one strike
 * step away up to (strike width − one strike step) away — e.g. BTC (200-pt steps) 80000/81000
 * → 81200, 81400, 81600, 81800. The step is the smallest gap between the candidates' listed
 * strikes. Each must also have price (ask, fallback last / mark) below `maxPrice` and
 * |IV (ask IV, fallback iv) − short IV| inside [ivMin, ivMax]. Returns [] when none qualify.
 * Callers pick among them (best ATM P&L / ROI). Twin of engine/lib/utils.js listHedgeStrikes — keep identical.
 */
export function listHedgeStrikes(candidates, type, sellStrike, sellIv, strikeDiff, { maxPrice = 10, ivMin = 0, ivMax = 2 } = {}) {
  const isCall = String(type).toLowerCase() === 'call';
  const short = Number(sellStrike);
  const shortIv = Number(sellIv);
  const width = Math.abs(Number(strikeDiff));
  if (!Number.isFinite(short) || !Number.isFinite(shortIv) || !(width > 0)) return [];
  const strikes = [...new Set((candidates || []).map(t => Number(t?.strike)).filter(Number.isFinite))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const g = strikes[i] - strikes[i - 1];
    if (g > 0 && g < step) step = g;
  }
  if (!Number.isFinite(step)) return [];
  const maxDist = width - step;
  const out = [];
  for (const t of candidates || []) {
    const k = Number(t?.strike);
    if (!Number.isFinite(k)) continue;
    if (isCall ? !(k > short) : !(k < short)) continue;
    const dist = Math.abs(k - short);
    if (dist > maxDist + 1e-9) continue;
    const px = Number(t.ask ?? t.lastPrice ?? t.markPrice);
    if (!(px > 0) || !(px < maxPrice)) continue;
    const iv = Number(t.askIv ?? t.iv);
    if (!Number.isFinite(iv)) continue;
    const ivDiff = Math.abs(iv - shortIv);
    if (ivDiff < ivMin || ivDiff > ivMax) continue;
    out.push(t);
  }
  return out.sort((a, b) => Math.abs(Number(a.strike) - short) - Math.abs(Number(b.strike) - short));
}

export function normalizeIv(iv) {
  if (!Number.isFinite(iv)) return null;
  return iv <= 1 ? iv * 100 : iv;
}

export function toFiniteNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function matchesOptionType(product, optionType) {
  const wanted = optionType === 'call' ? 'call_options' : 'put_options';
  return product?.contract_type === wanted
    || product?.contract_types === wanted
    || (optionType === 'call' ? /^C-/.test(product?.symbol || '') : /^P-/.test(product?.symbol || ''));
}
