import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, Gauge } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import ReportAccountPicker from './components/DailyReport/ReportAccountPicker';
import ReportGroupsModal from './components/DailyReport/ReportGroupsModal';
import { buildNameGroups } from './components/DailyReport/accountGroups';
import { supabase } from './supabase';
import { exportCsv, exportXlsx } from './exportTable';

// Slippage — per LIVE entry, the quote the engine entered on (scanner prices: long at the ask,
// short at the bid, hedge at the ask — active_positions / trade_history entry prices) against
// Delta's actual average fill for that leg's entry order (`<position id>-EB` / `-ES` / `-HB`,
// from live_exchange_state.order_history via the live_entry_fills RPC, migration 069).
// Slippage > 0 = worse than the quote (paid more for a buy, received less for a sell).

const DAY_MS = 24 * 60 * 60 * 1000;
const tradeDateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDate = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

const fmtUsd = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPx = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const fmtSlip = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);
const fmtIst = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
// Slippage is a cost: above 0 is bad (red), below 0 a better fill than quoted (green).
const slipTone = (v) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'negative' : 'positive');

const PRESETS = [
  { key: '1d', label: '1D', range: (t) => [t, t] },
  { key: '7d', label: '7D', range: (t) => [shiftDate(t, -6), t] },
  { key: '30d', label: '30D', range: (t) => [shiftDate(t, -29), t] },
];

const LEGS = [
  { key: 'long', label: 'Long', tag: 'EB', sign: 1 },    // bought at the ask
  { key: 'short', label: 'Short', tag: 'ES', sign: -1 }, // sold at the bid
  { key: 'hedge', label: 'Hedge', tag: 'HB', sign: 1 },  // bought at the ask
];

// Export columns (one row per entry).
const EXPORT_COLUMNS = [
  { key: 'time', label: 'Entry Time (IST)' },
  { key: 'account', label: 'Account' },
  { key: 'type', label: 'Type' },
  ...LEGS.flatMap(l => [
    { key: `${l.key}Strike`, label: `${l.label} Strike` },
    { key: `${l.key}Quote`, label: `${l.label} Quote ($)` },
    { key: `${l.key}Fill`, label: `${l.label} Avg Fill ($)` },
    { key: `${l.key}Slip`, label: `${l.label} Slippage ($)` },
    { key: `${l.key}Pct`, label: `${l.label} Slippage (%)` },
    { key: `${l.key}Contracts`, label: `${l.label} Contracts Filled` },
    { key: `${l.key}Cost`, label: `${l.label} Slippage Cost ($)` },
  ]),
  { key: 'cost', label: 'Total Slippage Cost ($)' },
];

const PAGE = 1000;
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const ENTRY_COLS = 'account_id, type, buy_leg, sell_leg, hedge_leg, sell_qty, entry_time, entry_buy_price, entry_sell_price';
const TAG_RE = /-(EB|ES|HB)$/;

// Entry orders since `since`: the RPC returns only those (migration 069). Before it is run,
// fall back to downloading each account's order history and filtering here.
async function fetchEntryFills(ids, since) {
  const { data, error } = await supabase.rpc('live_entry_fills', { p_account_ids: ids, p_since: since });
  if (!error) return data || [];
  const missing = error.code === 'PGRST202' || /could not find the function|does not exist/i.test(error.message || '');
  if (!missing) throw error;
  const { data: states, error: e2 } = await supabase.from('live_exchange_state').select('account_id, order_history').in('account_id', ids);
  if (e2) throw e2;
  const sinceMs = Date.parse(since);
  return (states || []).flatMap(s => (Array.isArray(s.order_history) ? s.order_history : [])
    .filter(o => TAG_RE.test(String(o?.client_order_id || '')) && Date.parse(o.created_at) >= sinceMs)
    .map(o => ({
      account_id: s.account_id, client_order_id: o.client_order_id, size: o.size, unfilled_size: o.unfilled_size,
      limit_price: o.limit_price, average_fill_price: o.average_fill_price, contract_value: o.product?.contract_value ?? null,
    })));
}

// One leg's quote vs fill. `sign` turns the price gap into a cost (buy: fill − quote; sell: quote − fill).
function legResult(quote, order, sign, fallbackCv, strike) {
  if (!(quote > 0)) return null;
  const base = { quote, strike, limit: num(order?.limit_price) };
  if (!order) return { ...base, status: 'no-data' };
  const fill = num(order.average_fill_price);
  const filled = Math.max(0, Math.round((num(order.size) ?? 0) - (num(order.unfilled_size) ?? 0)));
  if (fill == null || filled <= 0) return { ...base, status: 'unfilled', filled: 0 };
  const cv = num(order.contract_value) ?? fallbackCv;
  const slip = sign * (fill - quote);
  return { ...base, status: 'ok', fill, filled, slip, pct: (slip / quote) * 100, cost: cv != null ? slip * filled * cv : null };
}

