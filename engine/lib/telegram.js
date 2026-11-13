/**
 * Telegram failure alerts for live trading.
 *
 * A tiny, fire-and-forget notifier: when a LIVE order/exchange action fails, the
 * engine calls `notifyLiveFailure(...)` and the user gets a Telegram message with
 * the account, what failed and the error. It is deliberately best-effort — a bad
 * token, network blip or Telegram outage must NEVER crash or block the engine.
 *
 * Setup (env, same mechanism as DELTA_LIVE_DRYRUN etc.):
 *   TELEGRAM_BOT_TOKEN  — from @BotFather (one bot serves every chat)
 *   TELEGRAM_CHAT_ID    — the DEFAULT chat/channel/group id (fallback when an account
 *                         has no per-account chat id of its own)
 *   TELEGRAM_ERROR_CHAT_ID — (optional) the admin / common channel for ERRORS (technical
 *                         format). Unset = TELEGRAM_CHAT_ID is the admin chat. The bot must
 *                         be an admin of that channel. Each account's own alerts chat (else
 *                         its trades chat) additionally gets the error in plain English.
 *   TELEGRAM_DEDUPE_MS  — (optional) suppress identical alerts within this window (default 60000)
 *   TELEGRAM_MIN_GAP_MS — (optional) minimum gap between two sends to the SAME chat (default 1200)
 *   TELEGRAM_GLOBAL_GAP_MS — (optional) minimum gap between ANY two sends, bot-wide (default 150)
 *   TELEGRAM_MAX_RETRIES— (optional) retries after a 429 / other non-network failure (default 3);
 *                         every retry waits the FULL `retry_after` Telegram asked for. A network
 *                         timeout / 5xx instead backs off 2s → 60s and retries for up to 10 min
 *   TELEGRAM_MAX_QUEUE  — (optional) max messages queued per chat before dropping (default 200)
 *
 * Per-account routing: callers may pass a `chatId` (e.g. an account's own
 * `telegram_chat_id`) to send that account's alerts to its own chat. When omitted
 * or empty, alerts go to the default TELEGRAM_CHAT_ID. A send needs the bot token
 * AND some destination (per-account or default); otherwise it is silently disabled,
 * so paper-only / dev deployments need no configuration.
 */
import { log, logError } from './utils.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ERROR_CHAT_ID = process.env.TELEGRAM_ERROR_CHAT_ID || '';
// The bot token is what fundamentally enables Telegram; a destination can come from
// the env default OR a per-account chat id passed at call time.
const ENABLED = !!TOKEN;
const DEDUPE_MS = Math.max(0, Number(process.env.TELEGRAM_DEDUPE_MS ?? 60000));

// Suppress identical alert bursts: dedupeKey → last-sent epoch ms. Bounded so a
// long-running engine can't grow it without limit.
const lastSent = new Map();
const MAX_KEYS = 300;
let warnedDisabled = false;

