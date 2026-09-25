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
 * Hedge (3rd long) strike for a ratio spread: one strike-width beyond the short, on the
 * same side — call: short + (short − long), put: short − (long − short). Picks the listed
 * candidate nearest that target, strictly beyond the short and within half a width of the
 * target (ties → the one nearer the short, i.e. more protective). `candidates` are
 * same-type, same-expiry tickers the caller has already filtered (quoted, not excluded,
 * not the spread's own legs). Returns the ticker, or null if none qualifies.
 * Twin of engine/lib/utils.js pickHedgeStrike — keep the two identical.
 */
export function pickHedgeStrike(candidates, type, buyStrike, sellStrike) {
  const width = Math.abs(Number(sellStrike) - Number(buyStrike));
  if (!(width > 0)) return null;
  const isCall = String(type).toLowerCase() === 'call';
  const short = Number(sellStrike);
  const target = isCall ? short + width : short - width;
  let best = null;
  let bestDist = Infinity;
  for (const t of candidates || []) {
    const k = Number(t?.strike);
    if (!Number.isFinite(k)) continue;
    if (isCall ? !(k > short) : !(k < short)) continue;
    const dist = Math.abs(k - target);
    if (dist > width / 2) continue;
    const nearerShort = best != null && Math.abs(k - short) < Math.abs(Number(best.strike) - short);
    if (dist < bestDist || (dist === bestDist && nearerShort)) { best = t; bestDist = dist; }
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
