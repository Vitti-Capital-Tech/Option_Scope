// Delta Exchange API helpers
const PROXY = '/api';
const WS_URL = 'wss://socket.delta.exchange';

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

// Load all live call_options products for a given underlying (e.g. "BTC")
export async function loadProducts(underlying) {
  const products = await apiGet('/v2/products', {
    contract_types: 'call_options',
    states: 'live',
    underlying_asset_symbols: underlying,
  });
  return products || [];
}

// Get unique expiries from products (as ISO strings)
export function getExpiries(products) {
  const set = new Set(products.map(p => p.settlement_time));
  return [...set].sort();
}

// Get strikes for a given expiry
export function getStrikes(products, settlementTime) {
  return products
    .filter(p => p.settlement_time === settlementTime)
    .map(p => parseFloat(p.strike_price))
    .sort((a, b) => a - b);
}

// Get current spot price from perpetual futures
export async function getSpotPrice(underlying) {
  try {
    const tickers = await apiGet('/v2/tickers', {
      underlying_asset_symbols: underlying,
      contract_types: 'perpetual_futures',
    });
    if (tickers && tickers[0]) return parseFloat(tickers[0].mark_price);
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

// Create and manage a single Delta WebSocket connection
export function createWS(callSym, putSym, resolution, priceType, onCandle, onTicker, onStatus) {
  const ws = new WebSocket(WS_URL);
  let alive = true;
  const prefix = priceType === 'mark' ? 'MARK:' : '';

  ws.onopen = () => {
    onStatus('live');
    ws.send(JSON.stringify({
      type: 'subscribe',
      payload: {
        channels: [
          {
            name: `candlestick_${resolution}`,
            symbols: [prefix + callSym, prefix + putSym],
          },
          {
            name: 'v2/ticker',
            symbols: [callSym, putSym],
          },
        ],
      },
    }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (!msg || msg.type === 'subscriptions') return;

      if (msg.type && msg.type.startsWith('candlestick_')) {
        const sym = (msg.symbol || '').replace('MARK:', '');
        let t = parseInt(msg.time || msg.timestamp);
        
        // Delta sends WS timestamps in microseconds. Lightweight charts needs seconds.
        if (t > 10000000000000) t = Math.floor(t / 1000000); // microseconds to seconds
        else if (t > 10000000000) t = Math.floor(t / 1000);  // milliseconds to seconds

        // IMPORTANT: Snap the timestamp to the start of the timeframe bucket.
        // Otherwise, lightweight-charts treats every mid-candle tick as a brand new candle.
        const bucketSecs = TF_SECS[resolution] || 60;
        t = Math.floor(t / bucketSecs) * bucketSecs;

        const o = parseFloat(msg.open);
        const h = parseFloat(msg.high);
        const l = parseFloat(msg.low);
        const c = parseFloat(msg.close);
        
        // Prevent corrupting charts with NaN updates if payload is incomplete
        if (isNaN(t) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return;

        onCandle(sym, { time: t, open: o, high: h, low: l, close: c });
      } else if (msg.type === 'v2/ticker') {
        const price = priceType === 'mark' ? parseFloat(msg.mark_price) : parseFloat(msg.close);
        if (!isNaN(price)) onTicker(msg.symbol, price);
      }
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