export function isTelegramEnabled() {
  return ENABLED;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Delivery: per-chat queue + retry ─────────────────────────────────────────
// Telegram rate-limits PER CHAT (a group tolerates roughly 20 messages/minute), and
// this engine's traffic is bursty by construction: every account evaluates on the same
// minute boundary, so their entry notifications hit the API in the same second. A plain
// fire-and-forget POST therefore drops messages exactly when they matter most —
// observed 2026-09-08 02:39/02:40 UTC, BOTH of JD Algo's live entries came back
// `429 Too Many Requests: retry after 8` and were lost, while the partial scale-down
// notifications a dozen minutes later (long after the burst) arrived fine. The account
// never got told it had opened two live positions.
//
// Two changes, neither of which may ever block the engine:
//   1. Serialise per destination with a minimum gap, so a burst is SPREAD instead of
//      racing the limiter. Different chats still send in parallel.
//   2. Retry — honouring Telegram's own `retry_after` on a 429, and a short backoff on
//      network/5xx. A non-429 4xx is permanent (bad token, bad chat id) and is never
//      retried; retrying it would just burn the queue.
//
// Timers are unref'd: a pending retry must not hold the process open through a restart.
const MIN_GAP_MS = Math.max(0, Number(process.env.TELEGRAM_MIN_GAP_MS ?? 1200));
// Telegram enforces TWO ceilings and they fail differently, so both need pacing:
//   • per chat  — ~1/s to a user, ~20/min to a group  → MIN_GAP_MS, per-queue
//   • per BOT   — ~30 messages/second across every chat → GLOBAL_GAP_MS, shared
// The 2026-09-08 429s were on a chat carrying ONE account's traffic (two messages a
// minute apart), which no per-chat limit can explain — every armed account fires on the
// same minute boundary, so the bot-wide ceiling is what gave way. A per-chat queue alone
// would have left those chats free to burst simultaneously all over again.
const GLOBAL_GAP_MS = Math.max(0, Number(process.env.TELEGRAM_GLOBAL_GAP_MS ?? 150));
const MAX_RETRIES = Math.max(0, Number(process.env.TELEGRAM_MAX_RETRIES ?? 3));
const MAX_QUEUE = Math.max(1, Number(process.env.TELEGRAM_MAX_QUEUE ?? 200));
// Telegram's `retry_after` is an instruction, not a hint: sending again BEFORE it has
// elapsed is itself an offence and the ban gets EXTENDED. Capping the honoured wait at
// 30s and retrying anyway therefore deepened exactly the problem it was trying to ride
// out — observed 2026-09-08 06:04 UTC, `retry_after: 424` answered with 4 attempts 30s
// apart, on a chat that had taken 2 messages that minute. So: wait the full asked time,
// and if that exceeds MAX_PARK_MS drop the message rather than retry inside the window.
const MAX_PARK_MS = 600000;       // 10 min — park a message this long at most, then drop it
const FLOOD_THRESHOLD_MS = 60000; // a wait past this is a bot-wide ban, not a per-chat gap
// Generous: a timed-out send is not retried (it may have been delivered), so wait for a slow answer.
const FETCH_TIMEOUT_MS = 30000;
const TRANSIENT_MAX_BACKOFF_MS = 60000; // longest gap between retries while Telegram is unreachable

// dest → { chain: Promise, size: number, nextAt: epoch ms the next send may go out }
const queues = new Map();

// ── Group → supergroup migration ─────────────────────────────────────────────
// When a Telegram group becomes a supergroup (e.g. an admin turns on a supergroup-only
// setting) its chat id CHANGES, and a send to the old id fails with 400
// `parameters.migrate_to_chat_id`. We then (1) resend that message to the new id, (2)
// remember old → new so later sends go straight to the new id, and (3) tell the engine
// (setChatMigrationHandler) so it rewrites every account linked to the old id.
const migratedChats = new Map(); // old chat id → new chat id
let onChatMigrated = null;
/** Register (oldId, newId) => Promise — called once per migrated chat. */
export function setChatMigrationHandler(fn) {
  onChatMigrated = typeof fn === 'function' ? fn : null;
}
/** Record a migration (also used by the engine's /start listener on the service message). */
export function noteChatMigration(oldId, newId) {
  const o = String(oldId), n = String(newId);
  if (!o || !n || o === n || migratedChats.get(o) === n) return false;
  migratedChats.set(o, n);
  log(`Telegram chat ${o} migrated to supergroup ${n} — alerts follow the new id.`);
  if (onChatMigrated) Promise.resolve(onChatMigrated(o, n)).catch(e => logError('Telegram chat migration handler failed:', e?.message || e));
  return true;
}
// Bot-wide floor on the next send, shared by every chat's queue.
let globalNextAt = 0;

// ── Send-volume trace ────────────────────────────────────────────────────────
// A 429 says a ceiling was crossed but not WHICH one or by whom, and successful sends
// were never logged — so after the 2026-09-08 incident there was no way to tell whether
// the chat had taken 2 messages that minute or 40. Both readings pointed at completely
// different fixes and neither could be checked.
//
// Keep a 60s rolling record of send attempts (timestamp + destination). It costs a push
// and a shift per message, and turns the NEXT 429 into a self-explanatory log line
// instead of an inference.
const SEND_LOG_MS = 60000;
const sendLog = [];   // [{ at, dest }], pruned to the last SEND_LOG_MS

function recordSend(dest) {
  const now = Date.now();
  sendLog.push({ at: now, dest });
  while (sendLog.length && now - sendLog[0].at > SEND_LOG_MS) sendLog.shift();
}

/** "12 to this chat, 31 bot-wide, in the last 60s" — the context a 429 needs. */
function volumeSummary(dest) {
  const cutoff = Date.now() - SEND_LOG_MS;
  let mine = 0, all = 0;
  for (const s of sendLog) {
    if (s.at < cutoff) continue;
    all++;
    if (s.dest === dest) mine++;
  }
  return `${mine} to this chat, ${all} bot-wide, in the last ${SEND_LOG_MS / 1000}s`;
}

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (typeof t?.unref === 'function') t.unref();
});

