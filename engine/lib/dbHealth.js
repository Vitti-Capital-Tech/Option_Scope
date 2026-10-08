/**
 * Database (Supabase) health watchdog.
 *
 * Every account engine's heartbeat writes to Supabase every 30s, so the heartbeat is a
 * steady, engine-wide signal of whether the database is reachable. Writers report each
 * outcome here; when NO write has succeeded for DB_ALERT_AFTER_MS (default 45s) while
 * failures keep coming, one Telegram alert goes out (repeated every DB_ALERT_REPEAT_MS,
 * default 10 min, while it lasts), and a "recovered" message follows the first success.
 *
 * The alert can't be stored in the database (it's the thing that is down), so Telegram is
 * the channel. Best-effort: never throws.
 *
 * Env (optional): DB_ALERT_AFTER_MS, DB_ALERT_REPEAT_MS.
 */
import { logWarn } from './utils.js';
import { notifySystem } from './telegram.js';

const ALERT_AFTER_MS = Math.max(10000, Number(process.env.DB_ALERT_AFTER_MS ?? 45000));
const REPEAT_MS = Math.max(60000, Number(process.env.DB_ALERT_REPEAT_MS ?? 600000));

let lastOkAt = Date.now();
let downSince = null;       // first failure after the last success
let failures = 0;           // failures since the last success
let lastError = '';
let lastSource = '';
let alertedAt = null;       // when the current outage was (last) alerted

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
};

/**
 * Turn a Supabase/PostgREST error into one readable line. When Supabase is unreachable,
 * Cloudflare answers with a whole HTML page ("Error code 521") — reduce that to its code.
 */
export function summarizeDbError(err) {
  const msg = String(err?.message ?? err ?? '').trim();
  if (/<!DOCTYPE|<html/i.test(msg)) {
    const code = msg.match(/Error code\s*(\d{3})/i)?.[1] || msg.match(/\b(5\d\d)\b/)?.[1];
    const why = {
      520: 'unknown error from Supabase',
      521: 'Supabase is down / refusing connections',
      522: 'connection to Supabase timed out',
      523: 'Supabase unreachable',
      524: 'Supabase took too long to respond',
      502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout',
    }[code];
    return `HTTP ${code || '?'} (Cloudflare page)${why ? ` — ${why}` : ''}`;
  }
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** A database write succeeded. */
export function reportDbOk() {
  const now = Date.now();
  if (alertedAt != null) {
    notifySystem({
      title: '✅ DATABASE RECOVERED',
      lines: [
        `Supabase writes are working again after ${fmtDur(now - (downSince ?? now))}.`,
        `${failures} write(s) failed meanwhile — dashboard data (heartbeat / live snapshot) may have lagged.`,
      ],
    });
  }
  lastOkAt = now;
  downSince = null;
  failures = 0;
  alertedAt = null;
}

/** A database write failed (`source` = what was being written, e.g. "heartbeat"). */
export function reportDbFailure(source, err) {
  try {
    const now = Date.now();
    if (downSince == null) downSince = now;
    failures += 1;
    lastError = summarizeDbError(err);
    lastSource = source;
    const outage = now - Math.max(lastOkAt, downSince);
    if (outage < ALERT_AFTER_MS || failures < 3) return;
    if (alertedAt != null && now - alertedAt < REPEAT_MS) return;
    const repeat = alertedAt != null;
    alertedAt = now;
    logWarn(`🛑 Database unreachable for ${fmtDur(now - downSince)} (${failures} failed writes) — last: ${lastSource}: ${lastError}`);
    notifySystem({
      title: repeat ? '🛑 DATABASE STILL UNREACHABLE' : '🛑 DATABASE UNREACHABLE',
      lines: [
        `The engine has not been able to write to Supabase for ${fmtDur(now - downSince)} (${failures} failed writes).`,
        `Last error (${lastSource}): ${lastError}`,
        'Dashboard will show "Engine Offline" / stale live tables until it recovers. Check the Supabase dashboard (Reports → Memory / CPU) and status.supabase.com.',
      ],
    });
  } catch { /* never throw from the watchdog */ }
}
