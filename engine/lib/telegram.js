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
 *   TELEGRAM_DEDUPE_MS  — (optional) suppress identical alerts within this window (default 60000)
 *   TELEGRAM_MIN_GAP_MS — (optional) minimum gap between two sends to the SAME chat (default 1200)
 *   TELEGRAM_GLOBAL_GAP_MS — (optional) minimum gap between ANY two sends, bot-wide (default 150)
 *   TELEGRAM_MAX_RETRIES— (optional) retries after a 429 / transient failure (default 3);
 *                         every retry waits the FULL `retry_after` Telegram asked for
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
const FETCH_TIMEOUT_MS = 15000;

// dest → { chain: Promise, size: number, nextAt: epoch ms the next send may go out }
const queues = new Map();
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
    if (res.status === 429) {
      // Telegram tells us exactly how long to wait; trust it over any backoff we'd invent.
      const secs = Number(body?.parameters?.retry_after);
      const askedMs = (Number.isFinite(secs) && secs > 0 ? secs : 5) * 1000;
      // Past MAX_PARK_MS the alert would be stale by the time it landed and retrying
      // early only renews the ban — report it as non-retryable and let the queue log it.
      return { ok: false, status: 429, body: desc, askedMs, retryAfterMs: askedMs > MAX_PARK_MS ? null : askedMs };
    }
    return { ok: false, status: res.status, body: desc, retryAfterMs: res.status >= 500 ? 2000 : null };
  } catch (e) {
    return { ok: false, status: 0, body: e?.message || String(e), retryAfterMs: 2000 };
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
        const r = await postOnce(dest, text);
        if (r.ok) { q.nextAt = Date.now() + MIN_GAP_MS; return { ok: true }; }
        // Park the queue for the full wait either way — the ban outlives this message.
        // The gate loop at the top of the next attempt is what actually sleeps it out.
        const holdMs = holdQueue(q, r);
        // Give up when the NEXT wait would push this message past its budget, so
        // `parkedMs` stays the time actually waited and the message never outlives
        // MAX_PARK_MS.
        const givingUp = r.retryAfterMs == null || attempt >= MAX_RETRIES
          || parkedMs + holdMs >= MAX_PARK_MS;
        if (givingUp) {
          logError(`Telegram sendMessage failed: HTTP ${r.status} ${r.body}`
            + (r.retryAfterMs == null
              ? ' (not retryable)'
              : ` (gave up after ${attempt + 1} attempts, ${Math.round(parkedMs / 1000)}s parked)`)
            + ` · volume: ${volumeSummary(dest)}`);
          return { ok: false };
        }
        parkedMs += holdMs;
        // The volume line is the whole point: a 429 with "2 to this chat, 38 bot-wide"
        // and one with "24 to this chat, 26 bot-wide" are different problems.
        log(`Telegram HTTP ${r.status} for chat ${dest} — retrying in ${Math.round(holdMs / 1000)}s `
          + `(attempt ${attempt + 1}/${MAX_RETRIES}) · volume: ${volumeSummary(dest)}`);
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
  const dest = chatId || CHAT_ID;
  if (!TOKEN || !dest) {
    if (!warnedDisabled) {
      log('Telegram alerts disabled (set TELEGRAM_BOT_TOKEN + a chat id — global TELEGRAM_CHAT_ID or per-account — to enable).');
      warnedDisabled = true;
    }
    return { ok: false, disabled: true };
  }
  return enqueue(String(dest), text);
}

/**
 * Alert the user to a critical LIVE trading failure. Fire-and-forget: callers do
 * NOT await it, and identical alerts within TELEGRAM_DEDUPE_MS are coalesced so a
 * failure that repeats every engine cycle doesn't spam the chat.
 *
 * @param {Object} p
 * @param {string} p.account  account name (for the message + dedupe key)
 * @param {string} p.context  short description of what failed
 * @param {any}    [p.error]  Error object or message string
 * @param {string} [p.extra]  optional extra line (e.g. strikes / order id)
 * @param {string} [p.chatId] per-account Telegram chat id (falls back to env default)
 */
export function notifyLiveFailure({ account = '—', context = 'Live failure', error = '', extra = '', chatId = '' } = {}) {
  if (!ENABLED) return;
  const errMsg = error?.message ?? (error ? String(error) : '');
  const now = Date.now();
  const dedupeKey = `${chatId || CHAT_ID}|${account}|${context}|${errMsg}`;
  const prev = lastSent.get(dedupeKey);
  if (prev != null && now - prev < DEDUPE_MS) return; // duplicate burst — skip
  lastSent.set(dedupeKey, now);
  if (lastSent.size > MAX_KEYS) {
    // Drop the oldest ~10% to keep the map bounded.
    const drop = Math.ceil(MAX_KEYS * 0.1);
    let i = 0;
    for (const k of lastSent.keys()) { lastSent.delete(k); if (++i >= drop) break; }
  }

  const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '🚨 <b>LIVE TRADING FAILURE</b>',
    `<b>Account:</b> ${escapeHtml(account)}`,
    `<b>What:</b> ${escapeHtml(context)}`,
    errMsg ? `<b>Error:</b> ${escapeHtml(errMsg)}` : '',
    extra ? escapeHtml(extra) : '',
    `<i>${ts} UTC</i>`,
  ].filter(Boolean);

  // Fire-and-forget — never block the engine on the network round-trip. Routes to the
  // account's own chat when a chatId is supplied, else the global default.
  sendTelegram(lines.join('\n'), chatId).catch(() => {});
}

/**
 * Notify the user of a LIVE trade event — an entry or an exit. Fire-and-forget and
 * NOT de-duplicated (every trade is a distinct event). Callers gate this on armed-real
 * live accounts, so paper and dry-run runs never notify.
 *
 * @param {Object} p
 * @param {string} p.account   account name
 * @param {string} p.title     short event title incl. emoji (e.g. "📥 LIVE ENTRY")
 * @param {string} [p.detail]  one-line detail (strikes / qty / reason)
 * @param {number} [p.pnl]     realized net PnL for exits (omit for entries)
 * @param {string} [p.chatId]  per-account Telegram chat id (falls back to env default)
 */
export function notifyLiveTrade({ account = '—', title = 'Trade', detail = '', pnl = null, chatId = '' } = {}) {
  if (!ENABLED) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const hasPnl = pnl != null && Number.isFinite(Number(pnl));
  const pnlLine = hasPnl
    ? `<b>PnL:</b> ${Number(pnl) >= 0 ? '🟢 +' : '🔴 −'}$${Math.abs(Number(pnl)).toFixed(2)}`
    : '';
  const lines = [
    `<b>${escapeHtml(title) || 'Trade'}</b>`,
    `<b>Account:</b> ${escapeHtml(account)}`,
    detail ? escapeHtml(detail) : '',
    pnlLine,
    `<i>${ts} UTC</i>`,
  ].filter(Boolean);
  sendTelegram(lines.join('\n'), chatId).catch(() => {});
}

/**
 * Send a plain one-off message to a specific chat id (used by the /start deep-link
 * listener to confirm a successful account↔chat binding). Fire-and-forget; resolves
 * { ok } and never throws.
 *
 * @param {string|number} chatId  destination chat id (required — no global fallback)
 * @param {string}        text    message text (HTML parse mode)
 */
export function sendTelegramMessage(chatId, text) {
  if (!chatId) return Promise.resolve({ ok: false });
  return sendTelegram(text, chatId);
}
