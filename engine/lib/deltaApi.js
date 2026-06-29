/**
 * Server-side Delta Exchange API client.
 * Uses native fetch (Node 18+) and the `ws` npm package.
 * No browser/Vite proxy needed — direct HTTPS calls.
 */
import WebSocket from 'ws';
import { toFiniteNumber, normalizeIv, matchesOptionType, log, logWarn, logError } from './utils.js';

const BASE_URL = 'https://api.india.delta.exchange';
const WS_URL = 'wss://socket.india.delta.exchange';

/**
 * REST GET request to Delta Exchange API.
 */
export async function apiGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message || `API error on ${path}`);
  }
  return json.result;
}

/**
 * Highest traded price of an option over the last `hours` hours, from Delta's
 * historical OHLC candles. Returns null if unavailable (no candles / API error),
 * so callers can fall back. Used to bound the long-only laddered exit range.
 */
export async function getOptionHigh(symbol, hours = 2, resolution = '5m') {
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.round(hours * 3600);
    const candles = await apiGet('/v2/history/candles', { resolution, symbol, start, end });
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const highs = candles.map(c => toFiniteNumber(c.high)).filter(v => v != null && v > 0);
    if (!highs.length) return null;
    return Math.max(...highs);
  } catch (e) {
    logWarn(`getOptionHigh failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Load all live option products for a given underlying.
 */
export async function loadProducts(underlying) {
  const [calls, puts] = await Promise.all([
    apiGet('/v2/products', {
      contract_types: 'call_options',
      states: 'live',
      underlying_asset_symbols: underlying,
    }),
    apiGet('/v2/products', {
      contract_types: 'put_options',
      states: 'live',
      underlying_asset_symbols: underlying,
    }),
  ]);
  return [...(calls || []), ...(puts || [])];
}

/**
 * Get unique expiries from products (as ISO strings).
 */
export function getExpiries(products) {
  const set = new Set(products.map(p => p.settlement_time));
  return [...set].sort();
}

/**
 * Get strikes for a given expiry.
 */
export function getStrikes(products, settlementTime) {
  return [...new Set(
    products
      .filter(p => p.settlement_time === settlementTime)
      .map(p => parseFloat(p.strike_price))
  )].sort((a, b) => a - b);
}

/**
 * Get current spot price from perpetual futures.
 */
export async function getSpotPrice(underlying) {
  try {
    const tickers = await apiGet('/v2/tickers', {
      underlying_asset_symbols: underlying,
      contract_types: 'perpetual_futures',
    });
    if (tickers && tickers[0]) return parseFloat(tickers[0].spot_price);
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Fetch current ticker data via REST for a batch of symbols.
 * Used as a one-time backfill on startup before WebSocket data arrives.
 */
export async function getTickers(underlying, symbols) {
  try {
    const res = await apiGet('/v2/tickers', {
      underlying_asset_symbols: underlying,
      contract_types: 'call_options,put_options'
    });
    if (!res || !Array.isArray(res)) return null;

    const symbolSet = new Set(symbols);
    const result = [];
    for (const t of res) {
      if (symbolSet.has(t.symbol)) {
        result.push({
          symbol: t.symbol,
          mark_price: toFiniteNumber(t.mark_price),
          last_price: toFiniteNumber(t.last_price || t.close),
          greeks: t.greeks || null,
          mark_vol: t.mark_vol || t.quotes?.mark_iv || null,
          quotes: t.quotes || null
        });
      }
    }
    return result;
  } catch (e) {
    logError('getTickers error:', e);
    return null;
  }
}

/**
 * Subscribe to v2/ticker stream for multiple symbols.
 * Uses the `ws` npm package for server-side WebSocket.
 * Auto-reconnects on unexpected close (3-second backoff).
 */
export function createTickerStream(symbols, onTicker, onStatus) {
  let ws = null;
  let alive = true;
  let reconnectTimer = null;

  const connect = () => {
    if (!alive) return;
    try {
      ws = new WebSocket(WS_URL);

      ws.on('open', () => {
        onStatus?.('live');
        ws.send(JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [
              { name: 'v2/ticker', symbols },
            ],
          },
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (!msg || msg.type === 'subscriptions') return;
          if (msg.type !== 'v2/ticker') return;
          onTicker?.(msg);
        } catch { /* ignore parse errors */ }
      });

      ws.on('error', (err) => {
        onStatus?.('error');
      });

      ws.on('close', () => {
        onStatus?.('disconnected');
        if (alive) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, 3000);
        }
      });
    } catch (e) {
      if (alive) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
      }
    }
  };

  connect();

  return {
    close: () => {
      alive = false;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.removeAllListeners('close');
        ws.close();
      }
    },
  };
}

/**
 * Build a symbolMeta map from products for a given expiry.
 * Also includes symbols from existing active positions.
 */
export function buildSymbolMeta(products, expiry, underlying, activePositions = []) {
  const strikes = getStrikes(products, expiry);
  const symbolMeta = {};

  for (const strike of strikes) {
    const callProd = products.find(p =>
      p.settlement_time === expiry &&
      parseFloat(p.strike_price) === parseFloat(strike) &&
      matchesOptionType(p, 'call')
    );
    if (callProd) {
      const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
      symbolMeta[callProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'call', symbol: callProd.symbol, expiry };
    }

    const putProd = products.find(p =>
      p.settlement_time === expiry &&
      parseFloat(p.strike_price) === parseFloat(strike) &&
      matchesOptionType(p, 'put')
    );
    if (putProd) {
      const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
      symbolMeta[putProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'put', symbol: putProd.symbol, expiry };
    }
  }

  // Also monitor symbols from existing positions of this underlying
  for (const pos of activePositions) {
    if (pos.underlying === underlying) {
      if (pos.buyLeg && !symbolMeta[pos.buyLeg.symbol]) {
        symbolMeta[pos.buyLeg.symbol] = {
          strike: pos.buyLeg.strike, lotSize: pos.buyLeg.lotSize,
          type: pos.type, symbol: pos.buyLeg.symbol, expiry: pos.expiry
        };
      }
      if (pos.sellLeg && !symbolMeta[pos.sellLeg.symbol]) {
        symbolMeta[pos.sellLeg.symbol] = {
          strike: pos.sellLeg.strike, lotSize: pos.sellLeg.lotSize,
          type: pos.type, symbol: pos.sellLeg.symbol, expiry: pos.expiry
        };
      }
    }
  }

  return symbolMeta;
}

/**
 * Process a raw v2/ticker WebSocket message into our internal ticker format.
 */
export function processTickerMessage(msg, symbolMeta, prevData) {
  const sym = msg.symbol;
  const meta = symbolMeta[sym];
  if (!meta) return null;

  const markPrice = toFiniteNumber(msg.mark_price);
  const lastPrice = toFiniteNumber(msg.last_price ?? msg.close);
  const bid = toFiniteNumber(msg.quotes?.best_bid);
  const ask = toFiniteNumber(msg.quotes?.best_ask);
  const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.bid_iv));
  const askIv = normalizeIv(toFiniteNumber(msg.quotes?.ask_iv));
  const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
  const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;

  const prev = prevData?.[sym];

  return {
    symbol: sym,
    strike: meta.strike,
    lotSize: meta.lotSize,
    type: meta.type,
    expiry: meta.expiry,
    markPrice: markPrice ?? prev?.markPrice ?? null,
    lastPrice: lastPrice ?? prev?.lastPrice ?? null,
    bid: bid ?? prev?.bid ?? null,
    ask: ask ?? prev?.ask ?? null,
    bidUpdatedAt: bid != null ? Date.now() : (prev?.bidUpdatedAt ?? 0),
    askUpdatedAt: ask != null ? Date.now() : (prev?.askUpdatedAt ?? 0),
    bidIv: bidIv ?? prev?.bidIv ?? null,
    askIv: askIv ?? prev?.askIv ?? null,
    iv: iv ?? prev?.iv ?? null,
    delta: delta !== null ? delta : prev?.delta,
    deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prev?.deltaNotional,
  };
}

/**
 * Backfill ticker data from REST for all symbols.
 * Returns merged ticker data object.
 */
export async function backfillTickers(underlying, symbolMeta, existingData = {}) {
  const allSymbols = Object.keys(symbolMeta);
  if (!allSymbols.length) return existingData;

  try {
    const res = await getTickers(underlying, allSymbols);
    if (!res) return existingData;

    const backfill = {};
    for (const t of res) {
      const meta = symbolMeta[t.symbol];
      if (!meta) continue;

      const prev = existingData[t.symbol];
      const markPrice = toFiniteNumber(t.mark_price);
      const lastPrice = toFiniteNumber(t.last_price ?? t.close);
      const iv = normalizeIv(toFiniteNumber(t.mark_vol ?? t.quotes?.mark_iv ?? t.greeks?.iv));
      const bid = toFiniteNumber(t.quotes?.best_bid);
      const ask = toFiniteNumber(t.quotes?.best_ask);
      const bidIv = normalizeIv(toFiniteNumber(t.quotes?.bid_iv));
      const askIv = normalizeIv(toFiniteNumber(t.quotes?.ask_iv));

      const resolvedBid = bid ?? (prev?.bid ?? null);
      const resolvedAsk = ask ?? (prev?.ask ?? null);
      const now = Date.now();

      backfill[t.symbol] = {
        symbol: t.symbol,
        strike: meta.strike,
        lotSize: meta.lotSize,
        type: meta.type,
        expiry: meta.expiry,
        markPrice: (markPrice && markPrice > 0) ? markPrice : (prev?.markPrice ?? null),
        lastPrice: (lastPrice && lastPrice > 0) ? lastPrice : (prev?.lastPrice ?? null),
        bid: resolvedBid,
        ask: resolvedAsk,
        // Set timestamps to now if bid/ask exist, so backfill quotes are treated as
        // fresh on the first entry scan after startup. WS live quotes overwrite these.
        bidUpdatedAt: resolvedBid != null ? now : 0,
        askUpdatedAt: resolvedAsk != null ? now : 0,
        bidIv: bidIv ?? (prev?.bidIv ?? null),
        askIv: askIv ?? (prev?.askIv ?? null),
        iv: iv ?? (prev?.iv ?? null),
        delta: t.greeks ? toFiniteNumber(t.greeks.delta) : (prev?.delta ?? null),
        deltaNotional: t.greeks ? Math.abs(t.greeks.delta) * meta.lotSize : (prev?.deltaNotional ?? null),
      };
    }

    return { ...existingData, ...backfill };
  } catch (e) {
    logError('Backfill tickers error:', e);
    return existingData;
  }
}
