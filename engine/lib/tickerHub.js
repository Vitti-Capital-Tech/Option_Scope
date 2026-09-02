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
import { createTickerStream, processTickerMessage } from './deltaApi.js';
import { log, logWarn } from './utils.js';

// underlying → hub. A hub owns one upstream stream and the set of account listeners.
const hubs = new Map();

const REBUILD_DEBOUNCE_MS = 800; // coalesce staggered joins / expiry rolls into one resubscribe

function unionSymbols(hub) {
  const u = new Set();
  for (const l of hub.listeners) for (const s of l.symbols) u.add(s);
  return u;
}

// Merged symbol metadata across every listener, so the hub can normalise a tick ONCE for
// all of them. Two accounts that both derive a symbol from the products list produce
// identical values, so those merge freely.
//
// What does NOT merge freely is buildSymbolMeta's position-leg fallback (`fromPosition`),
// which an account emits for legs OUTSIDE the expiry it currently trades. A plain
// Object.assign let whichever listener happened to come last decide, so a fallback entry
// could overwrite the chain entry for a symbol another account trades for real — and since
// this map normalises every tick for EVERY account, one wrong lotSize became a wrong
// deltaNotional process-wide. Chain-derived always wins, in either arrival order.
// One warning per symbol+field for the life of the process — enough to see it, never a flood.
const warnedMetaConflicts = new Set();

function unionMeta(hub) {
  const m = {};
  for (const l of hub.listeners) {
    for (const sym of Object.keys(l.meta || {})) {
      const meta = l.meta[sym];
      const cur = m[sym];
      // TRIPWIRE. Two listeners describing the SAME instrument differently is always a bug:
      // this map normalises every tick for every account, so whichever entry wins silently
      // becomes everyone's truth. That is exactly how a position's sized lot once became the
      // contract lot for a symbol another account was trading for real, and the only visible
      // symptom was a sell ratio ~3x too large three layers downstream. Resolution is still
      // deterministic (chain-derived wins, below) — this just refuses to let the next
      // divergence be silent.
      if (cur && meta) {
        for (const f of ['lotSize', 'contractValue', 'strike', 'expiry']) {
          const key = `${sym}:${f}`;
          if (cur[f] !== meta[f] && !warnedMetaConflicts.has(key)) {
            warnedMetaConflicts.add(key);
            logWarn(`[ticker-hub] symbol meta conflict on ${sym}.${f}: ${cur[f]} (${cur.fromPosition ? 'position' : 'chain'}) vs ${meta[f]} (${meta.fromPosition ? 'position' : 'chain'}) — chain-derived wins.`);
          }
        }
      }
      if (meta?.fromPosition && cur && !cur.fromPosition) continue;
      m[sym] = meta;
    }
  }
  return m;
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
  // Refresh the merged metadata and prune the snapshot BEFORE the early-outs — both must
  // happen even when the subscription itself is unchanged (a listener can join with symbols
  // the union already covers, and a listener can LEAVE without changing it either).
  //
  // The prune matters because hub.store is process-lifetime state. Each account still resets
  // its own map on an expiry roll, but the hub's had no such reset, so every expiry's symbols
  // accumulated in it forever — ~252 objects per roll, unbounded. Dropping anything no longer
  // in the union keeps it to the live chain. Skipped while the union is degenerate (below),
  // so a momentary empty subscription can't wipe a healthy snapshot.
  if (union.size >= 2) {
    hub.meta = unionMeta(hub);
    for (const sym of Object.keys(hub.store)) {
      if (!union.has(sym)) delete hub.store[sym];
    }
  }

  // Need at least the perp + one option; if a hub momentarily has too few, leave the
  // current stream as-is (a lone account with no symbols shouldn't tear down a live feed).
  if (union.size < 2) return;
  if (hub.stream && sameSet(union, hub.symbols)) return; // no change → keep the live socket

  hub.symbols = union;
  const prev = hub.stream;
  hub.stream = createTickerStream(
    [...union],
    (msg) => {
      const sym = msg?.symbol;
      // Normalise ONCE for the whole hub and hand every listener the SAME object.
      //
      // Each account used to run processTickerMessage on its own copy, which meant N parses
      // per tick and N divergent snapshots — two accounts could read a different `ask` for
      // the same symbol in the same second (observed 2026-08-28: one chased off ask 98 while
      // another chased off 95, on the same strike, at the same timestamp). That divergence
      // also decided the entry governor's frozen depth pool, since whichever account touched
      // a leg first seeded it from ITS OWN copy. One parse removes both problems; the CPU
      // saving (~2% of a core at 40 accounts) is the smaller half of the benefit.
      //
      // Safe to share because ticker objects are read-only downstream: the engine's only
      // write is `tickerData[symbol] = <this object>`, and nothing mutates one in place.
      // The perp/spot symbol carries no metadata, so it stays `null` and the engine reads
      // spot straight off the raw message.
      let parsed = null;
      if (sym != null && hub.meta?.[sym]) {
        parsed = processTickerMessage(msg, hub.meta, hub.store);
        if (parsed) hub.store[parsed.symbol] = parsed;
      }
      for (const l of hub.listeners) {
        if (sym == null || l.symbols.has(sym)) l.onTicker?.(msg, parsed);
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
/**
 * Join the shared feed for `underlying`.
 *
 * `symbolMeta` (symbol → { strike, lotSize, type, expiry }) lets the hub normalise each
 * tick once for every listener; `onTicker` then receives `(rawMsg, parsed)`, where `parsed`
 * is null for symbols with no metadata (the perp/spot symbol). Omit it and listeners get
 * `(rawMsg, null)` and can parse for themselves.
 *
 * `hub.store` is the hub's own normalised snapshot. It doubles as the carry-forward source
 * for processTickerMessage (a tick that omits a field inherits the previous value), so that
 * chain is now single and consistent instead of one per account.
 */
export function subscribeTickers(underlying, symbols, onTicker, onStatus, symbolMeta = null) {
  let hub = hubs.get(underlying);
  if (!hub) {
    hub = { stream: null, symbols: new Set(), listeners: new Set(), rebuildTimer: null, lastStatus: 'reconnecting', meta: {}, store: {} };
    hubs.set(underlying, hub);
  }
  const listener = { symbols: new Set(symbols || []), meta: symbolMeta || {}, onTicker, onStatus };
  hub.listeners.add(listener);
  // Report the current upstream status right away so a late joiner's heartbeat isn't stale.
  if (hub.stream) onStatus?.(hub.lastStatus);
  scheduleRebuild(underlying);

  return {
    update(newSymbols, newMeta = null) {
      listener.symbols = new Set(newSymbols || []);
      if (newMeta) listener.meta = newMeta;
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
