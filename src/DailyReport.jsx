import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, CalendarDays, Columns3 } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import CustomSelect from './components/common/CustomSelect';
import { DailyPnlChart, CumulativePnlChart } from './components/DailyReport/ReportCharts';
import { supabase } from './supabase';
import { exportCsv, exportXlsx } from './exportTable';

// Daily Report — one row per LIVE account per trading day from `live_daily_stats`
// (migration 045, written by the engine). A day is Delta's day — the UTC date, 00:00 → 24:00
// UTC (05:30 → 05:30 IST) — so each day's figures match Delta's own daily view.

const DAY_MS = 24 * 60 * 60 * 1000;
const tradeDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDate = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const fmtUsd = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const fmtIstTime = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const tone = (v) => (v == null || v === 0 ? '' : v > 0 ? 'positive' : 'negative');

// One definition drives the table, the totals and both exports (exportOnly = file only;
// detail = on screen only with "More columns").
const COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'account', label: 'Account' },
  { key: 'openingBalance', label: 'Opening Balance ($)', usd: true },
  { key: 'closingBalance', label: 'Closing Balance ($)', usd: true },
  { key: 'netDeposits', label: 'Deposits / Withdrawals ($)', usd: true, signed: true },
  { key: 'realizedGross', label: 'Realized P&L ($)', usd: true, signed: true },
  { key: 'feesActual', label: 'Fees Paid — Delta ($)', usd: true },
  { key: 'feesEstimated', label: 'Fees — Engine Est. ($)', usd: true, detail: true },
  { key: 'netPnl', label: 'Net P&L ($)', usd: true, signed: true },
  { key: 'returnPct', label: 'Return (%)', pct: true, signed: true },
  { key: 'unrealized', label: 'Unrealized at Close ($)', usd: true, signed: true, detail: true },
  { key: 'maxMargin', label: 'Max Margin Used ($)', usd: true },
  { key: 'maxMarginPct', label: 'Max Margin (% of balance)', pct: true },
  { key: 'maxMarginAt', label: 'Max Margin Time (IST)', detail: true },
  { key: 'pnlSource', label: 'P&L Source', exportOnly: true },       // on screen: the "est." tag
  { key: 'marginSource', label: 'Margin Source', exportOnly: true }, // on screen: the "est." tag
  { key: 'exits', label: 'Exits' },
  { key: 'status', label: 'Status' },
];

const PNL_KEYS = new Set(['realizedGross', 'netPnl', 'returnPct']);
const isRight = (c) => c.usd || c.pct || c.key === 'exits';

const PRESETS = [
  { key: '7d', label: '7D', range: (t) => [shiftDate(t, -6), t] },
  { key: '30d', label: '30D', range: (t) => [shiftDate(t, -29), t] },
  { key: '90d', label: '90D', range: (t) => [shiftDate(t, -89), t] },
  { key: 'mtd', label: 'MTD', range: (t) => [`${t.slice(0, 8)}01`, t] },
  { key: 'ytd', label: 'YTD', range: (t) => [`${t.slice(0, 5)}01-01`, t] },
];

