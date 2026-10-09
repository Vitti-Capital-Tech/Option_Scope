/**
 * Daily report tracker for ONE live account → `live_daily_stats` (migration 045).
 *
 * Fed by the engine's live snapshot (~every 10s, armed live accounts only):
 *   • margin used = wallet balance − Delta's available_balance; the day's peak is kept in
 *     memory and saved as it rises (at most once a minute), so a restart doesn't lose it —
 *     the row is reloaded on start.
 *   • opening balance = the previous day's closing balance (else the first one seen today);
 *     closing balance and open-position unrealized P&L = the latest sample.
 *   • every 5 min the day's totals are recomputed: realized P&L and commission from Delta's
 *     order history (meta_data.pnl / paid_commission — the numbers the Live dashboard shows;
 *     trade_history's engine-side P&L doesn't match Delta for live), exits and the engine's
 *     fee estimate from trade_history.
 *   • deposits / withdrawals (migration 048) from the wallet ledger in the same pass; they
 *     move the balance but aren't P&L, and return % = net ÷ (opening + money added that day).
 * When the day ends (00:00 UTC = 05:30 IST — Delta's own daily reset) the finished day is recomputed once
 * more and marked final; on start, a missed or unfinished previous day is finalized too.
 *
 * Report day = the UTC calendar date (00:00 → 24:00 UTC = 05:30 → 05:30 IST), Delta's own
 * daily boundary — NOT the app's 17:30 IST trading day — so per-day figures match Delta.
 */
import { supabase } from './supabase.js';
import { logWarn } from './utils.js';
import { extractWalletSnapshot } from './liveExecution.js';
import { orderTimeMs, orderPnlAndFee, capitalFlowsByDay, returnBase } from './deltaTradeApi.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 60 * 1000;
const TOTALS_EVERY_MS = 5 * 60 * 1000;

