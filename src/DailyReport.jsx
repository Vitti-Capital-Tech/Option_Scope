import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, CalendarDays } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import CustomSelect from './components/common/CustomSelect';
import { supabase } from './supabase';
import { exportCsv, exportXlsx } from './exportTable';

// Daily Report — one row per LIVE account per trading day from `live_daily_stats`
// (migration 045, written by the engine). A trading day runs 17:30 → 17:30 IST and is
// named for the date it ends on.

const DAY_MS = 24 * 60 * 60 * 1000;
const tradeDateOf = (ms) => new Date(ms + 12 * 3600 * 1000).toISOString().slice(0, 10);
const shiftDate = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const fmtUsd = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtIstTime = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const tone = (v) => (v == null || v === 0 ? '' : v > 0 ? 'positive' : 'negative');

// One definition drives the table, the totals and both exports (exportOnly = file only).
const COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'account', label: 'Account' },
  { key: 'openingBalance', label: 'Opening Balance ($)', usd: true },
  { key: 'closingBalance', label: 'Closing Balance ($)', usd: true },
  { key: 'realizedGross', label: 'Realized P&L ($)', usd: true, signed: true },
  { key: 'feesActual', label: 'Fees Paid — Delta ($)', usd: true },
  { key: 'feesEstimated', label: 'Fees — Engine Est. ($)', usd: true },
  { key: 'netPnl', label: 'Net P&L ($)', usd: true, signed: true },
  { key: 'returnPct', label: 'Return (%)', pct: true, signed: true },
  { key: 'unrealized', label: 'Unrealized at Close ($)', usd: true, signed: true },
  { key: 'maxMargin', label: 'Max Margin Used ($)', usd: true },
  { key: 'maxMarginPct', label: 'Max Margin (% of balance)', pct: true },
  { key: 'maxMarginAt', label: 'Max Margin Time (IST)' },
  { key: 'marginSource', label: 'Margin Source', exportOnly: true }, // on screen: the "est." tag
  { key: 'exits', label: 'Exits' },
  { key: 'status', label: 'Status' },
];

const SCREEN_COLUMNS = COLUMNS.filter(c => !c.exportOnly);

