/**
 * Cross-account ENTRY GOVERNOR (in-process singleton).
 *
 * Every per-account engine — paper AND live — runs inside ONE Node process (see
 * startPaperTradingEngine → runningEngines). When several accounts try to enter the
 * SAME spread in the same ~1s entry wave, their COMBINED contract size can exceed the
 * real top-of-book depth resting on Delta. Without coordination each account would
 * independently "fill" in paper, painting a picture the live market could never give —
 * and in live each would spend a real order round-trip discovering the book is gone.
 *
 * This governor gates those entries against a SHARED, first-come-first-serve depth
 * budget:
 *
 *   • Each leg (keyed by symbol+side) gets a depth POOL snapshotted from the live feed
 *     the first time it's touched in a window — ask size for a BUY leg, bid size for a
 *     SELL leg — then FROZEN for WINDOW_MS. The first accounts to tick draw the pool
 *     down; once it can't cover an account's full qty, that account is blocked.
 *   • A spread is ALL-OR-NOTHING: both legs must have room for the account's FULL qty
 *     or NEITHER pool is consumed and the whole spread is blocked. We never hand out a
 *     partial / lopsided fill.
 *   • The window resets after WINDOW_MS so the next entry wave re-snapshots fresh
 *     depth. A blocked account simply retries next wave (or takes a different entry) —
 *     "koi aur entry le lenge".
 *   • UNKNOWN depth never blocks: if the feed hasn't delivered a size for a leg, its
 *     pool is treated as unlimited (mirrors the live top-of-book depth guard's policy —
 *     we can't prove a shortfall, so we don't manufacture one).
 *
 * Single-threaded JS makes the reserve body atomic — "first come" is literally "first
 * to call reserveSpread() this window", so no locking is needed.
 *
 * Scope: consulted for PAPER accounts and for ARMED LIVE accounts (`live_enabled`,
 * including dry-run), which share ONE budget so the two modes contend against each
 * other. This module stayed mode-agnostic through that promotion — the caller decides
 * enrolment and supplies the contract counts; nothing here changed.
 */

// One entry wave (per-minute eval, all accounts tick within ~1s of the minute
// boundary) comfortably fits in 8s; the window resets well before the next minute so
// each wave contends against fresh depth. Override with ENTRY_GOVERNOR_WINDOW_MS.
const WINDOW_MS = Math.max(1000, Number(process.env.ENTRY_GOVERNOR_WINDOW_MS ?? 8000));

// key (`${symbol}|${side}`) → { remaining, expiresAt }. `remaining` is Infinity when
// the pool was seeded from an unknown depth (never blocks for that window).
const pools = new Map();

function poolKey(symbol, side) {
  return `${symbol}|${side}`;
}

/**
 * Get the live pool for a leg, (re)snapshotting it if this is the first touch of the
 * window or the previous window expired. `depth` is the current top-of-book size for
 * that side (ask for buy, bid for sell); null/undefined/non-finite → unlimited pool.
 */
function getPool(symbol, side, depth, now) {
  const key = poolKey(symbol, side);
  const existing = pools.get(key);
  if (existing && now < existing.expiresAt) return existing;
  // null/undefined → unknown depth → unlimited pool (never blocks). NB: Number(null)
  // is 0, not NaN, so guard the nullish case explicitly before coercing.
  const d = depth == null ? NaN : Number(depth);
  const fresh = {
    remaining: Number.isFinite(d) ? Math.max(0, d) : Infinity,
    expiresAt: now + WINDOW_MS,
  };
  pools.set(key, fresh);
  return fresh;
}

/**
 * Reserve FULL qty on every leg of a spread, all-or-nothing.
 *
 * @param {Array<{symbol:string, side:'buy'|'sell', qty:number, depth:number|null}>} legs
 *   One entry per leg to govern (buy leg + sell leg; long-only entries pass just the
 *   buy leg). `qty` is the account's intended CONTRACT count for that leg.
 * @param {number} now  epoch ms (passed in so callers/tests control the clock)
 * @returns {{ok:true} | {ok:false, blockedLeg:{symbol,side,qty,available}}}
 *   On ok:false NOTHING is consumed, so the freed depth stays available to the next
 *   account. On ok:true every leg's pool is decremented by its qty.
 */
export function reserveSpread(legs, now = Date.now()) {
  const active = (Array.isArray(legs) ? legs : []).filter(l => l && Number(l.qty) > 0);
  if (active.length === 0) return { ok: true };

  // Pass 1 — resolve every pool and check ALL legs fit before touching any.
  const resolved = active.map(l => ({ leg: l, pool: getPool(l.symbol, l.side, l.depth, now) }));
  for (const { leg, pool } of resolved) {
    const need = Number(leg.qty);
    if (Number.isFinite(pool.remaining) && pool.remaining < need) {
      return {
        ok: false,
        blockedLeg: { symbol: leg.symbol, side: leg.side, qty: need, available: pool.remaining },
      };
    }
  }

  // Pass 2 — all legs fit: consume every pool. (Infinity - n === Infinity, so an
  // unknown-depth pool stays unlimited for the rest of the window.)
  for (const { leg, pool } of resolved) pool.remaining -= Number(leg.qty);
  return { ok: true };
}

/** Test / diagnostics helper: wipe all pools. */
export function _resetGovernor() {
  pools.clear();
}

/** Introspection for logging/tests: current remaining for a leg (Infinity if unknown/unset). */
export function _remaining(symbol, side) {
  const p = pools.get(poolKey(symbol, side));
  return p ? p.remaining : undefined;
}

export const ENTRY_GOVERNOR_WINDOW_MS = WINDOW_MS;