// Report day = Delta's day: the UTC date, 00:00 → 24:00 UTC (05:30 → 05:30 IST), so each
// day's realized P&L and fees match Delta's own daily figures.
export const tradeDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayEndMs = (tradeDate) => Date.parse(`${tradeDate}T00:00:00.000Z`) + DAY_MS;
const prevDate = (tradeDate) => new Date(Date.parse(`${tradeDate}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
// null/undefined stay null — Number(null) is 0, which would read an EMPTY balance as $0.
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const positive = (v) => (v != null && v > 0 ? v : null);
const round = (v, dp = 4) => (v == null ? null : Number(v.toFixed(dp)));

export function createDailyStatsTracker({ accountState, live }) {
  const tag = () => `[${accountState.name}] Daily stats:`;
  let day = null;          // in-memory row for the current trading day
  let busy = false;        // one update at a time (snapshots arrive every ~10s)
  let started = false;     // previous-day catch-up runs once
  let lastSaveAt = 0;
  let lastTotalsAt = 0;
  let dirty = false;

  // A row built on the old 17:30 IST cut (day_basis 'ist1730', migration 049 — incl. rows an
  // engine on the old code may still be writing) covers a different window: treat it as
  // absent, so this day is rebuilt on Delta's UTC day and overwritten on the next save.
  async function loadRawRow(date) {
    const { data, error } = await supabase.from('live_daily_stats').select('*')
      .eq('account_id', accountState.id).eq('trade_date', date).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function loadRow(date) {
    const data = await loadRawRow(date);
    return data && data.day_basis === 'utc' ? data : null;
  }

  async function loadDay(date) {
    const raw = await loadRawRow(date);
    const row = raw && raw.day_basis === 'utc' ? raw : null;
    const replacesLegacy = !!raw && !row;
    // A $0 opening can't be real for a trading account — it's an empty value saved as 0 by
    // an earlier version — so it's treated as missing and re-derived.
    let opening = positive(num(row?.opening_balance));
    if (opening == null) opening = positive(num((await loadRow(prevDate(date)))?.closing_balance));
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
        fromDelta: row.fees_actual != null && !row.pnl_is_estimate,
        netDeposits: num(row.net_deposits),
      } : null,
      pnlWasEstimate: !!row?.pnl_is_estimate,
      replacesLegacy,
    };
  }

  // Delta's realized P&L + commission from order history (orders that closed/filled in the
  // window); exits + the engine's fee estimate from trade_history. A failed Delta read keeps
  // the previous Delta figures; with none yet, realized falls back to trade_history.
  // The day's trade_history sums — get_trade_day_totals (migration 061) returns them as one row.
  // Until 061 is run: sum in 1,000-row pages (a single request is capped at 1,000 rows by the
  // API, which silently undercounted busy days).
  let dayTotalsRpc = true;
  async function dayTradeTotals(start, end) {
    const fromIso = new Date(start).toISOString();
    const toIso = new Date(end).toISOString();
    if (dayTotalsRpc) {
      const { data, error } = await supabase
        .rpc('get_trade_day_totals', { p_account: accountState.id, p_from: fromIso, p_to: toIso })
        .single();
      if (!error) {
        return { historyGross: num(data?.realized_gross) ?? 0, feesEstimated: num(data?.fees) ?? 0, tradesClosed: Number(data?.trades) || 0 };
      }
      if (!/does not exist|could not find|PGRST20[2-5]/i.test(`${error.code || ''} ${error.message || ''}`)) throw error;
      dayTotalsRpc = false;
    }
    let historyGross = 0, feesEstimated = 0, tradesClosed = 0;
    for (let from = 0; ; from += 1000) {
      const { data: rows, error } = await supabase.from('trade_history')
        .select('realized_gross_pnl, total_fees')
        .eq('account_id', accountState.id)
        .gte('exit_time', fromIso)
        .lt('exit_time', toIso)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      for (const r of (rows || [])) {
        historyGross += num(r.realized_gross_pnl) ?? 0;
        feesEstimated += num(r.total_fees) ?? 0;
      }
      tradesClosed += (rows || []).length;
      if (!rows || rows.length < 1000) return { historyGross, feesEstimated, tradesClosed };
    }
  }

  async function computeTotals(date, previous) {
    const end = dayEndMs(date);
    const start = end - DAY_MS;
    const { historyGross, feesEstimated, tradesClosed } = await dayTradeTotals(start, end);

    let realizedGross = previous?.fromDelta ? previous.realizedGross : historyGross;
    let feesActual = previous?.feesActual ?? null;
    let fillsCount = previous?.fillsCount ?? 0;
    let fromDelta = !!previous?.fromDelta;
    // Orders are listed by creation time; one created up to 2 days earlier can close today.
    const orders = await live.orderHistorySince(start - 2 * DAY_MS);
    if (orders) {
      const inDay = orders.filter(o => { const t = orderTimeMs(o); return t != null && t >= start && t < end; });
      realizedGross = 0; feesActual = 0; fillsCount = 0;
      for (const o of inDay) {
        const { pnl, fee } = orderPnlAndFee(o);
        realizedGross += pnl; feesActual += fee;
        if (pnl !== 0 || fee !== 0) fillsCount += 1;
      }
      fromDelta = true;
    }
    // Deposits / withdrawals / transfers that day (kept from before if the ledger read fails).
    let netDeposits = previous?.netDeposits ?? null;
    const txns = await live.walletTransactionsSince(start);
    if (txns) netDeposits = capitalFlowsByDay(txns, tradeDateOf).get(date) ?? 0;
    return { realizedGross, feesEstimated, feesActual, tradesClosed, fillsCount, fromDelta, netDeposits };
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
      return_pct: (() => { const base = returnBase(d.opening, t.netDeposits); return base ? round((net / base) * 100) : null; })(),
      // Sent only once known, so a DB without migration 048 keeps working until then.
      ...(t.netDeposits != null ? { net_deposits: round(t.netDeposits) } : {}),
      unrealized_pnl: round(d.unrealized),
      max_margin_used: round(d.maxMargin),
      max_margin_at: d.maxAt,
      max_margin_pct: round(d.maxPct),
      trades_closed: t.tradesClosed,
      fills_count: t.fillsCount,
      // Realized from trade_history (no Delta read yet) → "est." in the report (migration
      // 047). Sent only when it's set or needs clearing, so a DB without 047 keeps working.
      ...(t.fromDelta === false ? { pnl_is_estimate: true } : d.pnlWasEstimate ? { pnl_is_estimate: false } : {}),
      is_final: isFinal,
      day_basis: 'utc',
      // First save over an old-cut row: clear the flags/values only the old row carried.
      ...(d.replacesLegacy ? {
        is_backfilled: false, margin_is_estimate: false,
        ...(t.fromDelta === false ? {} : { pnl_is_estimate: false }),
        ...(t.netDeposits != null ? {} : { net_deposits: null }),
      } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id,trade_date' });
    if (error) throw error;
    d.pnlWasEstimate = t.fromDelta === false;
    d.replacesLegacy = false;
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
      if (day.opening == null) {
        // Prefer yesterday's closing if it has appeared since (e.g. filled by the backfill).
        day.opening = positive(num((await loadRow(prevDate(day.date)))?.closing_balance)) ?? w.balance;
        dirty = true;
      }
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
