/**
 * Daily report tracker for ONE live account → `live_daily_stats` (migration 045).
 *
 * Fed by the engine's live snapshot (~every 10s, armed live accounts only):
 *   • margin used = wallet balance − Delta's available_balance; the day's peak is kept in
 *     memory and saved as it rises (at most once a minute), so a restart doesn't lose it —
 *     the row is reloaded on start.
 *   • opening balance = the previous day's closing balance (else the first one seen today);
 *     closing balance and open-position unrealized P&L = the latest sample.
 *   • every 5 min the day's totals are recomputed: realized P&L and estimated fees from
 *     trade_history, actual commission from Delta's fills.
 * When the trading day ends (17:30 IST = 12:00 UTC) the finished day is recomputed once
 * more and marked final; on start, a missed or unfinished previous day is finalized too.
 *
 * Trading day = the date it ENDS on: tradeDateOf(ts) = UTC date of (ts + 12h), the same
 * rule as `(exit_time + interval '12 hours')::date` used elsewhere.
 */
import { supabase } from './supabase.js';
import { logWarn } from './utils.js';
import { extractWalletSnapshot } from './liveExecution.js';
import { fillTimeMs } from './deltaTradeApi.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 60 * 1000;
const TOTALS_EVERY_MS = 5 * 60 * 1000;

