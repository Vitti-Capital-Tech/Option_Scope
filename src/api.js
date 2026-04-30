// Delta Exchange API helpers
const PROXY = '/api';
// Keep WS host aligned with REST host (India in this project).
const WS_URL = 'wss://socket.india.delta.exchange';

// Resolution mapping: label -> API value
export const TF_MAP = {
  '1m':  '1m',
  '3m':  '3m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '1h',
  '2h':  '2h',
  '4h':  '4h',
  '6h':  '6h',
  '12h': '12h',
  '1d':  '1d',
  '1w':  '1w',
};

export const TF_SECS = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
  '1w': 604800,
};

export async function apiGet(path, params = {}) {
  const url = new URL(PROXY + path, window.location.origin);
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

// Load all live option products for a given underlying (e.g. "BTC")
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

// Get unique expiries from products (as ISO strings)
export function getExpiries(products) {
  const set = new Set(products.map(p => p.settlement_time));
  return [...set].sort();
}

// Get strikes for a given expiry
export function getStrikes(products, settlementTime) {
  return [...new Set(
    products
      .filter(p => p.settlement_time === settlementTime)
      .map(p => parseFloat(p.strike_price))
  )].sort((a, b) => a - b);
}

// Get current spot price from perpetual futures
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

// Fetch historical candles
export async function fetchCandles(symbol, resolution, startTs, endTs, priceType = 'mark') {
  const reqSymbol = priceType === 'mark' ? 'MARK:' + symbol : symbol;
  const data = await apiGet('/v2/history/candles', {
    symbol: reqSymbol,
    resolution,
    start: startTs,
    end: endTs,
  });
  if (!Array.isArray(data)) return [];
  return data.map(c => ({
    time: parseInt(c.time),
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close),
  })).sort((a, b) => a.time - b.time);
}

// Align two candle arrays and sum OHLC (for combined)
export function sumCandles(callCandles, putCandles) {
  if (!callCandles || !callCandles.length) return putCandles || [];
  if (!putCandles || !putCandles.length) return callCandles || [];
  
  const putMap = new Map(putCandles.map(c => [c.time, c]));
  const result = [];
  for (const cc of callCandles) {
    const pc = putMap.get(cc.time);
    if (pc) {
      result.push({
        time:  cc.time,
        open:  cc.open  + pc.open,
        high:  cc.high  + pc.high,
        low:   cc.low   + pc.low,
        close: cc.close + pc.close,
      });
    }
  }
  return result;
}

// Derive the put symbol from a call symbol (C- -> P-)
export function putSymbol(callSym) {
  return callSym.replace(/^C-/, 'P-');
}

// Format ISO settlement time nicely
export function fmtExpiry(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
}

// Find ATM strike (closest to spot)
export function findATM(strikes, spot) {
  if (!spot || !strikes.length) return strikes[0];
  return strikes.reduce((best, s) =>
    Math.abs(s - spot) < Math.abs(best - spot) ? s : best
  , strikes[0]);
}

export function createWS(callSym, putSym, resolution, priceType, onTicker, onData, onStatus) {
  const ws = new WebSocket(WS_URL);
  let alive = true;

  ws.onopen = () => {
    onStatus('live');
    ws.send(JSON.stringify({
      type: 'subscribe',
      payload: {
        channels: [
          { name: 'v2/ticker', symbols: [callSym, putSym] },
          { name: 'trades', symbols: [callSym, putSym] },
          { name: 'l2_updates', symbols: [callSym, putSym] },
          { name: 'mark_price', symbols: [callSym, putSym] },
        ],
      },
    }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (!msg || msg.type === 'subscriptions') return;

      if (msg.type === 'v2/ticker') {
        let price;
        if (priceType === 'mark') {
          price = parseFloat(msg.mark_price);
        } else {
          // LTP: use close (last trade price).
          // If no close is present (no trades), price will be NaN and onTicker won't fire.
          // This ensures we do NOT show synthetic volume or mark prices on an LTP chart.
          price = parseFloat(msg.close);
        }
        const tickerTimestamp = msg.timestamp ? Math.floor(parseInt(msg.timestamp) / 1000000) : Math.floor(Date.now() / 1000);
        const iv = parseFloat(msg.mark_vol ?? msg.quotes?.mark_iv ?? 0);
        if (!isNaN(price) && price > 0) onTicker(msg.symbol, price, tickerTimestamp, iv);
      }

      // Relay all data to the hub
      if (onData) onData(msg);
    } catch { /* ignore parse errors */ }
  };

  ws.onerror = () => onStatus('error');

  ws.onclose = () => {
    onStatus('disconnected');
    if (alive) setTimeout(() => {}, 0); // caller decides reconnect
  };

  return {
    close: () => { alive = false; ws.close(); },
  };
}

// Subscribe to v2/ticker stream for multiple symbols (scanner use-case)
export function createTickerStream(symbols, onTicker, onStatus) {
  const ws = new WebSocket(WS_URL);
  let alive = true;

  ws.onopen = () => {
    onStatus?.('live');
    ws.send(JSON.stringify({
      type: 'subscribe',
      payload: {
        channels: [
          { name: 'v2/ticker', symbols },
        ],
      },
    }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (!msg || msg.type === 'subscriptions') return;
      if (msg.type !== 'v2/ticker') return;
      onTicker?.(msg);
    } catch { /* ignore */ }
  };

  ws.onerror = () => onStatus?.('error');

  ws.onclose = () => {
    onStatus?.('disconnected');
    if (alive) setTimeout(() => {}, 0);
  };

  return {
    close: () => { alive = false; ws.close(); },
  };
}