/** One POST attempt. Never throws. `retryAfterMs` non-null ⇒ worth retrying. */
async function postOnce(dest, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: dest,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    const desc = body == null ? '' : JSON.stringify(body);
    const migrateTo = body?.parameters?.migrate_to_chat_id;
    if (res.status === 400 && migrateTo != null) {
      return { ok: false, status: 400, body: desc, migrateTo: String(migrateTo), retryAfterMs: null };
    }
    if (res.status === 429) {
      // Telegram tells us exactly how long to wait; trust it over any backoff we'd invent.
      const secs = Number(body?.parameters?.retry_after);
      const askedMs = (Number.isFinite(secs) && secs > 0 ? secs : 5) * 1000;
      // Past MAX_PARK_MS the alert would be stale by the time it landed and retrying
      // early only renews the ban — report it as non-retryable and let the queue log it.
      return { ok: false, status: 429, body: desc, askedMs, retryAfterMs: askedMs > MAX_PARK_MS ? null : askedMs };
    }
    // 504: Telegram's gateway gave up waiting on its backend, which may still deliver the
    // message — unconfirmed, not retried (see the catch below).
    if (res.status === 504) return { ok: false, status: 504, body: desc, retryAfterMs: null, unconfirmed: true };
    return { ok: false, status: res.status, body: desc, retryAfterMs: res.status >= 500 ? 2000 : null };
  } catch (e) {
    // A TIMEOUT means the request was sent but no answer came back — Telegram may well have
    // delivered it. Retrying those sent the same alert 8–14× once a slow Telegram caught up
    // (2026-11-03 05:29–05:31 UTC), so a timed-out send is reported, not retried. A connection
    // error (DNS, refused, reset before sending) did not reach Telegram → safe to retry.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, status: 0, body: e?.message || String(e), retryAfterMs: timedOut ? null : 2000, unconfirmed: timedOut };
  }
}

/**
 * Park a queue for as long as a failed attempt says it must wait, and return that wait.
 * Called on EVERY failure — including the one we give up on, because the ban outlives
 * the message: releasing the queue after MIN_GAP_MS would fire the next alert straight
 * into the still-running wait and extend it again.
 */
function holdQueue(q, r) {
  const asked = r?.status === 429 ? Math.min(Number(r.askedMs) || 0, MAX_PARK_MS) : 0;
  const holdMs = asked > 0 ? asked : (Number(r?.retryAfterMs) || 0);
  q.nextAt = Date.now() + holdMs + MIN_GAP_MS;
  // A multi-minute wait is a token-wide flood ban: nothing gets through it on any chat,
  // and letting the other queues keep firing just renews it for everyone. Short waits
  // stay local (with only a small global nudge) so one noisy chat can't stall every
  // account's alerts.
  if (asked > 0) {
    const globalWait = asked >= FLOOD_THRESHOLD_MS ? asked : Math.min(asked, 2000);
    globalNextAt = Math.max(globalNextAt, Date.now() + globalWait);
  }
  return holdMs;
}

