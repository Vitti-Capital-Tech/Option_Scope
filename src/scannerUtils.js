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
 * Short-leg leverage, per underlying AND expiry. Browser-side twin of engine/lib/utils.js — both copies must move together: the scanner's displayed margin/ROI is the number a user checks the engine's decision against.
 *   - Near expiries — DTE 0 (settles today) and DTE 1 (settles tomorrow): the full leverage,
 *     BTC 200x / ETH 100x.
 *   - Any farther expiry (weekly, monthly, …): at most 100x — BTC 100x, ETH stays 100x.
 * DTE = whole days left to settlement. Delta settles at 17:30 IST, so this follows the 17:30
 * trading-day boundary: under 48 hours to settlement = DTE 0 or 1. As an expiry gets closer
 * it moves to the full leverage (e.g. a weekly bought at 100x margins at 200x in its last two
 * days). This is the only place the number lives — every margin path (engine entry sizing,
 * ATM P&L/ROI, the scanner's displayed margin, the UI's position margin) goes through it.
 *
 * `underlyingOrSymbol`: the underlying ('ETH') or a full Delta symbol ('C-ETH-2800-030926').
 * `expiry`: the settlement time (ISO) or a symbol; omitted → read from `underlyingOrSymbol`
 * when it is a symbol. No expiry known → the full leverage (previous behaviour). The $195,000
 * short-notional cap is NOT per-underlying — it stays the same for both.
 */
export const NEAR_EXPIRY_HOURS = 48;   // DTE 0 and DTE 1
export const FAR_EXPIRY_MAX_LEVERAGE = 100;
/** Settlement time (ms) from an ISO expiry or a Delta option symbol (…-DDMMYY → 12:00 UTC = 17:30 IST). */
export function expiryMsOf(expiryOrSymbol) {
  if (expiryOrSymbol == null || expiryOrSymbol === '') return null;
  const s = String(expiryOrSymbol);
  const m = s.match(/-(\d{2})(\d{2})(\d{2})$/);
  if (m) return Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
  if (!/\d{4}-\d{2}-\d{2}/.test(s)) return null; // not a date ('BTC', 'ETH', …)
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
export function leverageFor(underlyingOrSymbol, expiry = null, nowMs = Date.now()) {
  const full = /ETH/i.test(String(underlyingOrSymbol ?? '')) ? 100 : 200;
  const expMs = expiryMsOf(expiry ?? underlyingOrSymbol);
  if (expMs == null) return full;
  return (expMs - nowMs) < NEAR_EXPIRY_HOURS * 3600000 ? full : Math.min(full, FAR_EXPIRY_MAX_LEVERAGE);
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
// ── Delta contract-level OI limit (from 14 Oct 2026) ────────────────────────────────
// A strike whose market-wide open interest reaches Delta's cap goes REDUCE-ONLY (no new
// positions; closing allowed). Delta flags it per ticker (`oi_reduce_only_mode` → oiLocked)
// and reports the strike's OI in USD (`oi_value_usd` → oiUsd). Default caps, in millions of
// USD: BTC 15, ETH 10, XAUT 5. Twin of the helpers in src/scannerUtils.js / engine/lib/utils.js.
export const OI_CAP_DEFAULTS_M = { BTC: 15, ETH: 10, XAUT: 5 };
export function defaultOiCapM(underlying) {
  return OI_CAP_DEFAULTS_M[String(underlying || '').toUpperCase()] ?? 15;
}
/** The cap in effect: a positive configured value (millions), else the underlying's default. */
export function effectiveOiCapM(capM, underlying) {
  const n = Number(capM);
  return capM != null && capM !== '' && Number.isFinite(n) && n > 0 ? n : defaultOiCapM(underlying);
}
/** True when no new leg may be opened on this ticker: Delta locked it, or OI ≥ cap. Unknown OI → allowed. */
export function isOiBlocked(t, capM) {
  if (!t) return false;
  if (t.oiLocked === true) return true;
  const oi = Number(t.oiUsd);
  return t.oiUsd != null && Number.isFinite(oi) && oi >= Number(capM) * 1e6;
}

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
