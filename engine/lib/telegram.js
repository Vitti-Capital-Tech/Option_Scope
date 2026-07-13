/**
 * Telegram failure alerts for live trading.
 *
 * A tiny, fire-and-forget notifier: when a LIVE order/exchange action fails, the
 * engine calls `notifyLiveFailure(...)` and the user gets a Telegram message with
 * the account, what failed and the error. It is deliberately best-effort — a bad
 * token, network blip or Telegram outage must NEVER crash or block the engine.
 *
 * Setup (env, same mechanism as DELTA_LIVE_DRYRUN etc.):
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — the chat/channel/group id to send alerts to
 *   TELEGRAM_DEDUPE_MS  — (optional) suppress identical alerts within this window (default 60000)
 *
 * If either token or chat id is missing, alerts are silently disabled (logged once),
 * so paper-only / dev deployments need no configuration.
 */
import { log, logError } from './utils.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ENABLED = !!(TOKEN && CHAT_ID);
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

/** Low-level send. Resolves { ok } and never throws. */
async function sendTelegram(text) {
  if (!ENABLED) {
    if (!warnedDisabled) {
      log('Telegram alerts disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable).');
      warnedDisabled = true;
    }
    return { ok: false, disabled: true };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
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
 */
export function notifyLiveFailure({ account = '—', context = 'Live failure', error = '', extra = '' } = {}) {
  if (!ENABLED) return;
  const errMsg = error?.message ?? (error ? String(error) : '');
  const now = Date.now();
  const dedupeKey = `${account}|${context}|${errMsg}`;
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

  // Fire-and-forget — never block the engine on the network round-trip.
  sendTelegram(lines.join('\n')).catch(() => {});
}
