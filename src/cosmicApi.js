// Cosmic Trade market data for the "Cosmic Paper" tab — browser twin of engine/lib/cosmicApi.js.
//
// Cosmic answers 403 to any browser Origin, so everything goes through the engine's proxy
// (VITE_DELTA_PROXY_URL → engine/proxyServer.js): REST at <proxy>/cosmic/api/v1/... and the
// live feed at <proxy>/cosmic/feeds (msgpack decoded to JSON by the proxy).
// Everything is returned in Delta's shapes (products, v2/ticker messages) so PaperTrading.jsx
// reads Cosmic exactly like Delta. Cosmic lists BTC options only.

import { impliedVol } from './ivUtils';

const PROXY = (import.meta.env.VITE_DELTA_PROXY_URL || '').replace(/\/+$/, '');
const REST = `${PROXY}/cosmic`;
const WS = `${PROXY.replace(/^http/i, 'ws')}/cosmic/feeds`;
const CONTRACT_UNIT = 0.001; // BTC per Delta-equivalent contract
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const cosmicConfigured = () => !!PROXY;

async function cosmicGet(path) {
  if (!PROXY) throw new Error('VITE_DELTA_PROXY_URL is not set — the Cosmic tab needs the engine proxy.');
  const res = await fetch(REST + path);
  if (!res.ok) throw new Error(`Cosmic ${path} → HTTP ${res.status}`);
  return res.json();
}

const isoZ = (s) => new Date(s).toISOString().replace('.000Z', 'Z');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/** Live Cosmic option contracts in Delta /v2/products shape. */
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
      trading_status: 'operational',
      exchange: 'cosmic',
    }));
}

/** Cosmic index price (spot reference). */
export async function getCosmicSpot(underlying) {
  try {
    const u = String(underlying || '').toUpperCase();
    const to = Math.floor(Date.now() / 1000) + 60;
    const bars = await cosmicGet(`/api/v1/charts/${u}USDT/index-klines?interval=1&from=${to - 600}&to=${to}`);
    const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
    const px = last ? Number(last.close) : null;
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

/**
 * Live Cosmic feed for `symbols` (option symbols + the `<U>USD` perp alias), emitting
 * Delta-shaped v2/ticker messages. `expiryOf(symbol)` → settlement ISO, for bid / ask IV.
 * Same handle shape as api.js createTickerStream.
 */
export function createCosmicTickerStream(symbols, onTicker, onStatus, { expiryOf } = {}) {
  let ws = null;
  let alive = true;
  let reconnectTimer = null;
  const lastIndex = new Map();
  const perpAlias = new Map();
  const subs = [];
  for (const s of symbols) {
    const m = /^([A-Z]+)USD$/.exec(s);
    if (m) { perpAlias.set(`${m[1]}USDT`, s); subs.push(`${m[1]}USDT`); }
    else subs.push(s, `${s}:depth`);
  }

  const translate = (m) => {
    const s = m?.s;
    if (!s) return null;
    if (perpAlias.has(s)) {
      const ip = num(m.ip);
      if (ip) lastIndex.set(s.replace(/USDT$/, ''), ip);
      return { type: 'v2/ticker', symbol: perpAlias.get(s), spot_price: m.ip, mark_price: m.mp, last_price: m.lp };
    }
    if (Array.isArray(m.b) || Array.isArray(m.a)) {
      const quotes = {};
      if (m.b) quotes.bid_size = m.b[0] ? Math.round(num(m.b[0][1]) / CONTRACT_UNIT) : 0;
      if (m.a) quotes.ask_size = m.a[0] ? Math.round(num(m.a[0][1]) / CONTRACT_UNIT) : 0;
      return { type: 'v2/ticker', symbol: s, quotes };
    }
    const bp = num(m.bp), ap = num(m.ap);
    const ip = num(m.ip) ?? lastIndex.get(s.split('-')[0]);
    const e = expiryOf?.(s);
    const T = e ? (new Date(e).getTime() - Date.now()) / YEAR_MS : null;
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
      quotes,
    };
  };

  const connect = () => {
    if (!alive || !PROXY) return;
    try {
      ws = new WebSocket(WS);
      ws.onopen = () => {
        onStatus?.('live');
        for (let i = 0; i < subs.length; i += 100) ws.send(JSON.stringify({ action: 'subscribe', symbols: subs.slice(i, i + 100) }));
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        for (const x of Array.isArray(m) ? m : [m]) {
          const t = translate(x);
          if (t) onTicker?.(t);
        }
      };
      ws.onerror = () => onStatus?.('error');
      ws.onclose = () => {
        onStatus?.('disconnected');
        if (alive) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000); }
      };
    } catch {
      if (alive) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000); }
    }
  };
  connect();

  return {
    close: () => {
      alive = false;
      clearTimeout(reconnectTimer);
      if (ws) { ws.onclose = null; ws.close(); }
    },
  };
}
