/**
 * Cosmic Trade market-data adapter (PAPER accounts with exchange = 'cosmic').
 *
 * The engine's strategy code reads Delta-shaped products and Delta-shaped ticker messages
 * (processTickerMessage in deltaApi.js). This module talks to Cosmic's PUBLIC endpoints and
 * hands back exactly those shapes, so nothing downstream needs to know which exchange fed it:
 *
 *   loadCosmicProducts  GET  https://cosmic.trade/api/v1/contracts   → Delta /v2/products shape
 *   getCosmicSpot       GET  /api/v1/charts/<U>USDT/index-klines      → index price (spot)
 *   createCosmicTickerStream  wss://cosmic.trade/feeds (msgpack)      → Delta v2/ticker messages
 *
 * Feed facts (probed 2026-11-17): an option tick carries bp/ap (bid/ask), mp (mark), ip (index),
 * miv (mark IV, fraction), de/ga/ve/th (greeks); "<SYM>:depth" carries b/a ladders of
 * [price, qty-in-BTC]. There is no bid/ask IV — computed here by Black-Scholes from bp/ap.
 * Quantities are BTC; one Delta contract = 0.001 BTC, so sizes are reported in those units
 * (qty / 0.001) to keep the entry governor's depth math unchanged.
 *
 * Cosmic rejects requests that carry a browser Origin (403), so this must run server-side.
 * Only BTC options are listed on Cosmic (no ETH options).
 */
import WebSocket from 'ws';
import { unpack } from 'msgpackr';
import { log, logWarn } from './utils.js';
import { impliedVol } from './bsIv.js';

export const COSMIC_BASE = 'https://cosmic.trade';
const COSMIC_WS = 'wss://cosmic.trade/feeds';
const CONTRACT_UNIT = 0.001; // BTC per Delta-equivalent contract
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function cosmicGet(path) {
  const res = await fetch(COSMIC_BASE + path, { headers: { 'User-Agent': 'optionscope-engine' } });
  if (!res.ok) throw new Error(`Cosmic ${path} → HTTP ${res.status}`);
  return res.json();
}

// Delta settlement_time format ("2026-11-17T12:00:00Z") — expiries are compared as strings.
const isoZ = (s) => new Date(s).toISOString().replace('.000Z', 'Z');

/** Live Cosmic option contracts of `underlying`, in Delta /v2/products shape. */
export async function loadCosmicProducts(underlying) {
  const all = await cosmicGet('/api/v1/contracts');
  const u = String(underlying || '').toUpperCase();
  return (Array.isArray(all) ? all : [])
    .filter(c => (c.instrument_kind === 'option_call' || c.instrument_kind === 'option_put')
      && String(c.underlying_symbol).toUpperCase() === u && c.is_active !== false && c.status === 'Trading')
    .map(c => ({
      id: c.id,
      symbol: c.symbol,
      strike_price: String(c.strike_price),
      contract_type: c.instrument_kind === 'option_call' ? 'call_options' : 'put_options',
      settlement_time: isoZ(c.expiry_ts || c.delivery_time),
      contract_value: c.contract_size || String(CONTRACT_UNIT),
      tick_size: c.tick_size,
      trading_status: 'operational',
      product_specs: {},
      exchange: 'cosmic',
    }));
}

