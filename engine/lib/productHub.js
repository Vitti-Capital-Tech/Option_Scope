/**
 * Shared Delta product list (all live call + put options of an underlying) for every
 * account engine in this process.
 *
 * Before: each account engine fetched the full product list from Delta on its own every
 * 5 min (and again on every active-window change) and kept its own copy in memory — 22
 * accounts = 22 copies and 22 fetches, all at once on a window boundary. Now there is ONE
 * list per underlying, shared read-only:
 *   - Per underlying (BTC / ETH never mix).
 *   - One fetch serves everyone: a cached list younger than MAX_AGE_MS is returned as is,
 *     and concurrent callers share the in-flight fetch.
 *   - Read-only: the list and each product are frozen, so no engine can change what the
 *     others see (a mutation throws instead of silently corrupting another account).
 *   - Last good list kept: a failed fetch, an empty list, or a list that suddenly shrank by
 *     more than half keeps the previous list (warning logged) and retries a bit later.
 *   - `force` (an expiry the account needs is missing — just listed or just expired) fetches
 *     fresh at once, de-duplicated and at most once a minute per underlying.
 * Each engine still derives its own expiries / symbol map from the list (per its window/DTE).
 */
import { loadProducts } from './deltaApi.js';
import { logWarn } from './utils.js';

const MAX_AGE_MS = 4 * 60 * 1000;      // the engines' 5-min product timer → one Delta fetch per cycle
const RETRY_AFTER_FAIL_MS = 30 * 1000; // after a failed / rejected fetch, serve the last list this long
const FORCE_MIN_GAP_MS = 60 * 1000;    // forced refreshes per underlying at most this often
const MIN_KEEP_RATIO = 0.5;            // a new list under half the old size is treated as bad

const cache = new Map(); // underlying → { list, fetchedAt, retryAt, forcedAt, inflight }

function freezeList(list) {
  for (const p of list) if (p && typeof p === 'object') Object.freeze(p);
  return Object.freeze(list);
}

export async function getSharedProducts(underlying, { force = false } = {}) {
  const key = String(underlying || '').toUpperCase();
  let e = cache.get(key);
  if (!e) {
    e = { list: null, fetchedAt: 0, retryAt: 0, forcedAt: 0, inflight: null };
    cache.set(key, e);
  }
  if (e.inflight) return e.inflight;
  const now = Date.now();
  if (e.list) {
    if (now < e.retryAt) return e.list;                                // recent failure → last good list
    if (force ? (now - e.forcedAt) < FORCE_MIN_GAP_MS : (now - e.fetchedAt) < MAX_AGE_MS) return e.list;
  }
  if (force) e.forcedAt = now;

  e.inflight = (async () => {
    try {
      const got = await loadProducts(underlying);
      const list = Array.isArray(got) ? got : [];
      const prevLen = e.list?.length || 0;
      if (prevLen > 0 && list.length < prevLen * MIN_KEEP_RATIO) {
        logWarn(`[products] ${key}: Delta returned ${list.length} products (had ${prevLen}) — keeping the last good list.`);
        e.retryAt = Date.now() + RETRY_AFTER_FAIL_MS;
        return e.list;
      }
      e.list = freezeList(list);
      e.fetchedAt = Date.now();
      // An empty list with nothing better to keep is served, but retried soon.
      e.retryAt = list.length ? 0 : Date.now() + RETRY_AFTER_FAIL_MS;
      if (!list.length) e.fetchedAt = 0;
      return e.list;
    } catch (err) {
      if (!e.list) throw err; // nothing to fall back on — the caller logs it, as before
      logWarn(`[products] ${key}: refresh failed (${err.message}) — keeping the last good list.`);
      e.retryAt = Date.now() + RETRY_AFTER_FAIL_MS;
      return e.list;
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}