export default function DailyReport({ onNavigate, theme, toggleTheme, active }) {
  // Current trading day; refreshed with each load so the range/status roll over at 17:30 IST.
  const [today, setToday] = useState(() => tradeDateOf(Date.now()));
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('all');
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

  const table = useMemo(() => rows.map(r => ({
    date: r.trade_date,
    account: nameOf[r.account_id] ?? r.account_id,
    accountId: r.account_id,
    openingBalance: num(r.opening_balance),
    closingBalance: num(r.closing_balance),
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
    marginSource: r.max_margin_used == null ? '' : (r.margin_is_estimate ? 'Estimate (trade history)' : 'Delta'),
    marginEstimate: !!r.margin_is_estimate,
    exits: r.trades_closed ?? 0,
    status: r.is_backfilled ? 'Backfilled' : r.is_final ? 'Final' : (r.trade_date === today ? 'In progress' : 'Not final'),
  })), [rows, nameOf, today]);

  // Totals: $ columns summed; return = total net ÷ each account's first opening balance in
  // the range; peak margin = the highest single-day peak.
  const totals = useMemo(() => {
    if (table.length === 0) return null;
    const sum = (k) => table.reduce((s, r) => s + (r[k] ?? 0), 0);
    const firstOpening = {};
    [...table].sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
      if (firstOpening[r.accountId] == null && r.openingBalance != null) firstOpening[r.accountId] = r.openingBalance;
    });
    const base = Object.values(firstOpening).reduce((s, v) => s + v, 0);
    const net = sum('netPnl');
    const peak = table.reduce((best, r) => (r.maxMargin != null && (best == null || r.maxMargin > best.maxMargin) ? r : best), null);
    return {
      realizedGross: sum('realizedGross'),
      feesActual: table.some(r => r.feesActual != null) ? sum('feesActual') : null,
      feesEstimated: sum('feesEstimated'),
      netPnl: net,
      returnPct: base > 0 ? (net / base) * 100 : null,
      maxMargin: peak?.maxMargin ?? null,
      maxMarginPct: peak?.maxMarginPct ?? null,
      maxMarginEstimate: !!peak?.marginEstimate,
      exits: sum('exits'),
      days: new Set(table.map(r => r.date)).size,
    };
  }, [table]);

  const exportRows = () => {
    const out = table.map(r => Object.fromEntries(COLUMNS.map(c => {
      const v = r[c.key];
      return [c.key, (c.usd || c.pct) ? r2(v) : v];
    })));
    if (totals) {
      out.push({
        date: 'TOTAL', account: accountId === 'all' ? 'All live accounts' : (nameOf[accountId] ?? ''),
        realizedGross: r2(totals.realizedGross), feesActual: r2(totals.feesActual), feesEstimated: r2(totals.feesEstimated),
        netPnl: r2(totals.netPnl), returnPct: r2(totals.returnPct), maxMargin: r2(totals.maxMargin),
        maxMarginPct: r2(totals.maxMarginPct), exits: totals.exits,
        marginSource: totals.maxMarginEstimate ? 'Estimate (trade history)' : (totals.maxMargin != null ? 'Delta' : ''),
      });
    }
    return out;
  };
  const fileBase = `live-daily-report_${accountId === 'all' ? 'all-accounts' : (nameOf[accountId] || 'account').replace(/[^\w-]+/g, '-')}_${from}_to_${to}`;

  const cell = (c, r) => {
    const v = r[c.key];
    if (c.key === 'maxMargin' && r.marginEstimate && v != null) {
      return <span title="Estimated from trade history (sum of margins of spreads open at the same time) — recorded before live tracking started">~{fmtUsd(v)} <span className="dr-est">est.</span></span>;
    }
    // Today's day is still running: its "closing" is the latest balance, not the day-end one.
    if (c.key === 'closingBalance' && r.status === 'In progress' && v != null) {
      return <span title="Latest Delta balance — becomes the closing balance when the day ends at 17:30 IST">{fmtUsd(v)} <span className="dr-live">live</span></span>;
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

            {totals && (
              <div className="dr-summary">
                <div className="dr-stat"><span>Net P&amp;L</span><strong className={tone(totals.netPnl)}>{fmtUsd(totals.netPnl)}</strong></div>
                <div className="dr-stat" title="Total net P&L ÷ each account's opening balance on its first day in the range"><span>Return</span><strong className={tone(totals.returnPct)}>{fmtPct(totals.returnPct)}</strong></div>
                <div className="dr-stat"><span>Fees Paid (Delta)</span><strong>{fmtUsd(totals.feesActual)}</strong></div>
                <div className="dr-stat"><span>Peak Margin Used</span><strong>{totals.maxMarginEstimate ? '~' : ''}{fmtUsd(totals.maxMargin)}{totals.maxMarginPct != null && <em> · {fmtPct(totals.maxMarginPct)}</em>}{totals.maxMarginEstimate && <em className="dr-est"> est.</em>}</strong></div>
                <div className="dr-stat"><span>Days</span><strong>{totals.days}</strong></div>
              </div>
            )}

            <div className="dr-table-wrap">
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
                      <tr>{SCREEN_COLUMNS.map(c => <th key={c.key} className={c.usd || c.pct || c.key === 'exits' ? 'r' : ''}>{c.label.replace(/ \(\$\)$/, '')}</th>)}</tr>
                    </thead>
                    <tbody>
                      {table.map(r => (
                        <tr key={`${r.accountId}-${r.date}`}>
                          {SCREEN_COLUMNS.map(c => <td key={c.key} className={c.usd || c.pct || c.key === 'exits' ? 'r' : ''}>{cell(c, r)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    {totals && (
                      <tfoot>
                        <tr>
                          <td>Total</td>
                          <td>{totals.days} day{totals.days === 1 ? '' : 's'}</td>
                          <td className="r">—</td>
                          <td className="r">—</td>
                          <td className="r"><span className={tone(totals.realizedGross)}>{fmtUsd(totals.realizedGross)}</span></td>
                          <td className="r">{fmtUsd(totals.feesActual)}</td>
                          <td className="r">{fmtUsd(totals.feesEstimated)}</td>
                          <td className="r"><span className={tone(totals.netPnl)}>{fmtUsd(totals.netPnl)}</span></td>
                          <td className="r"><span className={tone(totals.returnPct)}>{fmtPct(totals.returnPct)}</span></td>
                          <td className="r">—</td>
                          <td className="r">{totals.maxMarginEstimate ? '~' : ''}{fmtUsd(totals.maxMargin)}{totals.maxMarginEstimate && <span className="dr-est"> est.</span>}</td>
                          <td className="r">{fmtPct(totals.maxMarginPct)}</td>
                          <td>—</td>
                          <td className="r">{totals.exits}</td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>

            <p className="dr-note">
              Trading day = 17:30 → 17:30 IST, named for the end date. For the day in progress, closing balance, P&amp;L and
              return are live (so far) and become final at 17:30 IST. Realized P&amp;L and fees are Delta's own figures (order
              history, as on the Live dashboard). Net P&amp;L = realized P&amp;L − fees (the engine's fee estimate is used only if
              Delta's isn't available). Return = Net P&amp;L ÷ opening balance.
              Max margin = the highest margin Delta blocked during the day; days marked <em>est.</em> were filled in later from trade
              history (sum of margins of spreads open at the same time). Backfilled rows predate live tracking.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