/** Queue one message behind everything already pending for that chat. */
function enqueue(dest, text) {
  let q = queues.get(dest);
  if (!q) { q = { chain: Promise.resolve(), size: 0, nextAt: 0 }; queues.set(dest, q); }
  if (q.size >= MAX_QUEUE) {
    logError(`Telegram queue full for chat ${dest} (${MAX_QUEUE} pending) — dropping a message.`);
    return Promise.resolve({ ok: false, dropped: true });
  }
  q.size++;
  const run = q.chain.then(async () => {
    // Total time THIS message may spend parked across all its retries. Without it a
    // ban that keeps renewing could hold the queue for MAX_RETRIES × MAX_PARK_MS —
    // most of an hour — while newer, more relevant alerts wait behind it.
    let parkedMs = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        // Wait out whichever ceiling is further away — this chat's own gap, or the bot's.
        // Re-checked before EVERY attempt, not just the first: a 429 anywhere (this queue
        // or another account's) may have pushed the bot-wide floor out while this message
        // was waiting, and re-read after each sleep for the same reason.
        for (;;) {
          const wait = Math.max(q.nextAt, globalNextAt) - Date.now();
          if (wait <= 0) break;
          await sleep(wait);
        }
        globalNextAt = Math.max(globalNextAt, Date.now() + GLOBAL_GAP_MS);
        recordSend(dest);
        let r = await postOnce(dest, text);
        if (!r.ok && r.migrateTo) {
          // Group became a supergroup — resend this message to the new id once.
          noteChatMigration(dest, r.migrateTo);
          recordSend(r.migrateTo);
          r = await postOnce(r.migrateTo, text);
        }
        if (r.ok) { q.nextAt = Date.now() + MIN_GAP_MS; return { ok: true }; }
        // A connection error / 5xx (not a timeout or 504 — those are unconfirmed and not
        // retried) means Telegram never took the message: back off 2 → 4 → 8 … ≤ 60s and keep
        // trying for the whole MAX_PARK_MS budget instead of MAX_RETRIES × 2s.
        const transient = r.retryAfterMs != null && (r.status === 0 || r.status >= 500);
        if (transient) r.retryAfterMs = Math.min(TRANSIENT_MAX_BACKOFF_MS, 2000 * 2 ** attempt);
        // Park the queue for the full wait either way — the ban outlives this message.
        // The gate loop at the top of the next attempt is what actually sleeps it out.
        const holdMs = holdQueue(q, r);
        // Give up when the NEXT wait would push this message past its budget, so
        // `parkedMs` stays the time actually waited and the message never outlives
        // MAX_PARK_MS.
        const givingUp = r.retryAfterMs == null || (!transient && attempt >= MAX_RETRIES)
          || parkedMs + holdMs >= MAX_PARK_MS;
        if (givingUp) {
          logError(`Telegram sendMessage failed: HTTP ${r.status} ${r.body}`
            + (r.unconfirmed
              ? ' (no answer — Telegram may still deliver it; not retried, to avoid duplicates)'
              : r.retryAfterMs == null
              ? ' (not retryable)'
              : ` (gave up after ${attempt + 1} attempts, ${Math.round(parkedMs / 1000)}s parked)`)
            + ` · volume: ${volumeSummary(dest)}`);
          return { ok: false };
        }
        parkedMs += holdMs;
        // The volume line is the whole point: a 429 with "2 to this chat, 38 bot-wide"
        // and one with "24 to this chat, 26 bot-wide" are different problems.
        log(`Telegram HTTP ${r.status} for chat ${dest} — retrying in ${Math.round(holdMs / 1000)}s `
          + `(attempt ${attempt + 1}${transient ? `, ${Math.round(parkedMs / 1000)}s of ${MAX_PARK_MS / 1000}s` : `/${MAX_RETRIES}`}) · volume: ${volumeSummary(dest)}`);
      }
    } finally { q.size--; }
  });
  // A rejection here must not poison the chain for every later message.
  q.chain = run.catch(() => {});
  return run;
}

/** Low-level send. Resolves { ok } and never throws. `chatId` defaults to the env
 * TELEGRAM_CHAT_ID; pass an account's own chat id to route per-account. */
async function sendTelegram(text, chatId) {
  const raw = chatId || CHAT_ID;
  // A chat that migrated to a supergroup: go straight to its new id.
  const dest = raw ? (migratedChats.get(String(raw)) || raw) : raw;
  if (!TOKEN || !dest) {
    if (!warnedDisabled) {
      log('Telegram alerts disabled (set TELEGRAM_BOT_TOKEN + a chat id — global TELEGRAM_CHAT_ID or per-account — to enable).');
      warnedDisabled = true;
    }
    return { ok: false, disabled: true };
  }
  return enqueue(String(dest), text);
}

