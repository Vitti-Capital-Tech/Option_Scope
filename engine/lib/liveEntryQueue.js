/**
 * Live entry queue — armed REAL live accounts place entry orders ONE AT A TIME, in a fixed
 * priority order, and each one re-reads Delta's real order book right before it sends.
 *
 * Why (2026-11-18, P-BTC-61600 hedge @ $4): four live accounts bought the same hedge inside
 * 1.3 s. The first three took the $4 level; the fourth (a group master) filled $4.8–$6. The
 * per-account depth guard and the cross-account governor both judged on a feed snapshot
 * taken before any of those fills, so nothing stopped the fourth order.
 *
 * Rule:
 *   1. Order: group MASTERS first, then every other account; inside each, oldest account
 *      (created_at) first. Fixed — the same account always goes first.
 *   2. One account at a time: the next account starts only after the previous one's
 *      orders have finished (filled or aborted), so its book read already reflects them.
 *   3. Before sending, each leg's quantity must be available in the REAL book at a price no
 *      worse than the price the entry was evaluated on (buy: ask levels ≤ that price; sell:
 *      bid levels ≥ that price). Short of that, or the book can't be read → skip this minute.
 *
 * The queue waits BATCH_MS after the first request of a wave before handing out the first
 * turn, so the whole minute's wave is in the list and sorted before anyone goes. A request
 * that arrives later is sorted into the remaining list. A turn not released within
 * MAX_HOLD_MS is released automatically (an error path can never freeze the queue).
 */
import { apiGet } from './deltaApi.js';
import { supabase } from './supabase.js';
import { log, logWarn } from './utils.js';

const BATCH_MS = Math.max(0, Number(process.env.LIVE_QUEUE_BATCH_MS ?? 2000));
const MAX_HOLD_MS = Math.max(10000, Number(process.env.LIVE_QUEUE_MAX_HOLD_MS ?? 90000));
const LEADER_REFRESH_MS = 60_000;
// Allowed price give in the real-book check, % of the evaluated price (0 = no worse at all).
const BOOK_TOLERANCE_PCT = Math.max(0, Number(process.env.LIVE_BOOK_TOLERANCE_PCT ?? 0));

// ── Group masters (account_groups.leader_account_id), refreshed every minute ──
let leaderIds = new Set();
let leadersAt = 0;
let leadersInflight = null;
async function refreshLeaders() {
  if (Date.now() - leadersAt < LEADER_REFRESH_MS) return;
  if (leadersInflight) return leadersInflight;
  leadersInflight = (async () => {
    try {
      const { data, error } = await supabase.from('account_groups').select('leader_account_id');
      if (!error && Array.isArray(data)) {
        leaderIds = new Set(data.map(r => r.leader_account_id).filter(Boolean));
        leadersAt = Date.now();
      }
    } catch { /* keep the last list */ } finally { leadersInflight = null; }
  })();
  return leadersInflight;
}
export function isGroupMaster(accountId) { return leaderIds.has(accountId); }

/** Sort key: masters first (0), others after (1); then oldest account first. */
export async function entryPriority(account) {
  await refreshLeaders();
  const created = Date.parse(account?.created_at ?? '');
  return [isGroupMaster(account?.id) ? 0 : 1, Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER];
}
const cmp = (a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]) || (a.seq - b.seq);

// ── The queue ──
const pending = [];   // { key, seq, name, resolve, reject, timer }
let busy = false;
let batchTimer = null;
let seqNo = 0;

function dispatch() {
  if (busy || pending.length === 0) return;
  pending.sort(cmp);
  const next = pending.shift();
  clearTimeout(next.timer);
  busy = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(holdTimer);
    busy = false;
    dispatch();
  };
  const holdTimer = setTimeout(() => {
    if (released) return;
    logWarn(`[live-queue] ${next.name} held its entry turn > ${Math.round(MAX_HOLD_MS / 1000)}s — releasing it so the queue keeps moving.`);
    release();
  }, MAX_HOLD_MS);
  next.resolve(release);
}

/**
 * Wait for this account's turn. Resolves with `release()` — call it when the entry's orders
 * are done (always, in a finally). Rejects with Error('queue-timeout') if the turn does not
 * come within `maxWaitMs` (the caller skips this minute instead of tripping its time budget).
 */
export function acquireEntryTurn(key, name, maxWaitMs) {
  return new Promise((resolve, reject) => {
    const item = { key, seq: seqNo++, name, resolve, reject, timer: null };
    item.timer = setTimeout(() => {
      const i = pending.indexOf(item);
      if (i >= 0) { pending.splice(i, 1); reject(new Error('queue-timeout')); }
    }, Math.max(0, maxWaitMs));
    pending.push(item);
    // First request of a wave (queue idle, no batch pending): give the rest of the wave
    // BATCH_MS to arrive, then go. While a turn is running, release() dispatches the next.
    if (!busy && !batchTimer) {
      batchTimer = setTimeout(() => { batchTimer = null; dispatch(); }, BATCH_MS);
    }
  });
}

// ── Real order book check ──
/**
 * legs: [{ symbol, side: 'buy'|'sell', qty (contracts), price (evaluated quote) }]
 * Returns { ok, lines[], short? } — ok only if EVERY leg's qty is available at a price no
 * worse than its evaluated price. A book that cannot be read counts as not ok.
 */
export async function checkRealBook(legs) {
  const lines = [];
  for (const l of legs) {
    if (!(l.qty > 0)) continue;
    let book;
    try {
      book = await apiGet(`/v2/l2orderbook/${encodeURIComponent(l.symbol)}`, { depth: 50 });
    } catch (e) {
      return { ok: false, lines, short: `${l.symbol}: order book read failed (${e.message})` };
    }
    const levels = (l.side === 'buy' ? book?.sell : book?.buy) || [];
    const limit = l.side === 'buy' ? l.price * (1 + BOOK_TOLERANCE_PCT / 100) : l.price * (1 - BOOK_TOLERANCE_PCT / 100);
    const okPrice = (p) => (l.side === 'buy' ? p <= limit + 1e-9 : p >= limit - 1e-9);
    let avail = 0;
    for (const lv of levels) {
      const p = Number(lv.price), s = Number(lv.size);
      if (Number.isFinite(p) && Number.isFinite(s) && okPrice(p)) avail += s;
    }
    const prices = levels.map(lv => Number(lv.price)).filter(Number.isFinite);
    const best = prices.length ? (l.side === 'buy' ? Math.min(...prices) : Math.max(...prices)) : null;
    const at = `${l.side === 'buy' ? '≤' : '≥'} $${+limit.toFixed(4)}`;
    lines.push(`${l.side} ${l.qty} ${l.symbol}: ${avail} available at ${at} (best $${best ?? '—'})`);
    if (avail < l.qty) {
      return {
        ok: false, lines, short: `${l.symbol}: need ${l.qty}, book has ${avail} at ${at} (best $${best ?? '—'})`,
        // Structured, for the Entry Blocks panel (which leg, how much, at what price).
        blocked: { side: l.side, symbol: l.symbol, qty: l.qty, avail, limit: +limit.toFixed(4), best },
      };
    }
  }
  return { ok: true, lines };
}

export function _queueState() { return { busy, pending: pending.map(p => ({ name: p.name, key: p.key })) }; }
export const LIVE_QUEUE_BATCH_MS = BATCH_MS;
log(`[live-queue] live entries: one account at a time, masters first then oldest account; real book re-checked before each order (batch ${BATCH_MS}ms, price tolerance ${BOOK_TOLERANCE_PCT}%).`);