export const tradeDateOf = (ms) => new Date(ms + 12 * 3600 * 1000).toISOString().slice(0, 10);
const dayEndMs = (tradeDate) => Date.parse(`${tradeDate}T12:00:00.000Z`);
const prevDate = (tradeDate) => new Date(Date.parse(`${tradeDate}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, dp = 4) => (v == null ? null : Number(v.toFixed(dp)));

export function createDailyStatsTracker({ accountState, live }) {
  const tag = () => `[${accountState.name}] Daily stats:`;
  let day = null;          // in-memory row for the current trading day
  let busy = false;        // one update at a time (snapshots arrive every ~10s)
  let started = false;     // previous-day catch-up runs once
  let lastSaveAt = 0;
  let lastTotalsAt = 0;
  let dirty = false;

  async function loadRow(date) {
    const { data, error } = await supabase.from('live_daily_stats').select('*')
      .eq('account_id', accountState.id).eq('trade_date', date).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function loadDay(date) {
    const row = await loadRow(date);
    let opening = num(row?.opening_balance);
    if (opening == null) opening = num((await loadRow(prevDate(date)))?.closing_balance);
    return {
      date,
      opening,
      closing: num(row?.closing_balance),
      unrealized: num(row?.unrealized_pnl),
      maxMargin: num(row?.max_margin_used),
      maxAt: row?.max_margin_at ?? null,
      maxPct: num(row?.max_margin_pct),
      totals: row ? {
        realizedGross: num(row.realized_gross_pnl) ?? 0,
        feesEstimated: num(row.fees_estimated) ?? 0,
        feesActual: num(row.fees_actual),
        tradesClosed: row.trades_closed ?? 0,
        fillsCount: row.fills_count ?? 0,
      } : null,
    };
  }

  // Realized P&L + estimated fees from trade_history; actual commission from Delta fills.
  // A failed fills read keeps the previous actual-fee figure rather than writing a wrong one.
  async function computeTotals(date, previous) {
    const end = dayEndMs(date);
    const start = end - DAY_MS;
    const { data: rows, error } = await supabase.from('trade_history')
      .select('realized_gross_pnl, total_fees')
      .eq('account_id', accountState.id)
      .gte('exit_time', new Date(start).toISOString())
      .lt('exit_time', new Date(end).toISOString())
      .limit(10000);
    if (error) throw error;
    const realizedGross = (rows || []).reduce((s, r) => s + (num(r.realized_gross_pnl) ?? 0), 0);
    const feesEstimated = (rows || []).reduce((s, r) => s + (num(r.total_fees) ?? 0), 0);

    let feesActual = previous?.feesActual ?? null;
    let fillsCount = previous?.fillsCount ?? 0;
    const fills = await live.fillsSince(start);
    if (fills) {
      const inDay = fills.filter(f => { const t = fillTimeMs(f); return t != null && t >= start && t < end; });
      feesActual = inDay.reduce((s, f) => s + (num(f.commission ?? f.paid_commission) ?? 0), 0);
      fillsCount = inDay.length;
    }
    return { realizedGross, feesEstimated, feesActual, tradesClosed: (rows || []).length, fillsCount };
  }

  async function save(d, isFinal = false) {
    const t = d.totals || { realizedGross: 0, feesEstimated: 0, feesActual: null, tradesClosed: 0, fillsCount: 0 };
    const fees = t.feesActual ?? t.feesEstimated;
    const net = t.realizedGross - fees;
    const { error } = await supabase.from('live_daily_stats').upsert({
      account_id: accountState.id,
      trade_date: d.date,
      opening_balance: round(d.opening),
      closing_balance: round(d.closing),
      realized_gross_pnl: round(t.realizedGross),
      fees_actual: round(t.feesActual),
      fees_estimated: round(t.feesEstimated),
      net_pnl: round(net),
      return_pct: d.opening > 0 ? round((net / d.opening) * 100) : null,
      unrealized_pnl: round(d.unrealized),
      max_margin_used: round(d.maxMargin),
      max_margin_at: d.maxAt,
      max_margin_pct: round(d.maxPct),
      trades_closed: t.tradesClosed,
      fills_count: t.fillsCount,
      is_final: isFinal,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id,trade_date' });
    if (error) throw error;
  }

  // Recompute a finished day's totals and mark it final (keeps its sampled margin/balances).
  async function finalize(d) {
    d.totals = await computeTotals(d.date, d.totals);
    await save(d, true);
  }

  async function update(snap) {
    const now = Date.now();
    const date = tradeDateOf(now);

    if (!started) {
      started = true;
      const prev = prevDate(date);
      const prevRow = await loadRow(prev);
      if (!prevRow?.is_final) await finalize(await loadDay(prev)); // missed / unfinished yesterday
    }

    if (!day || day.date !== date) {
      if (day) await finalize(day);              // the trading day just ended
      day = await loadDay(date);
      lastTotalsAt = 0;
      dirty = true;
    }

    const w = extractWalletSnapshot(snap?.balances);
    if (w && Number.isFinite(w.balance)) {
      if (day.opening == null) day.opening = w.balance;
      if (day.closing !== w.balance) { day.closing = w.balance; dirty = true; }
      if (w.available != null) {
        const used = Math.max(0, w.balance - w.available);
        if (day.maxMargin == null || used > day.maxMargin) {
          day.maxMargin = used;
          day.maxAt = new Date(now).toISOString();
          day.maxPct = w.balance > 0 ? (used / w.balance) * 100 : null;
          dirty = true;
        }
      }
    }
    const positions = Array.isArray(snap?.positions) ? snap.positions : [];
    const unrealized = positions.reduce((s, p) => s + (num(p.unrealized_pnl) ?? 0), 0);
    if (day.unrealized !== unrealized) day.unrealized = unrealized;

    let force = false;
    if (now - lastTotalsAt >= TOTALS_EVERY_MS) {
      day.totals = await computeTotals(date, day.totals);
      lastTotalsAt = now;
      force = true;
    }
    if (force || (dirty && now - lastSaveAt >= SAVE_EVERY_MS)) {
      await save(day, false);
      lastSaveAt = now;
      dirty = false;
    }
  }

  return {
    /** Call with each live snapshot. Never throws; overlapping calls are skipped. */
    async onSnapshot(snap) {
      if (busy) return;
      busy = true;
      try { await update(snap); }
      catch (e) { logWarn(`${tag()} update failed: ${e.message}`); }
      finally { busy = false; }
    },
  };
}