// ── Alert severity — can this cost money? ─────────────────────────────────────────
// Every live alert is tagged with one of three levels so the group can tell at a glance
// whether to act. Classified here, in one place, from the alert's error code, its text and
// the order tag in `extra` — so every caller (engine + liveExecution) is covered. A caller
// may force a level with `severity: 'critical' | 'high' | 'low'`.
const SEVERITY = {
  critical: { head: '🔴 <b>CRITICAL — LIVE ALERT</b>', risk: '💸 <b>Money at risk: YES</b> — a position may be open on Delta without protection or tracking. Act now.' },
  high: { head: '🟠 <b>CHECK SOON — LIVE ALERT</b>', risk: '⚠️ <b>Money at risk: POSSIBLE</b> — the engine and Delta may disagree, or an exit order is not resting. Check soon.' },
  low: { head: '🟡 <b>NO MONEY RISK — LIVE ALERT</b>', risk: '✅ <b>Money at risk: NO</b> — nothing was left open; at most a small fee / spread cost. No action needed.' },
};
// Order-tag suffixes (client_order_id) of ENTRY orders: a failed entry order leaves nothing open
// (the entry is aborted / unwound). NOT the unwind closes (-EAB / -EAS / -ORPHX): if one of those
// fails, a leg of the aborted entry is left open — that is critical. Everything else that fails
// is an exit or protection order.
const ENTRY_TAG_RE = /-(EB|ES|HB)\]?\s*$/i;
const CRITICAL_CODES = new Set(['orphan-unprotected-unknown', 'untracked-short', 'untracked-long-with-short', 'untracked-long-breached', 'short-without-long']);
const HIGH_CODES = new Set(['positions-all-missing', 'close-unverified', 'short-close-unverified', 'orphan-protected', 'orphan-collision-protected', 'swap-not-flat', 'hedge-close-failed', 'hedge-not-filled', 'pexclean-failed', 'hedge-bracket-move-failed']);

export function classifyAlert({ context = '', errMsg = '', extra = '', severity = null } = {}) {
  if (severity && SEVERITY[severity]) return severity;
  const code = String(errMsg || '').trim();
  if (CRITICAL_CODES.has(code)) return 'critical';
  if (HIGH_CODES.has(code)) return 'high';
  const c = String(context);
  // Aborted / unwound entries: the account was left flat.
  if (/Entry ABORTED|Entry not persisted/i.test(c)) return 'low';
  // A hedge whose close failed stays tracked and is retried (resting limit sell) — check, not panic.
  if (/Hedge close FAILED|-HXL?\d*\]/i.test(c + ' ' + extra)) return 'high';
  // Case-sensitive on purpose: the real "nothing protects this leg" alerts say UNPROTECTED in
  // capitals; "risk exit may be unprotected" (a failed bracket — the engine's own exit still
  // runs) is a check-soon, not a critical.
  if (/UNPROTECTED|Protective market close FAILED|NO Delta credentials/.test(c)) return 'critical';
  // A failed order: entry orders leave nothing open; exit / close orders may leave a leg open.
  if (/Order send FAILED|CLOSE FAILED|STOP placement FAILED/i.test(c)) {
    if (ENTRY_TAG_RE.test(String(extra))) return 'low';
    return /CLOSE FAILED/i.test(c) ? 'critical' : 'high';
  }
  // Unknown → assume it needs a look (never under-state a live problem).
  return 'high';
}

// ── User-facing format ───────────────────────────────────────────────────────────
// Two audiences (2026-11-13): the admin / common group (TELEGRAM_ERROR_CHAT_ID, else
// TELEGRAM_CHAT_ID) gets every error in the technical format above; the account's own
// chat — its alerts chat (telegram_alert_chat_id), else its trades chat — gets the same
// error in plain English with IST time. Trade messages (entries / exits) use the plain
// format everywhere.

