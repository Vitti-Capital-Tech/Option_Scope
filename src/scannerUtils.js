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
 * (fallback iv). Returns the ticker, or null if none qualifies (→ plain 2-leg spread).
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