function summarize(rows) {
  const legs = Object.fromEntries(LEGS.map(l => {
    const list = rows.map(r => r[l.key]).filter(x => x?.status === 'ok');
    const contracts = list.reduce((s, x) => s + x.filled, 0);
    return [l.key, {
      n: list.length,
      // Contract-weighted average, so a 2,400-contract order counts more than a 100-contract one.
      avgSlip: contracts > 0 ? list.reduce((s, x) => s + x.slip * x.filled, 0) / contracts : null,
      avgPct: contracts > 0 ? list.reduce((s, x) => s + x.pct * x.filled, 0) / contracts : null,
      cost: list.some(x => x.cost != null) ? list.reduce((s, x) => s + (x.cost ?? 0), 0) : null,
      worst: list.reduce((w, x) => (w == null || x.pct > w ? x.pct : w), null),
    }];
  }));
  const matched = rows.filter(r => r.matched);
  const cost = matched.reduce((s, r) => s + (r.cost ?? 0), 0);
  const worst = matched.reduce((w, r) => (r.cost != null && (w == null || r.cost > w.cost) ? r : w), null);
  return { entries: rows.length, matched: matched.length, cost, worst, legs };
}

export default function SlippageReport({ onNavigate, theme, toggleTheme, active }) {
  const [today, setToday] = useState(() => tradeDateOf(Date.now()));
  const [session, setSession] = useState(undefined);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('all');
  const [from, setFrom] = useState(() => shiftDate(tradeDateOf(Date.now()), -6));
  const [to, setTo] = useState(() => tradeDateOf(Date.now()));
  const [data, setData] = useState({ entries: [], fills: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: d }) => setSession(d.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Live accounts this user can see (RLS: own accounts; admins all).
  useEffect(() => {
    if (!session) return;
    supabase.from('paper_trading_accounts').select('id, name, mode')
      .eq('mode', 'live').order('created_at', { ascending: true })
      .then(({ data: d, error: e }) => {
        if (e) setError(`Couldn't load accounts: ${e.message}`);
        else setAccounts(d || []);
      });
  }, [session]);

  // Same saved report groups as the Daily Report (report_account_groups, migration 067).
  const [savedGroups, setSavedGroups] = useState(null);
  const [editingGroups, setEditingGroups] = useState(false);
  useEffect(() => {
    if (!session) return;
    supabase.from('report_account_groups').select('groups').eq('user_id', session.user.id).maybeSingle()
      .then(({ data: d, error: e }) => { if (!e) setSavedGroups(Array.isArray(d?.groups) ? d.groups : null); });
  }, [session]);
  const nameGroups = useMemo(() => {
    if (!savedGroups) return buildNameGroups(accounts);
    const nameById = new Map(accounts.map(a => [a.id, a.name]));
    return savedGroups
      .map(g => {
        const ids = (g.ids || []).filter(id => nameById.has(id));
        return { key: `group:${g.id}`, label: g.label, ids, names: ids.map(id => nameById.get(id)) };
      })
      .filter(g => g.ids.length > 1);
  }, [accounts, savedGroups]);
  const selectedGroup = nameGroups.find(g => g.key === accountId) ?? null;
  const leaveRemovedGroup = (keys) => setAccountId(id => (id.startsWith('group:') && !keys.includes(id) ? 'all' : id));
  const saveReportGroups = async (list) => {
    const { error: e } = await supabase.from('report_account_groups')
      .upsert({ user_id: session.user.id, groups: list, updated_at: new Date().toISOString() });
    if (e) throw new Error(`Couldn't save groups: ${e.message}`);
    setSavedGroups(list);
    leaveRemovedGroup(list.map(g => `group:${g.id}`));
  };
  const resetReportGroups = async () => {
    const { error: e } = await supabase.from('report_account_groups').delete().eq('user_id', session.user.id);
    if (e) throw new Error(`Couldn't reset groups: ${e.message}`);
    setSavedGroups(null);
    leaveRemovedGroup(buildNameGroups(accounts).map(g => g.key));
  };

  const fetchData = useCallback(async () => {
    const ids = accountId === 'all' ? accounts.map(a => a.id)
      : selectedGroup ? selectedGroup.ids
      : accountId.startsWith('group:') ? []
      : [accountId];
    if (!session || ids.length === 0) return { entries: [], fills: [] };
    const since = `${from}T00:00:00.000Z`;
    const until = `${to}T23:59:59.999Z`;
    const [open, closed, fills] = await Promise.all([
      fetchAll(() => supabase.from('active_positions').select(`id, ${ENTRY_COLS}`)
        .in('account_id', ids).gte('entry_time', since).lte('entry_time', until).order('entry_time', { ascending: false })),
      // Hedge exit rows (-HX…) carry the hedge price in entry_buy_price — not an entry row.
      fetchAll(() => supabase.from('trade_history').select(`trade_id, ${ENTRY_COLS}`)
        .in('account_id', ids).gte('entry_time', since).lte('entry_time', until).not('trade_id', 'like', '%-HX%')
        .order('entry_time', { ascending: false })),
      // Orders are created a moment before the position row is written — start an hour early.
      fetchEntryFills(ids, new Date(Date.parse(since) - 3600000).toISOString()),
    ]);
    // One entry per position id: an open position, else its full-exit row, else a partial row
    // that still carries the short (a long-ladder row may have sell_qty 0).
    const rank = (r) => (r.trade_id == null ? 3 : r.trade_id === r.id ? 2 : num(r.sell_qty) > 0 ? 1 : 0);
    const byId = new Map();
    open.forEach(r => byId.set(r.id, { ...r, id: r.id }));
    closed.forEach(r => {
      const id = String(r.trade_id || '').split('-')[0];
      if (!id || id.startsWith('A')) return; // adopted orphans have no entry orders
      const row = { ...r, id };
      const prev = byId.get(id);
      if (!prev || rank(row) > rank(prev)) byId.set(id, row);
    });
    return { entries: [...byId.values()], fills };
  }, [session, accounts, accountId, selectedGroup, from, to]);

  const apply = useCallback((d) => {
    setData(d);
    setError('');
    setLoadedAt(Date.now());
    setToday(tradeDateOf(Date.now()));
  }, []);

  const load = async () => {
    setLoading(true);
    try { apply(await fetchData()); }
    catch (e) { setError(`Couldn't load slippage: ${e.message}`); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const run = () => fetchData()
      .then(d => { if (!cancelled) apply(d); })
      .catch(e => { if (!cancelled) setError(`Couldn't load slippage: ${e.message}`); });
    run();
    const t = setInterval(run, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active, fetchData, apply]);

  const nameOf = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a.name])), [accounts]);

  const rows = useMemo(() => {
    const byTag = new Map(data.fills.map(f => [String(f.client_order_id), f]));
    return data.entries.map(e => {
      const bl = e.buy_leg || {};
      const sl = e.sell_leg || {};
      const hl = e.hedge_leg || null;
      const long = legResult(num(e.entry_buy_price), byTag.get(`${e.id}-EB`), 1,
        num(bl.contractValue) ?? num(bl.originalLotSize), bl.strike);
      const short = num(e.sell_qty) > 0
        ? legResult(num(e.entry_sell_price), byTag.get(`${e.id}-ES`), -1, num(sl.contractValue) ?? num(sl.lotSize), sl.strike)
        : null;
      const hedge = hl ? legResult(num(hl.entryPrice), byTag.get(`${e.id}-HB`), 1,
        num(hl.contractValue) ?? num(hl.originalLotSize), hl.strike) : null;
      const legs = [long, short, hedge].filter(Boolean);
      const matched = legs.some(x => x.status === 'ok');
      return {
        id: e.id,
        accountId: e.account_id,
        account: nameOf[e.account_id] ?? e.account_id,
        entryTime: e.entry_time,
        type: String(e.type || '').toUpperCase(),
        long, short, hedge,
        matched,
        cost: matched && legs.some(x => x.cost != null) ? legs.reduce((s, x) => s + (x.cost ?? 0), 0) : null,
      };
    }).sort((a, b) => String(b.entryTime).localeCompare(String(a.entryTime)));
  }, [data, nameOf]);

  const totals = useMemo(() => summarize(rows), [rows]);
  const allAccounts = accountId === 'all' || !!selectedGroup;
  const breakdown = useMemo(() => {
    if (!allAccounts) return [];
    const by = new Map();
    rows.forEach(r => { if (!by.has(r.accountId)) by.set(r.accountId, []); by.get(r.accountId).push(r); });
    const order = accounts.map(a => a.id);
    return [...by.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([id, list]) => ({ id, name: nameOf[id] ?? id, ...summarize(list) }));
  }, [allAccounts, rows, accounts, nameOf]);

  const activePreset = PRESETS.find(p => { const [f, t] = p.range(today); return f === from && t === to; })?.key;
  const applyPreset = (p) => { const [f, t] = p.range(today); setFrom(f); setTo(t); };

  const exportRows = () => rows.map(r => {
    const out = { time: fmtIst(r.entryTime), account: r.account, type: r.type, cost: r2(r.cost) };
    LEGS.forEach(l => {
      const x = r[l.key];
      out[`${l.key}Strike`] = x?.strike ?? '';
      out[`${l.key}Quote`] = x?.quote ?? null;
      out[`${l.key}Fill`] = x?.fill != null ? r4(x.fill) : null;
      out[`${l.key}Slip`] = x?.slip != null ? r4(x.slip) : null;
      out[`${l.key}Pct`] = x?.pct != null ? r2(x.pct) : null;
      out[`${l.key}Contracts`] = x?.filled ?? null;
      out[`${l.key}Cost`] = x?.cost != null ? r2(x.cost) : null;
    });
    return out;
  });
  const selectionSlug = accountId === 'all' ? 'all-accounts'
    : selectedGroup ? `${selectedGroup.label}-group` : (nameOf[accountId] || 'account');
  const fileBase = `live-slippage_${selectionSlug.replace(/[^\w-]+/g, '-')}_${from}_to_${to}`;

  const legCell = (x) => {
    if (!x) return <span className="sl-muted">—</span>;
    if (x.status === 'no-data') {
      return <span className="sl-muted" title="This order is not in Delta's recent order history (older than ~2,000 orders), so its fill price isn't available">{fmtPx(x.quote)} · no fill data</span>;
    }
    if (x.status === 'unfilled') return <span className="sl-muted" title="The entry order did not fill">{fmtPx(x.quote)} · not filled</span>;
    return (
      <span className="sl-leg" title={`Quote ${x.quote} · limit sent ${x.limit ?? '—'} · avg fill ${r4(x.fill)} · ${x.filled} contract(s)${x.cost != null ? ` · cost ${fmtUsd(x.cost)}` : ''}`}>
        <span className="sl-px">{fmtPx(x.quote)} → {fmtPx(x.fill)}</span>
        <span className={`sl-slip ${slipTone(x.slip)}`}>{fmtSlip(x.slip)} ({fmtPct(x.pct)})</span>
      </span>
    );
  };

  const legTile = (l) => {
    const s = totals.legs[l.key];
    return (
      <div className="dr-tile" key={l.key} title={`Contract-weighted average over ${s.n} filled ${l.label.toLowerCase()} order(s). Above 0 = worse than the quote.`}>
        <span>{l.label} slippage</span>
        <strong className={slipTone(s.avgPct)}>{fmtPct(s.avgPct)}</strong>
        <em>{s.n ? `${fmtSlip(s.avgSlip)} per unit · ${fmtUsd(s.cost)} · ${s.n} order${s.n === 1 ? '' : 's'}` : 'No fills in range'}</em>
      </div>
    );
  };

  return (
    <div className="app">
      <Navbar activeTab="slippage" onNavigate={onNavigate} theme={theme} toggleTheme={toggleTheme}
        badgeLabel={loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Slippage'} />

      <div className="body dr-body">
        {session === null ? (
          <div className="pt-empty">
            <span className="pt-empty-title">Log in to see slippage</span>
            <span className="pt-empty-desc">Sign in on the Live Trading tab, then come back here.</span>
            <button type="button" className="dr-btn" onClick={() => onNavigate('live')}>Go to Live Trading</button>
          </div>
        ) : (
          <>
            <div className="dr-toolbar">
              <span className="dr-title"><Gauge size={15} /> Live Entry Slippage</span>
              <div className="dr-filters">
                <div className="dr-field">
                  <span>Account</span>
                  <ReportAccountPicker accounts={accounts} groups={nameGroups} value={accountId} onChange={setAccountId}
                    onEditGroups={() => setEditingGroups(true)} />
                </div>
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
                <button type="button" className="dr-btn" disabled={rows.length === 0}
                  onClick={() => exportCsv(EXPORT_COLUMNS, exportRows(), `${fileBase}.csv`)}>
                  <Download size={13} /> CSV
                </button>
                <button type="button" className="dr-btn primary" disabled={rows.length === 0}
                  onClick={() => exportXlsx(EXPORT_COLUMNS, exportRows(), `${fileBase}.xlsx`, 'Slippage')}>
                  <FileSpreadsheet size={13} /> Excel
                </button>
              </div>
            </div>

            {error && <div className="dr-error">{error}</div>}

            {editingGroups && (
              <ReportGroupsModal accounts={accounts} groups={nameGroups} isCustom={savedGroups != null}
                onSave={saveReportGroups} onReset={resetReportGroups} onClose={() => setEditingGroups(false)} />
            )}

            {totals.matched > 0 && (
              <div className="dr-summary">
                <div className="dr-hero" title="Sum over every filled entry leg of (slippage per unit × contracts filled × contract value)">
                  <span className="dr-hero-label">Slippage cost · entries</span>
                  <strong className={`dr-hero-value ${slipTone(totals.cost)}`}>{fmtUsd(totals.cost)}</strong>
                  <div className="dr-hero-sub">
                    <span>{totals.matched} of {totals.entries} entries with fill data</span>
                  </div>
                </div>
                <div className="dr-tiles">
                  {LEGS.map(legTile)}
                  <div className="dr-tile" title="Entry with the largest total slippage cost in the range">
                    <span>Worst entry</span>
                    <strong className={slipTone(totals.worst?.cost)}>{fmtUsd(totals.worst?.cost)}</strong>
                    <em>{totals.worst ? `${totals.worst.account} · ${totals.worst.type} ${totals.worst.long?.strike ?? ''}/${totals.worst.short?.strike ?? ''} · ${fmtIst(totals.worst.entryTime)}` : '—'}</em>
                  </div>
                </div>
              </div>
            )}

            {breakdown.length > 1 && totals.matched > 0 && (
              <div className="dr-card">
                <div className="dr-card-head">
                  <span className="dr-card-title">By account</span>
                  <span className="dr-card-sub">Click an account to see only its entries</span>
                </div>
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table dr-breakdown">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th className="r">Entries</th>
                        <th className="r">Long</th>
                        <th className="r">Short</th>
                        <th className="r">Hedge</th>
                        <th className="r">Slippage cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.map(b => (
                        <tr key={b.id} className="dr-click" onClick={() => setAccountId(b.id)} title={`Open ${b.name}`}>
                          <td><strong>{b.name}</strong></td>
                          <td className="r">{b.matched}{b.entries > b.matched ? <span className="sl-muted"> / {b.entries}</span> : null}</td>
                          {LEGS.map(l => (
                            <td key={l.key} className="r"><span className={slipTone(b.legs[l.key].avgPct)}>{fmtPct(b.legs[l.key].avgPct)}</span></td>
                          ))}
                          <td className="r"><span className={slipTone(b.cost)}>{fmtUsd(b.cost)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">Entries</span>
                <span className="dr-card-sub">Quote → Delta avg fill · slippage per unit (%)</span>
              </div>
              {rows.length === 0 ? (
                <div className="pt-empty">
                  <span className="pt-empty-title">{loadedAt == null && accounts.length > 0 ? 'Loading…' : accounts.length === 0 ? 'No live accounts' : 'No live entries in this range'}</span>
                </div>
              ) : (
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table sl-table">
                    <thead>
                      <tr>
                        <th>Entry (IST)</th>
                        {allAccounts && <th>Account</th>}
                        <th>Spread</th>
                        <th>Long</th>
                        <th>Short</th>
                        <th>Hedge</th>
                        <th className="r">Slippage cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id}>
                          <td>{fmtIst(r.entryTime)}</td>
                          {allAccounts && <td>{r.account}</td>}
                          <td>{r.type} {r.long?.strike ?? '—'}/{r.short?.strike ?? '—'}{r.hedge ? `/${r.hedge.strike}` : ''}</td>
                          <td>{legCell(r.long)}</td>
                          <td>{legCell(r.short)}</td>
                          <td>{legCell(r.hedge)}</td>
                          <td className="r"><span className={slipTone(r.cost)}>{fmtUsd(r.cost)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <details className="dr-note">
              <summary>How slippage is calculated</summary>
              <p>
                Quote = the price the engine entered on when it picked the spread (the scanner prices): the long and the hedge at the
                ask, the short at the bid. Fill = Delta's average fill price of that leg's entry order. Slippage per unit = fill − quote
                for a buy, quote − fill for a sell, so above 0 is always worse than quoted (red) and below 0 better (green).
                Slippage cost = slippage per unit × contracts filled × contract value (e.g. 0.001 BTC).
              </p>
              <p>
                Fills come from Delta's order history, which keeps the most recent ~2,000 orders per account; older entries show
                “no fill data”. Leg averages are weighted by contracts filled.
              </p>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
