/**
 * One-time backfill of live_daily_stats (migrations 045 + 046) for days before the live
 * tracker (lib/dailyStats.js) was recording.
 *
 * Usage (on the server, from the engine directory):
 *     node backfillDailyStats.js --dry-run              # print what would be written
 *     node backfillDailyStats.js                        # write
 *     node backfillDailyStats.js --account "Live 1" --from 2026-08-01
 *
 * Per live account and trading day (17:30 → 17:30 IST, named for the end date), up to
 * YESTERDAY (today belongs to the live tracker):
 *   • realized P&L + actual fees — Delta's own figures from order history (meta_data.pnl,
 *     paid_commission; the numbers the Live dashboard shows), as far back as Delta's history
 *     reaches. Older days fall back to trade_history's P&L and the engine's fee estimate.
 *   • exits, estimated fees — trade_history rows exited that day.
 *   • opening / closing balance — from Delta wallet transactions, IF they carry a running
 *     balance; otherwise left empty (and return % with it).
 *   • max margin — an ESTIMATE (margin_is_estimate = true): the peak sum of margins of
 *     full spreads open at the same moment, from trade_history (+ still-open positions).
 *     A position counts with its full-spread margin from entry until its short closed.
 *
 * Existing rows keep every MEASURED value (balances, live-sampled margin) — only empty ones
 * are filled (e.g. the margin of a day the engine was down). The DERIVED P&L figures
 * (realized, fees, net, return) are rewritten from Delta wherever its history covers the day,
 * which also corrects rows written from trade_history earlier. New rows are written with
 * is_backfilled = true, is_final = true. Re-running is safe.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { supabase, hasServiceRole } from './lib/supabase.js';
import { getOrderHistorySinceFull, getWalletTransactionsSince, fillTimeMs, orderTimeMs, orderPnlAndFee } from './lib/deltaTradeApi.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const tradeDateOf = (ms) => new Date(ms + 12 * 3600 * 1000).toISOString().slice(0, 10);
const dayEndMs = (d) => Date.parse(`${d}T12:00:00.000Z`);
const nextDate = (d) => new Date(Date.parse(`${d}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
const round = (v, dp = 4) => (v == null ? null : Number(v.toFixed(dp)));

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DRY_RUN = args.includes('--dry-run');
const ONLY_ACCOUNT = argVal('--account');
const FROM = argVal('--from');

async function selectAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function loadCreds(accountId) {
  const { data, error } = await supabase.rpc('get_delta_credentials_decrypted', { p_account_id: accountId });
  if (error || !data?.[0]?.api_key) return null;
  return { apiKey: data[0].api_key, apiSecret: data[0].api_secret };
}

// Full-spread lifetimes: one per position (trade_id prefix), from its rows with an active
// short (sell_qty > 0) — the long-only wind-down after the short closes holds little margin.
function lifetimes(history, open) {
  const byPos = new Map();
  const add = (id, entry, exit, margin) => {
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || !(margin > 0)) return;
    const cur = byPos.get(id);
    if (!cur) byPos.set(id, { entry, exit, margin });
    else { cur.entry = Math.min(cur.entry, entry); cur.exit = Math.max(cur.exit, exit); cur.margin = Math.max(cur.margin, margin); }
  };
  for (const r of history) {
    if (!(num(r.sell_qty) > 0)) continue;
    add(String(r.trade_id ?? '').split('-')[0], Date.parse(r.entry_time), Date.parse(r.exit_time), num(r.margin));
  }
  const now = Date.now();
  for (const p of open) {
    if (!(num(p.sell_qty) > 0)) continue;
    add(String(p.id), Date.parse(p.entry_time), now, num(p.margin));
  }
  return [...byPos.values()];
}

// Peak concurrent margin inside [start, end) and when it was reached.
function peakMargin(lives, start, end) {
  const events = [];
  for (const l of lives) {
    const a = Math.max(l.entry, start);
    const b = Math.min(l.exit, end);
    if (a < b) { events.push([a, l.margin]); events.push([b, -l.margin]); }
  }
  if (events.length === 0) return { peak: 0, at: null };
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // exits before entries at the same instant
  let cur = 0; let peak = 0; let at = null;
  for (const [t, d] of events) { cur += d; if (cur > peak + 1e-9) { peak = cur; at = t; } }
  return { peak, at };
}

// End-of-day balance per trade date from wallet transactions that carry a running balance.
function closingBalances(txns, asset) {
  const pickAsset = (t) => String(t.asset_symbol || t.asset?.symbol || '').toUpperCase();
  const withBal = txns.filter(t => num(t.balance) != null && fillTimeMs(t) != null);
  if (withBal.length === 0) return null;
  const preferred = withBal.filter(t => pickAsset(t) === asset);
  const list = (preferred.length ? preferred : withBal).sort((a, b) => fillTimeMs(a) - fillTimeMs(b));
  const byDay = new Map();
  for (const t of list) byDay.set(tradeDateOf(fillTimeMs(t)), num(t.balance)); // last txn of the day wins
  return byDay;
}

async function backfillAccount(acct, lastDate) {
  console.log(`\n── ${acct.name} (${acct.id})`);
  const history = await selectAll(() => supabase.from('trade_history')
    .select('trade_id, entry_time, exit_time, margin, sell_qty, realized_gross_pnl, total_fees')
    .eq('account_id', acct.id).order('exit_time', { ascending: true }));
  const { data: open, error: openErr } = await supabase.from('active_positions')
    .select('id, entry_time, margin, sell_qty').eq('account_id', acct.id);
  if (openErr) throw openErr;
  if (history.length === 0 && (open || []).length === 0) { console.log('   no trades — skipped'); return; }

  const firstMs = Math.min(...history.map(r => Date.parse(r.entry_time)), ...(open || []).map(p => Date.parse(p.entry_time)));
  let firstDate = tradeDateOf(firstMs);
  if (FROM && FROM > firstDate) firstDate = FROM;
  if (firstDate > lastDate) { console.log('   nothing before today — skipped'); return; }
  const rangeStart = dayEndMs(firstDate) - DAY_MS;
  console.log(`   days ${firstDate} → ${lastDate}, ${history.length} trade_history rows`);

  // Delta: realized P&L + commission (order history) and running balances (wallet transactions).
  const creds = await loadCreds(acct.id);
  let pnlByDay = null; let deltaFromDate = null;
  let balances = null;
  if (!creds) {
    console.log('   ⚠ no Delta credentials — realized P&L from trade_history; actual fees and balances left empty');
  } else {
    try {
      // Orders are listed by creation; one created up to 2 days earlier can close in range.
      const { items, complete } = await getOrderHistorySinceFull(creds, rangeStart - 2 * DAY_MS, { maxPages: 500 });
      pnlByDay = new Map();
      for (const o of items) {
        const t = orderTimeMs(o);
        if (t == null) continue;
        const { pnl, fee } = orderPnlAndFee(o);
        if (pnl === 0 && fee === 0) continue;
        const d = tradeDateOf(t);
        const e = pnlByDay.get(d) || { pnl: 0, fees: 0, count: 0 };
        e.pnl += pnl; e.fees += fee; e.count += 1;
        pnlByDay.set(d, e);
      }
      // Only days fully inside the history Delta returned have a trustworthy total.
      const oldest = items.length ? Math.min(...items.map(o => fillTimeMs(o)).filter(Number.isFinite)) : null;
      // Delta's history only covers days after its oldest order. Running out of pages
      // ("complete") does NOT mean it reaches back to the first trade — Delta may simply keep
      // less history — so days before the oldest order fall back to trade_history instead of
      // being read as "no P&L, no fees". (+2 days: an order created then can close later.)
      const reachesBack = Number.isFinite(oldest) && oldest <= rangeStart - 2 * DAY_MS;
      deltaFromDate = complete && (reachesBack || items.length === 0)
        ? firstDate
        : (Number.isFinite(oldest) ? nextDate(nextDate(tradeDateOf(oldest))) : lastDate);
      console.log(`   order history: ${items.length} orders${deltaFromDate > firstDate ? ` (Delta's history starts ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : '?'} — Delta P&L/fees only from ${deltaFromDate}; earlier days use trade_history and the fee estimate)` : ''}`);
    } catch (e) { console.log(`   ⚠ order history fetch failed (${e.message}) — realized P&L from trade_history, actual fees left empty`); }
    try {
      // Look further back than the range so the first day's opening balance (the last
      // running balance before it) is found even after a quiet spell.
      const { items } = await getWalletTransactionsSince(creds, rangeStart - 60 * DAY_MS, { maxPages: 500 });
      balances = closingBalances(items, 'USDT');
      if (!balances) {
        console.log(`   ⚠ wallet transactions have no running balance field — balances / return % left empty${items[0] ? ` (fields: ${Object.keys(items[0]).join(', ')})` : ''}`);
      }
    } catch (e) { console.log(`   ⚠ wallet transactions fetch failed (${e.message}) — balances left empty`); }
  }

  const lives = lifetimes(history, open || []);
  const existing = new Map((await selectAll(() => supabase.from('live_daily_stats').select('*')
    .eq('account_id', acct.id).gte('trade_date', firstDate).lte('trade_date', lastDate)))
    .map(r => [r.trade_date, r]));

  // Closing balance for a day = last running balance at or before its end.
  const balanceAtEnd = (() => {
    if (!balances) return () => null;
    const days = [...balances.keys()].sort();
    return (d) => { let v = null; for (const k of days) { if (k <= d) v = balances.get(k); else break; } return v; };
  })();

  const upserts = [];
  let prevClosing = null;
  for (let d = firstDate; d <= lastDate; d = nextDate(d)) {
    const end = dayEndMs(d); const start = end - DAY_MS;
    const rows = history.filter(r => { const t = Date.parse(r.exit_time); return t >= start && t < end; });
    const historyGross = rows.reduce((s, r) => s + (num(r.realized_gross_pnl) ?? 0), 0);
    const feesEstimated = rows.reduce((s, r) => s + (num(r.total_fees) ?? 0), 0);
    const dg = pnlByDay && deltaFromDate && d >= deltaFromDate ? (pnlByDay.get(d) || { pnl: 0, fees: 0, count: 0 }) : null;
    const realizedGross = dg ? dg.pnl : historyGross;
    const closing = balanceAtEnd(d);
    const opening = prevClosing ?? balanceAtEnd(new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10));
    prevClosing = closing;
    const { peak, at } = peakMargin(lives, start, end);
    const marginBase = closing ?? opening;

    const old = existing.get(d);
    if (!old && rows.length === 0 && peak === 0 && !(dg && dg.count > 0)) continue; // no activity → no row

    const fees = dg ? dg.fees : feesEstimated;
    const net = realizedGross - fees;
    const fresh = {
      account_id: acct.id, trade_date: d,
      opening_balance: round(opening), closing_balance: round(closing),
      realized_gross_pnl: round(realizedGross), fees_actual: dg ? round(dg.fees) : null,
      fees_estimated: round(feesEstimated), net_pnl: round(net),
      return_pct: opening > 0 ? round((net / opening) * 100) : null,
      max_margin_used: round(peak), max_margin_at: at ? new Date(at).toISOString() : null,
      max_margin_pct: marginBase > 0 ? round((peak / marginBase) * 100) : null,
      margin_is_estimate: true,
      trades_closed: rows.length, fills_count: dg ? dg.count : 0,
      is_final: true, is_backfilled: true, updated_at: new Date().toISOString(),
    };

    if (!old) { upserts.push(fresh); continue; }

    // Existing (live-recorded) row: fill only what's empty, keep everything it measured.
    const patch = { account_id: acct.id, trade_date: d };
    if (old.max_margin_used == null) {
      Object.assign(patch, { max_margin_used: fresh.max_margin_used, max_margin_at: fresh.max_margin_at, max_margin_pct: fresh.max_margin_pct, margin_is_estimate: true });
    }
    // A row written on an earlier run without balances (e.g. Delta unreachable) gets its
    // margin % once a balance is known.
    if (old.max_margin_used != null && old.max_margin_pct == null && marginBase > 0) {
      patch.max_margin_pct = round((num(old.max_margin_used) / marginBase) * 100);
    }
    if (old.opening_balance == null && fresh.opening_balance != null) patch.opening_balance = fresh.opening_balance;
    if (old.closing_balance == null && fresh.closing_balance != null) patch.closing_balance = fresh.closing_balance;
    const filledMeasured = Object.keys(patch).length > 2;
    // Derived P&L: Delta's figures replace whatever was there (incl. trade_history-based ones).
    // Rows this script wrote are re-derived from the best source every run — so a day an
    // earlier run read as "0 fees" (before Delta's history) goes back to the trade_history
    // P&L with no actual-fee figure.
    if (dg || old.is_backfilled) {
      if (num(old.realized_gross_pnl) !== fresh.realized_gross_pnl) patch.realized_gross_pnl = fresh.realized_gross_pnl;
      if (num(old.fees_actual) !== fresh.fees_actual) patch.fees_actual = fresh.fees_actual;
      if ((old.fills_count ?? 0) !== fresh.fills_count) patch.fills_count = fresh.fills_count;
    }
    if (Object.keys(patch).length > 2) {
      const o = { ...old, ...patch };
      const oFees = num(o.fees_actual) ?? num(o.fees_estimated) ?? 0;
      patch.net_pnl = round((num(o.realized_gross_pnl) ?? 0) - oFees);
      patch.return_pct = num(o.opening_balance) > 0 ? round((patch.net_pnl / num(o.opening_balance)) * 100) : null;
      if (filledMeasured || old.is_backfilled) patch.is_backfilled = true;
      patch.updated_at = new Date().toISOString();
      upserts.push(patch);
    }
  }

  const created = upserts.filter(u => !existing.has(u.trade_date)).length;
  console.log(`   ${created} new day(s), ${upserts.length - created} existing day(s) updated`);
  for (const u of upserts.slice(-5)) {
    if (existing.has(u.trade_date)) {
      const filled = Object.keys(u).filter(k => !['account_id', 'trade_date', 'updated_at', 'is_backfilled', 'net_pnl', 'return_pct'].includes(k));
      console.log(`     ${u.trade_date}: updated ${filled.join(', ')}`);
    } else {
      console.log(`     ${u.trade_date}: net ${u.net_pnl} | return ${u.return_pct ?? '—'}% | fees ${u.fees_actual ?? `${u.fees_estimated} (est.)`} | max margin ~${u.max_margin_used}`);
    }
  }
  if (DRY_RUN || upserts.length === 0) return;
  // New days are full rows → batched upsert. Existing days are PARTIAL patches → one
  // UPDATE each: a mixed-shape batch makes PostgREST send NULL for every column a row
  // lacks, which would wipe (or violate NOT NULL on) the row's recorded values.
  const fresh = upserts.filter(u => !existing.has(u.trade_date));
  const patches = upserts.filter(u => existing.has(u.trade_date));
  for (let i = 0; i < fresh.length; i += 200) {
    const { error } = await supabase.from('live_daily_stats').upsert(fresh.slice(i, i + 200), { onConflict: 'account_id,trade_date' });
    if (error) throw error;
  }
  for (const { account_id, trade_date, ...fields } of patches) {
    const { error } = await supabase.from('live_daily_stats').update(fields)
      .eq('account_id', account_id).eq('trade_date', trade_date);
    if (error) throw error;
  }
  console.log('   ✓ written');
}

async function main() {
  if (!hasServiceRole) { console.error('SUPABASE_SERVICE_ROLE_KEY is required (writes live_daily_stats, decrypts Delta keys).'); process.exit(1); }
  const lastDate = new Date(Date.parse(`${tradeDateOf(Date.now())}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const { data: accounts, error } = await supabase.from('paper_trading_accounts').select('id, name, mode').eq('mode', 'live');
  if (error) throw error;
  const list = (accounts || []).filter(a => !ONLY_ACCOUNT || a.id === ONLY_ACCOUNT || a.name === ONLY_ACCOUNT);
  console.log(`${DRY_RUN ? 'DRY RUN — nothing will be written. ' : ''}Backfilling ${list.length} live account(s) up to ${lastDate}.`);
  for (const acct of list) {
    try { await backfillAccount(acct, lastDate); }
    catch (e) { console.log(`   ✖ failed: ${e.message}`); }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