// One combined row per day (newest first). $ figures are summed; return uses the summed
// per-account bases (opening + money added that day, as the engine does); max margin is the sum
// of each account's own peak (they may not coincide, so it's an upper bound) and its % is
// against the summed balances at those peaks.
function combineByDate(perAccount) {
  const byDate = new Map();
  perAccount.forEach(r => { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); });
  return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, day]) => {
    const sumOf = (k) => (day.some(r => r[k] != null) ? day.reduce((s, r) => s + (r[k] ?? 0), 0) : null);
    const base = day.reduce((s, r) => s + (r.openingBalance > 0 ? r.openingBalance : 0) + Math.max(0, r.netDeposits || 0), 0);
    const netPnl = sumOf('netPnl');
    const maxMargin = sumOf('maxMargin');
    const peakBalance = day.reduce((s, r) => s + (r.maxMargin != null && r.maxMarginPct > 0 ? r.maxMargin / (r.maxMarginPct / 100) : 0), 0);
    const statuses = new Set(day.map(r => r.status));
    const status = statuses.size === 1 ? day[0].status
      : statuses.has('In progress') ? 'In progress'
      : statuses.has('Not final') ? 'Not final'
      : 'Backfilled';
    const marginEstimate = day.some(r => r.marginEstimate);
    return {
      date,
      account: `All (${day.length})`,
      accountNames: day.map(r => r.account).join(', '),
      accountId: 'all',
      openingBalance: sumOf('openingBalance'),
      closingBalance: sumOf('closingBalance'),
      netDeposits: sumOf('netDeposits'),
      realizedGross: sumOf('realizedGross'),
      feesActual: sumOf('feesActual'),
      feesEstimated: sumOf('feesEstimated'),
      netPnl,
      returnPct: netPnl != null && base > 0 ? (netPnl / base) * 100 : null,
      unrealized: sumOf('unrealized'),
      maxMargin,
      maxMarginPct: maxMargin != null && peakBalance > 0 ? (maxMargin / peakBalance) * 100 : null,
      maxMarginAt: day.length === 1 ? day[0].maxMarginAt : '—',
      pnlEstimate: day.some(r => r.pnlEstimate),
      pnlSource: day.some(r => r.pnlEstimate) ? (day.every(r => r.pnlEstimate) ? 'Estimate (trade history)' : 'Includes estimates') : 'Delta',
      marginSource: maxMargin == null ? '' : (marginEstimate ? 'Includes estimates' : 'Delta'),
      marginEstimate,
      exits: day.reduce((s, r) => s + r.exits, 0),
      status,
    };
  });
}

// Range summary. Sums and the return base come from the per-account rows (return = total net ÷
// each account's first opening balance + all deposits − withdrawals in the range); day stats
// (up/down days, best/worst, drawdown, peak margin) come from one row per day.
function summarize(acctRows, dayRows) {
  if (acctRows.length === 0) return null;
  const sum = (k) => acctRows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const firstOpening = {};
  const lastClosing = {};
  [...acctRows].sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
    if (firstOpening[r.accountId] == null && r.openingBalance != null) firstOpening[r.accountId] = r.openingBalance;
    if (r.closingBalance != null) lastClosing[r.accountId] = r.closingBalance;
  });
  const base = Object.values(firstOpening).reduce((s, v) => s + v, 0) + sum('netDeposits');
  const net = sum('netPnl');
  const days = [...dayRows].sort((a, b) => a.date.localeCompare(b.date));
  const withPnl = days.filter(d => d.netPnl != null);
  const peak = days.reduce((best, r) => (r.maxMargin != null && (best == null || r.maxMargin > best.maxMargin) ? r : best), null);
  const best = withPnl.reduce((b, r) => (b == null || r.netPnl > b.netPnl ? r : b), null);
  const worst = withPnl.reduce((b, r) => (b == null || r.netPnl < b.netPnl ? r : b), null);
  let cum = 0; let high = 0; let drawdown = 0;
  days.forEach(d => { cum += d.netPnl ?? 0; high = Math.max(high, cum); drawdown = Math.min(drawdown, cum - high); });
  const feesActual = acctRows.some(r => r.feesActual != null) ? sum('feesActual') : null;
  const realizedGross = sum('realizedGross');
  const fees = feesActual ?? sum('feesEstimated');
  const closings = Object.values(lastClosing);
  return {
    realizedGross,
    netDeposits: acctRows.some(r => r.netDeposits != null) ? sum('netDeposits') : null,
    feesActual,
    feesEstimated: sum('feesEstimated'),
    feesPctOfRealized: realizedGross > 0 ? (fees / realizedGross) * 100 : null,
    netPnl: net,
    returnPct: base > 0 ? (net / base) * 100 : null,
    maxMargin: peak?.maxMargin ?? null,
    maxMarginPct: peak?.maxMarginPct ?? null,
    maxMarginDate: peak?.date ?? null,
    maxMarginEstimate: !!peak?.marginEstimate,
    pnlEstimate: acctRows.some(r => r.pnlEstimate),
    exits: sum('exits'),
    days: days.length,
    up: withPnl.filter(d => d.netPnl > 0).length,
    down: withPnl.filter(d => d.netPnl < 0).length,
    avgDay: withPnl.length ? withPnl.reduce((s, d) => s + d.netPnl, 0) / withPnl.length : null,
    best,
    worst,
    drawdown,
    endBalance: closings.length ? closings.reduce((s, v) => s + v, 0) : null,
  };
}

