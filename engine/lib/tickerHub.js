/**
 * Shared ticker hub — ONE upstream Delta WebSocket per underlying, fanned out to every
 * account engine that wants it.
 *
 * WHY: each account engine used to open its OWN market-data WebSocket. All engines run in
 * one process behind one VPS IP, so with N accounts that's N identical connections to Delta
 * (all subscribing to the same option chain). Delta caps WebSocket connections per IP and
 * rejects the excess with HTTP 429 → a permanent reconnect storm once N grows past the cap.
 * Backoff/jitter can't fix a CONCURRENCY cap — the only fix is fewer connections.
 *
 * WHAT: accounts call subscribeTickers() with their symbol list + callbacks. The hub keeps a
 * single `createTickerStream` per underlying, subscribed to the UNION of every listener's
 * symbols, and routes each incoming tick only to the listeners that asked for that symbol.
 * When the union changes (an account joins/leaves or rolls expiry) the upstream is rebuilt —
 * debounced so a burst of staggered account starts collapses into one (re)subscribe.
 *
 * So 15 BTC accounts share 1 connection instead of opening 15. Status events (live / stale /
 * disconnected / error) are fanned to every listener so each account's heartbeat ws_status
 * and logs stay accurate.
 */
import { createTickerStream } from './deltaApi.js';
import { log } from './utils.js';

// underlying → hub. A hub owns one upstream stream and the set of account listeners.
const hubs = new Map();

const REBUILD_DEBOUNCE_MS = 800; // coalesce staggered joins / expiry rolls into one resubscribe

function unionSymbols(hub) {
  const u = new Set();
  for (const l of hub.listeners) for (const s of l.symbols) u.add(s);
  return u;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function rebuild(underlying) {
  const hub = hubs.get(underlying);
  if (!hub) return;
  const union = unionSymbols(hub);
  // Need at least the perp + one option; if a hub momentarily has too few, leave the
  // current stream as-is (a lone account with no symbols shouldn't tear down a live feed).
  if (union.size < 2) return;
  if (hub.stream && sameSet(union, hub.symbols)) return; // no change → keep the live socket

  hub.symbols = union;
  const prev = hub.stream;
  hub.stream = createTickerStream(
    [...union],
    (msg) => {
      // Route each tick only to listeners that subscribed to that symbol (accounts still
      // filter again via their own symbolMeta, but this avoids waking every engine per tick).
      const sym = msg?.symbol;
      for (const l of hub.listeners) {
        if (sym == null || l.symbols.has(sym)) l.onTicker?.(msg);
      }
    },
    (status, info) => {
      hub.lastStatus = status;
      for (const l of hub.listeners) l.onStatus?.(status, info);
    },
  );
  // Close the previous stream AFTER the replacement is created so there's no window with no
  // hub stream at all. close() removes its own 'close' listener, so this teardown is silent
  // (no spurious 'disconnected' fan-out).
  if (prev) { try { prev.close(); } catch { /* noop */ } }
  log(`[ticker-hub:${underlying}] upstream (re)subscribed — ${union.size} symbols, ${hub.listeners.size} account listener(s)`);
}

function scheduleRebuild(underlying) {
  const hub = hubs.get(underlying);
  if (!hub) return;
  clearTimeout(hub.rebuildTimer);
  hub.rebuildTimer = setTimeout(() => rebuild(underlying), REBUILD_DEBOUNCE_MS);
}

/**
 * Join the shared feed for `underlying`.
 * @param {string} underlying   e.g. 'BTC' — hubs are per underlying (WS_URL is shared).
 * @param {string[]} symbols    symbols this account needs (option chain + perp).
 * @param {(msg:any)=>void} onTicker  called for each tick of a subscribed symbol.
 * @param {(status:string, info?:any)=>void} onStatus  upstream status (live/stale/disconnected/error).
 * @returns {{ update:(symbols:string[])=>void, close:()=>void }}
 *   `update` swaps this listener's symbol set (expiry roll); `close` detaches it. Both
 *   mirror the handle shape of createTickerStream so callers swap in with no other change.
 */
export function subscribeTickers(underlying, symbols, onTicker, onStatus) {
  let hub = hubs.get(underlying);
  if (!hub) {
    hub = { stream: null, symbols: new Set(), listeners: new Set(), rebuildTimer: null, lastStatus: 'reconnecting' };
    hubs.set(underlying, hub);
  }
  const listener = { symbols: new Set(symbols || []), onTicker, onStatus };
  hub.listeners.add(listener);
  // Report the current upstream status right away so a late joiner's heartbeat isn't stale.
  if (hub.stream) onStatus?.(hub.lastStatus);
  scheduleRebuild(underlying);

  return {
    update(newSymbols) {
      listener.symbols = new Set(newSymbols || []);
      scheduleRebuild(underlying);
    },
    close() {
      hub.listeners.delete(listener);
      if (hub.listeners.size === 0) {
        clearTimeout(hub.rebuildTimer);
        try { hub.stream?.close(); } catch { /* noop */ }
        hubs.delete(underlying);
      } else {
        scheduleRebuild(underlying); // shrink the union so we stop paying for symbols no one wants
      }
    },
  };
}

/** Test/diagnostics: current hub count and per-underlying listener/symbol counts. */
export function _hubStats() {
  const out = {};
  for (const [u, h] of hubs) out[u] = { listeners: h.listeners.size, symbols: h.symbols.size, status: h.lastStatus };
  return out;
}