let spotCache = new Map(); // underlying → { px, at }
/** Cosmic index price (its spot reference), cached 5 s across accounts. */
export async function getCosmicSpot(underlying) {
  const u = String(underlying || '').toUpperCase();
  const c = spotCache.get(u);
  if (c && Date.now() - c.at < 5000) return c.px;
  try {
    const to = Math.floor(Date.now() / 1000) + 60;
    const bars = await cosmicGet(`/api/v1/charts/${u}USDT/index-klines?interval=1&from=${to - 600}&to=${to}`);
    const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
    const px = last ? Number(last.close) : null;
    if (px > 0) { spotCache.set(u, { px, at: Date.now() }); return px; }
  } catch (e) {
    logWarn(`[cosmic] spot fetch failed: ${e.message}`);
  }
  return c?.px ?? null;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * One Cosmic WebSocket for `symbols` (option symbols + the `<U>USD` perp alias the engine
 * uses for spot). Emits Delta-shaped v2/ticker messages to `onTicker`. `expiryOf(symbol)`
 * returns the option's settlement ISO (for the bid/ask IV time to expiry).
 * Same handle shape and status events as deltaApi.createTickerStream.
 */
export function createCosmicTickerStream(symbols, onTicker, onStatus, { expiryOf, staleTimeoutMs = 30000 } = {}) {
  let ws = null;
  let alive = true;
  let reconnectTimer = null;
  let attempts = 0;
  let lastMsgAt = 0;
  const lastIndex = new Map(); // underlying → index price (for IV)

  // Engine perp alias `${U}USD` ↔ Cosmic `${U}USDT`.
  const perpAlias = new Map();
  const subs = [];
  for (const s of symbols) {
    const m = /^([A-Z]+)USD$/.exec(s);
    if (m) { perpAlias.set(`${m[1]}USDT`, s); subs.push(`${m[1]}USDT`); }
    else { subs.push(s, `${s}:depth`); }
  }

  const underlyingOf = (sym) => String(sym).split('-')[0];
  const yearsLeft = (sym) => {
    const e = expiryOf?.(sym);
    return e ? (new Date(e).getTime() - Date.now()) / YEAR_MS : null;
  };

  const translate = (m) => {
    const s = m?.s;
    if (!s) return null;
    if (perpAlias.has(s)) {
      const ip = num(m.ip);
      if (ip) lastIndex.set(s.replace(/USDT$/, ''), ip);
      return { type: 'v2/ticker', symbol: perpAlias.get(s), spot_price: m.ip, mark_price: m.mp, last_price: m.lp };
    }
    if (Array.isArray(m.b) || Array.isArray(m.a)) {
      // Depth: top-of-book sizes only (prices come from the ticker), in contract units.
      const bq = m.b?.[0] ? num(m.b[0][1]) : null;
      const aq = m.a?.[0] ? num(m.a[0][1]) : null;
      const quotes = {};
      if (m.b) quotes.bid_size = bq != null ? Math.round(bq / CONTRACT_UNIT) : 0;
      if (m.a) quotes.ask_size = aq != null ? Math.round(aq / CONTRACT_UNIT) : 0;
      return { type: 'v2/ticker', symbol: s, quotes };
    }
    // Option ticker.
    const bp = num(m.bp), ap = num(m.ap);
    const ip = num(m.ip) ?? lastIndex.get(underlyingOf(s));
    const T = yearsLeft(s);
    const strike = num(s.split('-')[2]);
    const isCall = /-C$/.test(s);
    const iv = (px) => (px > 0 && ip > 0 && strike > 0 && T > 0 ? impliedVol(px, ip, strike, T, isCall) : null);
    const bidIv = iv(bp), askIv = iv(ap);
    const quotes = {};
    if (bp != null) quotes.best_bid = String(bp);
    if (ap != null) quotes.best_ask = String(ap);
    if (bidIv != null) quotes.bid_iv = String(bidIv / 100);
    if (askIv != null) quotes.ask_iv = String(askIv / 100);
    return {
      type: 'v2/ticker',
      symbol: s,
      mark_price: m.mp || undefined,
      last_price: m.lp || undefined,
      mark_vol: m.miv || undefined,
      greeks: m.de != null && m.de !== '' ? { delta: m.de } : undefined,
      oi_contracts: m.oi || undefined,
      quotes,
    };
  };

  const connect = () => {
    if (!alive) return;
    try {
      ws = new WebSocket(COSMIC_WS); // no Origin header — Cosmic 403s browser origins
      lastMsgAt = Date.now();
      ws.on('open', () => {
        attempts = 0;
        onStatus?.('live');
        // Subscribe in chunks so one frame stays small.
        for (let i = 0; i < subs.length; i += 100) ws.send(JSON.stringify({ action: 'subscribe', symbols: subs.slice(i, i + 100) }));
      });
      ws.on('message', (data, isBinary) => {
        lastMsgAt = Date.now();
        let m;
        try { m = isBinary ? unpack(data) : JSON.parse(data.toString()); } catch { return; }
        const msgs = Array.isArray(m) ? m : [m];
        for (const x of msgs) {
          const t = translate(x);
          if (t) onTicker?.(t);
        }
      });
      ws.on('error', (err) => onStatus?.('error', { message: err?.message || String(err), code: err?.code }));
      ws.on('close', (code, reason) => {
        const delay = Math.min(30000, 2000 * 2 ** attempts++) * (0.8 + Math.random() * 0.4);
        onStatus?.('disconnected', { code, reason: reason ? reason.toString() : '', retryMs: Math.round(delay) });
        if (alive) reconnectTimer = setTimeout(connect, delay);
      });
    } catch {
      if (alive) reconnectTimer = setTimeout(connect, 5000);
    }
  };
  reconnectTimer = setTimeout(connect, Math.round(Math.random() * 1000));

  const watchdog = setInterval(() => {
    if (!alive || !ws || Date.now() - lastMsgAt <= staleTimeoutMs) return;
    onStatus?.('stale');
    lastMsgAt = Date.now();
    try { ws.terminate(); } catch { /* noop */ }
  }, 5000);

  log(`[cosmic] ticker stream for ${subs.length} channels`);
  return {
    close: () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearInterval(watchdog);
      if (ws) { ws.removeAllListeners('close'); try { ws.close(); } catch { /* noop */ } }
    },
  };
}
