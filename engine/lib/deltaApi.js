/**
 * Server-side Delta Exchange API client.
 * Uses native fetch (Node 18+) and the `ws` npm package.
 * No browser/Vite proxy needed — direct HTTPS calls.
 */
import WebSocket from 'ws';
import { toFiniteNumber, normalizeIv, matchesOptionType, log, logWarn, logError } from './utils.js';

const BASE_URL = 'https://api.india.delta.exchange';
const WS_URL = 'wss://socket.india.delta.exchange';

// Public reads get the same abort deadline as the signed ones (deltaTradeApi.js):
// `fetch` has no default request timeout, so a half-open socket to Delta would hang the
// caller until the OS TCP timeout — and callers here (spot poll, product refresh, ticker
// backfill) feed the evaluation loop. Product/backfill responses are large, so the
// default is looser than the signed-read timeout.
const PUBLIC_TIMEOUT_MS = Math.max(1000, Number(process.env.DELTA_PUBLIC_TIMEOUT_MS ?? 10000));

/**
 * REST GET request to Delta Exchange API.
 */
export async function apiGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`Delta API GET ${path} timed out after ${PUBLIC_TIMEOUT_MS}ms`);
    }
    throw e;
  }
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
export function createTickerStream(symbols, onTicker, onStatus, opts = {}) {
  // Stream-level keepalive. A half-open ("zombie") TCP socket keeps looking connected
  // — no 'close' or 'error' event fires — while the server has silently stopped sending
  // ANY data. The reconnect logic below only reacts to 'close', so without this a dead
  // socket can sit undetected until the OS TCP timeout eventually trips it (minutes).
  // If no message of any kind (perp OR option) arrives within STALE_TIMEOUT_MS (30s) we force
  // a hard reconnect. Because the perp/spot symbol ticks constantly on a healthy feed, this
  // only fires when the WHOLE socket is dead — it does NOT false-trigger during quiet
  // option markets (an options-only stall is handled engine-side by the option-feed watchdog).
  const STALE_TIMEOUT_MS = opts.staleTimeoutMs ?? 30000;
  const WATCHDOG_INTERVAL_MS = opts.watchdogIntervalMs ?? 5000;

  let ws = null;
  let alive = true;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let lastMsgAt = 0;

  // Exponential backoff WITH jitter. Every account runs its own stream but they share one
  // VPS IP, so a simultaneous drop (or a synchronized WS restart on the shared product-
  // refresh timer) makes them all re-handshake on the SAME tick — Delta rejects the burst
  // with HTTP 429 and they retry in lockstep, a self-sustaining reconnect storm. Backoff
  // slows repeated failures; the random jitter SPREADS each stream's retry so N accounts
  // don't hammer the handshake endpoint together. Resets to 0 once a socket actually opens.
  const RECONNECT_BASE_MS = opts.reconnectBaseMs ?? 3000;
  const RECONNECT_MAX_MS = opts.reconnectMaxMs ?? 30000;
  let reconnectAttempts = 0;

  const nextDelay = () => {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    return Math.round(base + Math.random() * base); // up to +100% jitter → de-syncs accounts
  };

  const scheduleReconnect = (delayMs = nextDelay()) => {
    if (!alive) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delayMs);
  };

  const connect = () => {
    if (!alive) return;
    try {
      ws = new WebSocket(WS_URL);
      lastMsgAt = Date.now(); // grace period: don't let the watchdog fire before the handshake

      ws.on('open', () => {
        reconnectAttempts = 0; // healthy handshake — reset the backoff ladder
        onStatus?.('live');
        lastMsgAt = Date.now();
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
        lastMsgAt = Date.now(); // any message keeps the socket "alive" for the watchdog
        try {
          const msg = JSON.parse(data.toString());
          if (!msg || msg.type === 'subscriptions') return;
          if (msg.type !== 'v2/ticker') return;
          onTicker?.(msg);
        } catch { /* ignore parse errors */ }
      });

      ws.on('error', (err) => {
        // Surface the reason (e.g. ECONNRESET, 429/1013 rate-limit, DNS) — otherwise the
        // subsequent 'close' looks unexplained. Pass it through for the caller to log.
        onStatus?.('error', { message: err?.message || String(err), code: err?.code });
      });

      ws.on('close', (code, reason) => {
        // Close code tells apart a server/rate-limit drop (1006/1013/1008) from a clean
        // close (1000/1001) — key for diagnosing a reconnect storm.
        const delayMs = nextDelay();
        onStatus?.('disconnected', { code, reason: reason ? reason.toString() : '', retryMs: delayMs });
        scheduleReconnect(delayMs);
      });
    } catch (e) {
      scheduleReconnect();
    }
  };

  // Stagger the FIRST handshake by a small random delay so N account streams starting up
  // (or restarting together on the shared product-refresh timer) don't all hit the endpoint
  // on the same tick and trip the per-IP 429 rate limit.
  const INITIAL_JITTER_MS = opts.initialJitterMs ?? 2000;
  reconnectTimer = setTimeout(connect, Math.round(Math.random() * INITIAL_JITTER_MS));

  watchdogTimer = setInterval(() => {
    if (!alive || !ws || lastMsgAt === 0) return;
    if (Date.now() - lastMsgAt <= STALE_TIMEOUT_MS) return;
    onStatus?.('stale');
    lastMsgAt = Date.now(); // reset so we don't re-fire during the reconnect gap
    // terminate() forces the socket shut → the 'close' handler runs the normal reconnect.
    try { ws.terminate(); } catch { try { ws.close(); } catch { /* noop */ } }
  }, WATCHDOG_INTERVAL_MS);

  return {
    close: () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearInterval(watchdogTimer);
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
      // Real per-contract underlying amount (e.g. 0.001 BTC) — used for LIVE margin
      // sizing so the estimate matches Delta. Distinct from the (paper) lotSize above.
      const contractValue = parseFloat(callProd.contract_value ?? callProd.contract_size ?? callProd.quoting_precision ?? 1);
      symbolMeta[callProd.symbol] = { strike: parseFloat(strike), lotSize, contractValue, type: 'call', symbol: callProd.symbol, expiry };
    }

    const putProd = products.find(p =>
      p.settlement_time === expiry &&
      parseFloat(p.strike_price) === parseFloat(strike) &&
      matchesOptionType(p, 'put')
    );
    if (putProd) {
      const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
      const contractValue = parseFloat(putProd.contract_value ?? putProd.contract_size ?? putProd.quoting_precision ?? 1);
      symbolMeta[putProd.symbol] = { strike: parseFloat(strike), lotSize, contractValue, type: 'put', symbol: putProd.symbol, expiry };
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
  // Top-of-book size (contracts) resting AT the best bid/ask — used by the entry depth
  // guard so an order never exceeds the size available at the price it would hit.
  const bidSize = toFiniteNumber(msg.quotes?.bid_size ?? msg.quotes?.best_bid_size);
  const askSize = toFiniteNumber(msg.quotes?.ask_size ?? msg.quotes?.best_ask_size);
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
    bidSize: bidSize ?? prev?.bidSize ?? null,
    askSize: askSize ?? prev?.askSize ?? null,
    // Sizes carry forward when a tick omits them, exactly like prices — but unlike prices
    // they had NO timestamp, so nothing downstream could tell a size delivered 200ms ago
    // from one delivered an hour ago. Both the entry depth guard and the cross-account
    // governor gate real orders on these numbers, so "how old is this?" has to be
    // answerable. Stamped only when a size is actually present in the tick.
    bidSizeAt: bidSize != null ? Date.now() : (prev?.bidSizeAt ?? 0),
    askSizeAt: askSize != null ? Date.now() : (prev?.askSizeAt ?? 0),
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
      const bidSize = toFiniteNumber(t.quotes?.bid_size ?? t.quotes?.best_bid_size);
      const askSize = toFiniteNumber(t.quotes?.ask_size ?? t.quotes?.best_ask_size);
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
        bidSize: bidSize ?? (prev?.bidSize ?? null),
        askSize: askSize ?? (prev?.askSize ?? null),
        // Set timestamps to now if bid/ask exist, so backfill quotes are treated as
        // fresh on the first entry scan after startup. WS live quotes overwrite these.
        bidUpdatedAt: resolvedBid != null ? now : 0,
        askUpdatedAt: resolvedAsk != null ? now : 0,
        // Size age (see processTickerMessage) — only a size actually present in this REST
        // snapshot counts as fresh; a carried-forward one keeps whatever age it had.
        bidSizeAt: bidSize != null ? now : (prev?.bidSizeAt ?? 0),
        askSizeAt: askSize != null ? now : (prev?.askSizeAt ?? 0),
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