export default function DailyReport({ onNavigate, theme, toggleTheme, active }) {
  // Current day; refreshed with each load so the range/status roll over at 05:30 IST (00:00 UTC).
  const [today, setToday] = useState(() => tradeDateOf(Date.now()));
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('all');
  const [view, setView] = useState('combined'); // with all accounts: 'combined' | 'split'
  const [showDetails, setShowDetails] = useState(false);
  const [from, setFrom] = useState(() => shiftDate(tradeDateOf(Date.now()), -29));
  const [to, setTo] = useState(() => tradeDateOf(Date.now()));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Live accounts this user can see (RLS: own accounts; admins all).
  useEffect(() => {
    if (!session) return;
    supabase.from('paper_trading_accounts').select('id, name, mode')
      .eq('mode', 'live').order('created_at', { ascending: true })
      .then(({ data, error: e }) => {
        if (e) setError(`Couldn't load accounts: ${e.message}`);
        else setAccounts(data || []);
      });
  }, [session]);

  const fetchRows = useCallback(async () => {
    const ids = accountId === 'all' ? accounts.map(a => a.id) : [accountId];
    if (!session || ids.length === 0) return [];
    const { data, error: e } = await supabase.from('live_daily_stats').select('*')
      .in('account_id', ids).gte('trade_date', from).lte('trade_date', to)
      .order('trade_date', { ascending: false });
    if (e) throw e;
    return data || [];
  }, [session, accounts, accountId, from, to]);

  const applyResult = useCallback((data) => {
    setRows(data);
    setError('');
    setLoadedAt(Date.now());
    setToday(tradeDateOf(Date.now()));
  }, []);

  // Refresh button.
  const load = async () => {
    setLoading(true);
    try { applyResult(await fetchRows()); }
    catch (e) { setError(`Couldn't load the report: ${e.message}`); }
    finally { setLoading(false); }
  };

  // Load when the tab is opened or a filter changes, then refresh every minute while visible.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const run = () => fetchRows()
      .then(data => { if (!cancelled) applyResult(data); })
      .catch(e => { if (!cancelled) setError(`Couldn't load the report: ${e.message}`); });
    run();
    const t = setInterval(run, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active, fetchRows, applyResult]);

  const nameOf = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a.name])), [accounts]);

  const perAccount = useMemo(() => rows.map(r => ({
    date: r.trade_date,
    account: nameOf[r.account_id] ?? r.account_id,
    accountId: r.account_id,
    openingBalance: num(r.opening_balance),
    closingBalance: num(r.closing_balance),
    netDeposits: num(r.net_deposits),
    realizedGross: num(r.realized_gross_pnl),
    feesActual: num(r.fees_actual),
    feesEstimated: num(r.fees_estimated),
    netPnl: num(r.net_pnl),
    returnPct: num(r.return_pct),
    unrealized: num(r.unrealized_pnl),
    maxMargin: num(r.max_margin_used),
    maxMarginPct: num(r.max_margin_pct),
    maxMarginAtRaw: r.max_margin_at,
    maxMarginAt: fmtIstTime(r.max_margin_at),
    pnlEstimate: !!r.pnl_is_estimate,
    pnlSource: r.pnl_is_estimate ? 'Estimate (trade history)' : 'Delta',
    marginSource: r.max_margin_used == null ? '' : (r.margin_is_estimate ? 'Estimate (trade history)' : 'Delta'),
    marginEstimate: !!r.margin_is_estimate,
    exits: r.trades_closed ?? 0,
    status: r.is_backfilled ? 'Backfilled' : r.is_final ? 'Final' : (r.trade_date === today ? 'In progress' : 'Not final'),
  })), [rows, nameOf, today]);

  const allAccounts = accountId === 'all';
  const daily = useMemo(() => combineByDate(perAccount), [perAccount]);
  const combined = allAccounts && view === 'combined';
  const table = combined ? daily : perAccount;
  const totals = useMemo(() => summarize(perAccount, daily), [perAccount, daily]);
  const chartDays = useMemo(() => [...daily].reverse(), [daily]);

  // Per-account comparison, shown with "All live accounts" when more than one account has rows.
  const breakdown = useMemo(() => {
    if (!allAccounts) return [];
    const by = new Map();
    perAccount.forEach(r => { if (!by.has(r.accountId)) by.set(r.accountId, []); by.get(r.accountId).push(r); });
    const order = accounts.map(a => a.id);
    return [...by.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([id, list]) => ({ id, name: nameOf[id] ?? id, ...summarize(list, list) }));
  }, [allAccounts, perAccount, accounts, nameOf]);

  const visibleColumns = COLUMNS.filter(c => !c.exportOnly && (showDetails || !c.detail) && !(combined && c.key === 'account'));
  const activePreset = PRESETS.find(p => { const [f, t] = p.range(today); return f === from && t === to; })?.key;
  const applyPreset = (p) => { const [f, t] = p.range(today); setFrom(f); setTo(t); };

  const exportRows = () => {
    const out = table.map(r => Object.fromEntries(COLUMNS.map(c => {
      const v = r[c.key];
      return [c.key, (c.usd || c.pct) ? r2(v) : v];
    })));
    if (totals) {
      out.push({
        date: 'TOTAL', account: allAccounts ? 'All live accounts' : (nameOf[accountId] ?? ''),
        netDeposits: r2(totals.netDeposits), realizedGross: r2(totals.realizedGross), feesActual: r2(totals.feesActual), feesEstimated: r2(totals.feesEstimated),
        netPnl: r2(totals.netPnl), returnPct: r2(totals.returnPct), maxMargin: r2(totals.maxMargin),
        maxMarginPct: r2(totals.maxMarginPct), exits: totals.exits,
        pnlSource: totals.pnlEstimate ? 'Includes estimates' : 'Delta',
        marginSource: totals.maxMarginEstimate ? 'Estimate (trade history)' : (totals.maxMargin != null ? 'Delta' : ''),
      });
    }
    return out;
  };
  const fileBase = `live-daily-report_${allAccounts ? (combined ? 'all-accounts' : 'all-accounts-split') : (nameOf[accountId] || 'account').replace(/[^\w-]+/g, '-')}_${from}_to_${to}`;

  const cell = (c, r) => {
    const v = r[c.key];
    if (c.key === 'account' && r.accountNames) return <span title={r.accountNames}>{v}</span>;
    if (c.key === 'maxMargin' && r.accountNames && v != null) {
      return <span title={`Sum of each account's own peak for the day (they may not have happened at the same time)${r.marginEstimate ? ' — includes days estimated from trade history' : ''}`}>{r.marginEstimate ? '~' : ''}{fmtUsd(v)}{r.marginEstimate && <span className="dr-est"> est.</span>}</span>;
    }
    if (c.key === 'maxMargin' && r.marginEstimate && v != null) {
      return <span title="Estimated from trade history (sum of margins of spreads open at the same time) — recorded before live tracking started">~{fmtUsd(v)} <span className="dr-est">est.</span></span>;
    }
    // Today's day is still running: its "closing" is the latest balance, not the day-end one.
    if (c.key === 'closingBalance' && r.status === 'In progress' && v != null) {
      return <span title="Latest Delta balance — becomes the closing balance when the day ends at 05:30 IST (00:00 UTC)">{fmtUsd(v)} <span className="dr-live">live</span></span>;
    }
    // Before Delta's order history: realized (and so net / return) is the engine's estimate.
    if (r.pnlEstimate && PNL_KEYS.has(c.key) && v != null) {
      return (
        <span className={tone(v)} title="Estimated from trade history (engine-side P&L) — this day is older than Delta's order history, so Delta's own realized P&L isn't available">
          {c.pct ? fmtPct(v) : fmtUsd(v)} <span className="dr-est">est.</span>
        </span>
      );
    }
    if (c.usd) return <span className={c.signed ? tone(v) : ''}>{fmtUsd(v)}</span>;
    if (c.pct) return <span className={c.signed ? tone(v) : ''}>{fmtPct(v)}</span>;
    if (c.key === 'date') return fmtDate(v);
    if (c.key === 'status') {
      const cls = r.status === 'Final' ? 'final' : r.status === 'Backfilled' ? 'backfilled' : 'open';
      return <span className={`dr-status ${cls}`} title={r.status === 'Backfilled' ? 'Filled in later from trade history and Delta history, not recorded live' : undefined}>{r.status}</span>;
    }
    return v ?? '—';
  };

  const est = (on) => on && <span className="dr-est"> incl. est.</span>;
  const footCell = (c) => {
    const t = totals;
    switch (c.key) {
      case 'date': return 'Total';
      case 'account': return `${t.days} day${t.days === 1 ? '' : 's'}`;
      case 'netDeposits': return <span className={tone(t.netDeposits)}>{fmtUsd(t.netDeposits)}</span>;
      case 'realizedGross': return <><span className={tone(t.realizedGross)}>{fmtUsd(t.realizedGross)}</span>{est(t.pnlEstimate)}</>;
      case 'feesActual': return fmtUsd(t.feesActual);
      case 'feesEstimated': return fmtUsd(t.feesEstimated);
      case 'netPnl': return <><span className={tone(t.netPnl)}>{fmtUsd(t.netPnl)}</span>{est(t.pnlEstimate)}</>;
      case 'returnPct': return <span className={tone(t.returnPct)}>{fmtPct(t.returnPct)}</span>;
      case 'maxMargin': return <>{t.maxMarginEstimate ? '~' : ''}{fmtUsd(t.maxMargin)}{t.maxMarginEstimate && <span className="dr-est"> est.</span>}</>;
      case 'maxMarginPct': return fmtPct(t.maxMarginPct);
      case 'exits': return t.exits;
      case 'status': return null;
      default: return '—';
    }
  };

  const hasData = table.length > 0 && totals;

  return (
    <div className="app">
      <Navbar activeTab="report" onNavigate={onNavigate} theme={theme} toggleTheme={toggleTheme}
        badgeLabel={loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Daily Report'} />

      <div className="body dr-body">
        {session === null ? (
          <div className="pt-empty">
            <span className="pt-empty-title">Log in to see the daily report</span>
            <span className="pt-empty-desc">Sign in on the Live Trading tab, then come back here.</span>
            <button type="button" className="dr-btn" onClick={() => onNavigate('live')}>Go to Live Trading</button>
          </div>
        ) : (
          <>
            <div className="dr-toolbar">
              <span className="dr-title"><CalendarDays size={15} /> Live Daily Report</span>
              <div className="dr-filters">
                <label className="dr-field">
                  <span>Account</span>
                  <CustomSelect
                    value={accountId}
                    onChange={setAccountId}
                    options={[{ label: 'All live accounts', value: 'all' }, ...accounts.map(a => ({ label: a.name, value: a.id }))]}
                    style={{ minWidth: 180 }}
                  />
                </label>
                <div className="dr-field">
                  <span>Range</span>
                  <div className="dr-seg" role="group" aria-label="Date range presets">
                    {PRESETS.map(p => (
                      <button key={p.key} type="button" className={activePreset === p.key ? 'on' : ''} aria-pressed={activePreset === p.key}
                        onClick={() => applyPreset(p)}>{p.label}</button>
                    ))}
                  </div>
                </div>
                <label className="dr-field">
                  <span>From</span>
                  <input type="date" className="dr-date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} />
                </label>
                <label className="dr-field">
                  <span>To</span>
                  <input type="date" className="dr-date" value={to} min={from} max={today} onChange={e => e.target.value && setTo(e.target.value)} />
                </label>
              </div>
              <div className="dr-actions">
                <button type="button" className="dr-btn" onClick={load} disabled={loading} title="Refresh">
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
                </button>
                <button type="button" className="dr-btn" disabled={table.length === 0}
                  onClick={() => exportCsv(COLUMNS, exportRows(), `${fileBase}.csv`)}>
                  <Download size={13} /> CSV
                </button>
                <button type="button" className="dr-btn primary" disabled={table.length === 0}
                  onClick={() => exportXlsx(COLUMNS, exportRows(), `${fileBase}.xlsx`, 'Daily Report')}>
                  <FileSpreadsheet size={13} /> Excel
                </button>
              </div>
            </div>

            {error && <div className="dr-error">{error}</div>}

            {hasData && (
              <div className="dr-summary">
                <div className="dr-hero" title={totals.pnlEstimate ? "Includes days estimated from trade history (before Delta's order history)" : undefined}>
                  <span className="dr-hero-label">Net P&amp;L · {fmtShort(from)} – {fmtShort(to)}</span>
                  <strong className={`dr-hero-value ${tone(totals.netPnl)}`}>{fmtUsd(totals.netPnl)}</strong>
                  <div className="dr-hero-sub">
                    <span className={`dr-pill ${tone(totals.returnPct)}`} title="Total net P&L ÷ capital in the range (first day's opening balance + deposits − withdrawals)">{totals.returnPct > 0 ? '+' : ''}{fmtPct(totals.returnPct)}</span>
                    <span>Realized {fmtUsd(totals.realizedGross)} − fees {fmtUsd(totals.feesActual ?? totals.feesEstimated)}</span>
                    {totals.pnlEstimate && <em className="dr-est">incl. est.</em>}
                  </div>
                </div>
                <div className="dr-tiles">
                  <div className="dr-tile">
                    <span>Up / down days</span>
                    <strong><b className="positive">{totals.up}</b> / <b className="negative">{totals.down}</b></strong>
                    <em>{totals.up + totals.down ? `${Math.round((totals.up / (totals.up + totals.down)) * 100)}% win rate` : 'No P&L yet'}{totals.days - totals.up - totals.down > 0 ? ` · ${totals.days - totals.up - totals.down} flat` : ''}</em>
                  </div>
                  <div className="dr-tile">
                    <span>Avg day</span>
                    <strong className={tone(totals.avgDay)}>{fmtUsd(totals.avgDay)}</strong>
                    <em>{totals.days} day{totals.days === 1 ? '' : 's'} · {totals.exits} exits</em>
                  </div>
                  <div className="dr-tile">
                    <span>Best day</span>
                    <strong className={tone(totals.best?.netPnl)}>{fmtUsd(totals.best?.netPnl)}</strong>
                    <em>{totals.best ? fmtDate(totals.best.date) : '—'}</em>
                  </div>
                  <div className="dr-tile">
                    <span>Worst day</span>
                    <strong className={tone(totals.worst?.netPnl)}>{fmtUsd(totals.worst?.netPnl)}</strong>
                    <em>{totals.worst ? fmtDate(totals.worst.date) : '—'}</em>
                  </div>
                  <div className="dr-tile" title="Largest fall of cumulative net P&L from its high within the range">
                    <span>Max drawdown</span>
                    <strong className={tone(totals.drawdown)}>{fmtUsd(totals.drawdown)}</strong>
                    <em>from peak cumulative P&amp;L</em>
                  </div>
                  <div className="dr-tile">
                    <span>Fees paid (Delta)</span>
                    <strong>{fmtUsd(totals.feesActual)}</strong>
                    <em>{totals.feesPctOfRealized != null ? `${totals.feesPctOfRealized.toFixed(1)}% of realized P&L` : '—'}</em>
                  </div>
                  <div className="dr-tile" title={allAccounts ? "Highest day; with all accounts, each account's own peak that day added together" : undefined}>
                    <span>Peak margin used</span>
                    <strong>{totals.maxMarginEstimate ? '~' : ''}{fmtUsd(totals.maxMargin)}{totals.maxMarginEstimate && <em className="dr-est"> est.</em>}</strong>
                    <em>{totals.maxMarginPct != null ? `${fmtPct(totals.maxMarginPct)} of balance` : '—'}{totals.maxMarginDate ? ` · ${fmtShort(totals.maxMarginDate)}` : ''}</em>
                  </div>
                  <div className="dr-tile">
                    <span>{to === today ? 'Balance now' : 'Ending balance'}</span>
                    <strong>{fmtUsd(totals.endBalance)}</strong>
                    <em>Deposits / withdrawals {fmtUsd(totals.netDeposits)}</em>
                  </div>
                </div>
              </div>
            )}

            {hasData && (
              <div className="dr-charts">
                <DailyPnlChart days={chartDays} fmtUsd={fmtUsd} fmtPct={fmtPct} />
                <CumulativePnlChart days={chartDays} fmtUsd={fmtUsd} />
              </div>
            )}

            {hasData && breakdown.length > 1 && (
              <div className="dr-card">
                <div className="dr-card-head">
                  <span className="dr-card-title">By account</span>
                  <span className="dr-card-sub">Click an account to open its own report</span>
                </div>
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table dr-breakdown">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th className="r">{to === today ? 'Balance now' : 'Ending balance'}</th>
                        <th className="r">Deposits / Withdrawals</th>
                        <th className="r">Net P&amp;L</th>
                        <th className="r">Return</th>
                        <th className="r">Share of P&amp;L</th>
                        <th className="r">Fees paid</th>
                        <th className="r">Up / down</th>
                        <th className="r">Best day</th>
                        <th className="r">Worst day</th>
                        <th className="r">Max drawdown</th>
                        <th className="r">Exits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map(b => {
                        const share = totals.netPnl ? (b.netPnl / totals.netPnl) * 100 : null;
                        return (
                          <tr key={b.id} className="dr-click" onClick={() => setAccountId(b.id)} title={`Open ${b.name}`}>
                            <td><strong>{b.name}</strong></td>
                            <td className="r">{fmtUsd(b.endBalance)}</td>
                            <td className="r"><span className={tone(b.netDeposits)}>{fmtUsd(b.netDeposits)}</span></td>
                            <td className="r"><span className={tone(b.netPnl)}>{fmtUsd(b.netPnl)}</span>{est(b.pnlEstimate)}</td>
                            <td className="r"><span className={tone(b.returnPct)}>{fmtPct(b.returnPct)}</span></td>
                            <td className="r">{share == null ? '—' : `${share.toFixed(0)}%`}</td>
                            <td className="r">{fmtUsd(b.feesActual)}</td>
                            <td className="r"><span className="positive">{b.up}</span> / <span className="negative">{b.down}</span></td>
                            <td className="r"><span className={tone(b.best?.netPnl)}>{fmtUsd(b.best?.netPnl)}</span></td>
                            <td className="r"><span className={tone(b.worst?.netPnl)}>{fmtUsd(b.worst?.netPnl)}</span></td>
                            <td className="r"><span className={tone(b.drawdown)}>{fmtUsd(b.drawdown)}</span></td>
                            <td className="r">{b.exits}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">Daily breakdown</span>
                <div className="dr-card-tools">
                  {allAccounts && accounts.length > 1 && (
                    <div className="dr-seg" role="group" aria-label="Rows">
                      <button type="button" className={view === 'combined' ? 'on' : ''} aria-pressed={view === 'combined'} onClick={() => setView('combined')}>Combined</button>
                      <button type="button" className={view === 'split' ? 'on' : ''} aria-pressed={view === 'split'} onClick={() => setView('split')}>Per account</button>
                    </div>
                  )}
                  <button type="button" className={`dr-btn small${showDetails ? ' on' : ''}`} aria-pressed={showDetails} onClick={() => setShowDetails(s => !s)}
                    title="Show / hide engine fee estimate, unrealized at close and max margin time">
                    <Columns3 size={13} /> {showDetails ? 'Fewer columns' : 'More columns'}
                  </button>
                </div>
              </div>
              {table.length === 0 ? (
                <div className="pt-empty">
                  <span className="pt-empty-title">{loadedAt == null && accounts.length > 0 ? 'Loading…' : accounts.length === 0 ? 'No live accounts' : 'No days in this range yet'}</span>
                  <span className="pt-empty-desc">
                    Rows are recorded by the engine for armed live accounts from the day this feature is deployed.
                  </span>
                </div>
              ) : (
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table">
                    <thead>
                      <tr>{visibleColumns.map(c => <th key={c.key} className={isRight(c) ? 'r' : ''}>{c.label.replace(/ \(\$\)$/, '')}</th>)}</tr>
                    </thead>
                    <tbody>
                      {table.map(r => (
                        <tr key={`${r.accountId}-${r.date}`} className={r.status === 'In progress' ? 'dr-today' : ''}>
                          {visibleColumns.map(c => <td key={c.key} className={isRight(c) ? 'r' : ''}>{cell(c, r)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    {totals && (
                      <tfoot>
                        <tr>{visibleColumns.map(c => <td key={c.key} className={isRight(c) ? 'r' : ''}>{footCell(c)}</td>)}</tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>

            <details className="dr-note">
              <summary>How these numbers are calculated</summary>
              <p>
                Day = Delta's day, 05:30 → 05:30 IST (00:00 UTC), so each day matches Delta. For the day in progress, closing
                balance, P&amp;L and return are live (so far) and become final at 05:30 IST. Realized P&amp;L and fees are Delta's own figures (order
                history, as on the Live dashboard). Net P&amp;L = realized P&amp;L − fees (the engine's fee estimate is used only if
                Delta's isn't available). Return = Net P&amp;L ÷ (opening balance + money deposited that
                day); the total uses the first day's opening + all deposits − withdrawals in the range. Deposits / withdrawals move the
                balance but are never counted as P&amp;L. Cumulative P&amp;L and max drawdown are built from daily net P&amp;L only.
              </p>
              <p>
                Max margin = the highest margin Delta blocked during the day; days marked <em>est.</em> were filled in later from trade
                history (sum of margins of spreads open at the same time). Backfilled rows predate live tracking.
                Realized / Net / Return marked <em>est.</em> come from trade history because the day is older than Delta's order history.
              </p>
              {allAccounts && (
                <p>
                  With all accounts selected, the summary and charts combine every account: amounts are summed, return is the combined
                  net ÷ combined base, and a day's max margin is the sum of each account's own peak that day. Switch the daily breakdown to
                  “Per account” or pick an account to see its own rows.
                </p>
              )}
            </details>
          </>
        )}
      </div>
    </div>
  );
}