/** "12 Nov, 5:00 PM IST" */
export function istTime(ms = Date.now()) {
  try {
    const s = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms));
    return `${s.replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toUpperCase()}`)} IST`;
  } catch {
    return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Delta option symbol → "BTC PUT 73200 (12 Nov)"; anything else is returned as is. */
export function prettySymbol(sym) {
  const m = String(sym || '').match(/^([CP])-([A-Z]+)-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return String(sym || '');
  const [, cp, und, strike, dd, mm] = m;
  return `${und} ${cp === 'C' ? 'CALL' : 'PUT'} ${strike} (${Number(dd)} ${MONTHS[Number(mm) - 1] || mm})`;
}

const SYMBOL_RE = /\b[CP]-[A-Z]+-\d+(?:\.\d+)?-\d{6}\b/;

// What happened, in plain words — matched on the alert's technical "What" text.
// `body` may use {sym} (pretty symbol from the alert, or "a position").
const FRIENDLY_RULES = [
  { re: /Entry ABORTED|Entry not persisted/i, title: 'New trade cancelled', body: 'A new trade could not be fully placed on Delta, so the algo closed whatever had opened. Nothing is left open from it.' },
  { re: /NO Delta credentials/i, title: 'Delta API not connected', body: 'The algo cannot reach your Delta account, so no orders can be placed.', action: 'Please re-check the Delta API key in the account settings.' },
  { re: /UNPROTECTED/, title: 'Position without protection', body: '{sym} is open on Delta without a stop-loss order.', action: 'Please check this position in the Delta app now.' },
  { re: /Hedge close FAILED/i, title: 'Hedge not closed yet', body: 'A hedge leg could not be closed on Delta. The algo keeps it tracked and retries every 5 minutes.' },
  { re: /Protective market close FAILED|CLOSE FAILED|cleanup market-close FAILED/i, title: 'Exit order failed', body: 'The algo tried to close {sym}, but Delta rejected the order. The position may still be open.', action: 'Please check this position in the Delta app.' },
  { re: /STOP placement FAILED|Exit bracket .*FAILED/i, title: 'Stop-loss order not placed', body: 'The protective stop on {sym} could not be placed on Delta. The algo still watches the price and will exit on its own.', action: 'Please keep an eye on this position.' },
  { re: /Order send FAILED/i, title: 'Order rejected by Delta', body: 'Delta rejected an order for {sym}.' },
  { re: /has NO resting|buy-back/i, title: 'Exit order not on Delta', body: 'The exit order for the short leg {sym} is not resting on Delta yet. The algo retries every 2 minutes.' },
  { re: /Untracked|untracked|Orphan|orphan/, title: 'Unknown position on Delta', body: '{sym} is open on Delta but is not managed by the algo (for example a manual trade).', action: 'Please check it in the Delta app.' },
  { re: /missing from Delta|shows NONE|is missing/i, title: 'Position not found on Delta', body: 'A position the algo tracks ({sym}) is not showing on Delta. The algo is re-checking.' },
  { re: /is open on/i, title: 'Position mismatch', body: '{sym} on Delta does not match what the algo expects.', action: 'Please check this position in the Delta app.' },
  { re: /PAUSED — no schedule windows/i, title: 'Account paused', body: 'No trading time windows were found, so new trades are paused. Open positions are still managed.', action: 'Please add your schedule windows again and resume the account.' },
  { re: /Schedule windows RESTORED/i, title: 'Trading schedule restored', body: 'Your trading time windows went missing and were restored automatically from the last saved copy.' },
  { re: /Evaluation cycle hung/i, title: 'Short delay', body: 'The algo had a short delay and recovered on its own.' },
  { re: /Leg swap/i, title: 'Trade replacement issue', body: 'A position was replaced, but one leg ({sym}) may not have closed fully.', action: 'Please check it in the Delta app.' },
  { re: /Shared hedge/i, title: 'Hedge update issue', body: 'The stop on the shared hedge {sym} could not be updated on Delta.' },
];

const USER_SEVERITY = {
  critical: { icon: '🔴', note: '👉 Action needed now.' },
  high: { icon: '🟠', note: '👉 Please check soon.' },
  low: { icon: '🟢', note: 'No money at risk — no action needed.' },
};

export function friendlyAlert({ context = '', extra = '' } = {}) {
  const text = `${context} ${extra}`;
  const rule = FRIENDLY_RULES.find(r => r.re.test(context)) || null;
  const symM = text.match(SYMBOL_RE);
  const sym = symM ? prettySymbol(symM[0]) : 'a position';
  if (!rule) return { title: 'Something needs attention', body: 'The algo ran into an issue on your account. Our team has been notified.', action: '' };
  return { title: rule.title, body: rule.body.replace(/\{sym\}/g, sym), action: rule.action || '' };
}

function userAlertText({ account, context, extra, sevKey, ms }) {
  const f = friendlyAlert({ context, extra });
  const sev = USER_SEVERITY[sevKey] || USER_SEVERITY.high;
  return [
    `${sev.icon} <b>${escapeHtml(f.title)}</b>`,
    `Account: <b>${escapeHtml(account)}</b>`,
    '',
    escapeHtml(f.body),
    f.action ? `\n👉 ${escapeHtml(f.action)}` : `\n${sev.note}`,
    `\n🕐 ${istTime(ms)}`,
  ].join('\n');
}

/** True (and records it) unless the same key was sent within DEDUPE_MS. */
function firstInWindow(key, now) {
  const prev = lastSent.get(key);
  if (prev != null && now - prev < DEDUPE_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > MAX_KEYS) {
    // Drop the oldest ~10% to keep the map bounded.
    const drop = Math.ceil(MAX_KEYS * 0.1);
    let i = 0;
    for (const k of lastSent.keys()) { lastSent.delete(k); if (++i >= drop) break; }
  }
  return true;
}

/** Where an account's user-facing alert goes, or '' when that would only repeat the admin chat. */
function userAlertDest({ chatId, alertChatId }) {
  const dest = alertChatId || chatId || '';
  const admin = ERROR_CHAT_ID || CHAT_ID;
  return dest && String(dest) !== String(admin) ? String(dest) : '';
}

/**
 * Alert a LIVE trading failure. Fire-and-forget: callers do NOT await it, and identical
 * alerts within TELEGRAM_DEDUPE_MS are coalesced so a failure that repeats every engine
 * cycle doesn't spam the chat. Each alert carries its severity (classifyAlert).
 *
 * Two destinations: the admin / common group (TELEGRAM_ERROR_CHAT_ID, else TELEGRAM_CHAT_ID)
 * gets the technical format; the account's alerts chat (else its trades chat) gets the same
 * alert in plain English (userAlertText).
 *
 * @param {Object} p
 * @param {string} p.account  account name (for the message + dedupe key)
 * @param {string} p.context  short description of what failed
 * @param {any}    [p.error]  Error object or message string
 * @param {string} [p.extra]  optional extra line (e.g. strikes / order id)
 * @param {string} [p.severity] force 'critical' | 'high' | 'low' (else classified)
 * @param {string} [p.chatId] the account's trades chat (telegram_chat_id)
 * @param {string} [p.alertChatId] the account's alerts chat (telegram_alert_chat_id)
 */
export function notifyLiveFailure({ account = '—', context = 'Live failure', error = '', extra = '', chatId = '', alertChatId = '', severity = null } = {}) {
  if (!ENABLED) return;
  const errMsg = error?.message ?? (error ? String(error) : '');
  const now = Date.now();
  const sevKey = classifyAlert({ context, errMsg, extra, severity });

  // Fire-and-forget — never block the engine on the network round-trip.
  const adminDest = ERROR_CHAT_ID || CHAT_ID;
  if (adminDest && firstInWindow(`${adminDest}|${account}|${context}|${errMsg}`, now)) {
    const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const sev = SEVERITY[sevKey];
    const lines = [
      sev.head,
      `<b>Account:</b> ${escapeHtml(account)}`,
      `<b>What:</b> ${escapeHtml(context)}`,
      errMsg ? `<b>Error:</b> ${escapeHtml(errMsg)}` : '',
      extra ? escapeHtml(extra) : '',
      sev.risk,
      `<i>${ts} UTC</i>`,
    ].filter(Boolean);
    sendTelegram(lines.join('\n'), adminDest).catch(() => {});
  }
  const userDest = userAlertDest({ chatId, alertChatId });
  if (userDest && firstInWindow(`${userDest}|${account}|${context}|${errMsg}`, now)) {
    sendTelegram(userAlertText({ account, context, extra, sevKey, ms: now }), userDest).catch(() => {});
  }
}

/**
 * Tell the chats that an earlier live alert has cleared (✅ RESOLVED). Sent once per
 * resolved issue — the engine tracks which condition-based alerts are still open and calls
 * this when the condition goes away. Same routing as notifyLiveFailure: technical to the
 * admin group, plain English to the account's alerts (else trades) chat.
 *
 * @param {Object} p
 * @param {string} p.account  account name
 * @param {string} p.context  the original alert's "What" text
 * @param {string} p.how      how it resolved (one line)
 * @param {number} [p.openMs] how long the issue was open
 * @param {string} [p.chatId] the account's trades chat
 * @param {string} [p.alertChatId] the account's alerts chat
 */
export function notifyLiveResolved({ account = '—', context = '', how = '', openMs = null, chatId = '', alertChatId = '' } = {}) {
  if (!ENABLED) return;
  const now = Date.now();
  const adminDest = ERROR_CHAT_ID || CHAT_ID;
  if (adminDest) {
    const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const dur = openMs == null ? '' : (openMs < 60000 ? `${Math.max(1, Math.round(openMs / 1000))}s`
      : openMs < 3600000 ? `${Math.round(openMs / 60000)}m` : `${(openMs / 3600000).toFixed(1)}h`);
    const text = [
      '✅ <b>RESOLVED — LIVE ALERT</b>',
      `<b>Account:</b> ${escapeHtml(account)}`,
      context ? `<b>Was:</b> ${escapeHtml(context)}` : '',
      how ? `<b>Now:</b> ${escapeHtml(how)}` : '',
      dur ? `<b>Open for:</b> ${dur}` : '',
      `<i>${ts} UTC</i>`,
    ].filter(Boolean).join('\n');
    sendTelegram(text, adminDest).catch(() => {});
  }
  const userDest = userAlertDest({ chatId, alertChatId });
  if (userDest) {
    const f = friendlyAlert({ context });
    const text = [
      `✅ <b>Resolved: ${escapeHtml(f.title)}</b>`,
      `Account: <b>${escapeHtml(account)}</b>`,
      '',
      'The earlier issue has been fixed. No action needed.',
      `\n🕐 ${istTime(now)}`,
    ].join('\n');
    sendTelegram(text, userDest).catch(() => {});
  }
}

const fmtUsd = (v) => `${Number(v) < 0 ? '−' : ''}$${Math.abs(Number(v)).toFixed(2)}`;

/**
 * Notify a LIVE trade event — an entry or an exit — in the plain format. Fire-and-forget
 * and NOT de-duplicated (every trade is a distinct event). Callers gate this on armed-real
 * live accounts, so paper and dry-run runs never notify.
 *
 * @param {Object} p
 * @param {string} p.account   account name
 * @param {string} p.title     short event title incl. emoji (e.g. "📥 New trade")
 * @param {string} [p.detail]  one-line detail, used when `lines` is not given
 * @param {string[]} [p.lines] plain lines shown under the title (preferred over `detail`)
 * @param {number} [p.pnl]     realized net PnL for exits (omit for entries)
 * @param {string} [p.pnlLabel] label for the PnL line (default Profit / Loss by sign)
 * @param {string} [p.chatId]  per-account Telegram chat id (falls back to env default)
 */
export function notifyLiveTrade({ account = '—', title = 'Trade', detail = '', lines = null, pnl = null, pnlLabel = '', chatId = '' } = {}) {
  if (!ENABLED) return;
  const hasPnl = pnl != null && Number.isFinite(Number(pnl));
  const pnlLine = hasPnl
    ? `${Number(pnl) >= 0 ? '🟢' : '🔴'} ${escapeHtml(pnlLabel || (Number(pnl) >= 0 ? 'Profit' : 'Loss'))}: <b>${Number(pnl) >= 0 ? '+' : ''}${fmtUsd(pnl)}</b>`
    : '';
  const body = Array.isArray(lines) && lines.length ? lines.filter(Boolean).map(escapeHtml) : (detail ? [escapeHtml(detail)] : []);
  const text = [
    `<b>${escapeHtml(title) || 'Trade'}</b>`,
    `Account: <b>${escapeHtml(account)}</b>`,
    '',
    ...body,
    pnlLine ? `\n${pnlLine}` : '',
    `\n🕐 ${istTime()}`,
  ].filter((l, i) => l !== '' || i === 2).join('\n');
  sendTelegram(text, chatId).catch(() => {});
}

/**
 * Send a plain one-off message to a specific chat id (used by the /start deep-link
 * listener to confirm a successful account↔chat binding). Fire-and-forget; resolves
 * { ok } and never throws.
 *
 * @param {string|number} chatId  destination chat id (required — no global fallback)
 * @param {string}        text    message text (HTML parse mode)
 */
/**
 * Engine-wide (not per-account) alert, e.g. the database being unreachable. Goes to the
 * error channel when configured, else the default chat. Fire-and-forget; NOT de-duplicated
 * (callers rate-limit their own alerts). `lines` are plain text and are HTML-escaped.
 */
export function notifySystem({ title, lines = [] } = {}) {
  if (!ENABLED) return;
  const dest = ERROR_CHAT_ID || CHAT_ID;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = [`<b>${escapeHtml(title)}</b>`, ...lines.filter(Boolean).map(escapeHtml), `<i>${ts} UTC</i>`].join('\n');
  sendTelegram(text, dest).catch(() => {});
}

export function sendTelegramMessage(chatId, text) {
  if (!chatId) return Promise.resolve({ ok: false });
  return sendTelegram(text, chatId);
}
