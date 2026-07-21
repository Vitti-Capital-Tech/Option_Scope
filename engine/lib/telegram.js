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
    });
    if (!res.ok) {
      let body = '';
      try { body = JSON.stringify(await res.json()); } catch { /* non-JSON */ }
      logError(`Telegram sendMessage failed: HTTP ${res.status} ${body}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    logError('Telegram sendMessage error:', e.message);
    return { ok: false };
  }
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
