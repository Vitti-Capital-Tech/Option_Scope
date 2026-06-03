import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getSpotPrice,
  fmtExpiry,
} from './api';
import { formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];

// ─── Helpers (kept identical to server engine) ────────────────────────────────

const safeParseLeg = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  return null;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ATMExitTrading({ onNavigate, theme, toggleTheme }) {
  // ── Config ──────────────────────────────────────────────────────────────────
  const [config, setConfig] = useState({
    underlying: 'BTC',
    expiry: '',
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
    maxNetPremium: 20,
    minLongDist: 500,
    maxSellQty: 10,
  });

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  // ── Core display state ───────────────────────────────────────────────────────
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [analyticsData, setAnalyticsData] = useState({});
  const [includeFees, setIncludeFees] = useState(true);
  const [showTotalMode, setShowTotalMode] = useState(false);

  // ── Server heartbeat ─────────────────────────────────────────────────────────
  // Reads from `atm_exit_heartbeat` (or whichever heartbeat table the engine writes).
  // Shape expected: { engine_id, status, updated_at, active_positions, spot_price,
  //                   underlying, expiry, ws_status }
  const [heartbeat, setHeartbeat] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ── History date filter ──────────────────────────────────────────────────────
  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });

  const adjustFilterDay = (offset) => {
    if (!historyFilterDate) return;
    const [y, m, d] = historyFilterDate.split('-').map(Number);
    const current = new Date(Date.UTC(y, m - 1, d));
    current.setUTCDate(current.getUTCDate() + offset);
    setHistoryFilterDate(current.toISOString().split('T')[0]);
  };

  const resetToToday = () => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    setHistoryFilterDate(d.toISOString().split('T')[0]);
  };

  // ─── Supabase fetchers ────────────────────────────────────────────────────────

  const fetchConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('atm_exit_config').select('*').eq('id', 'global').maybeSingle();
      if (data && !error) {
        setConfig({
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10,
        });
      }
    } catch (e) { /* ignore */ }
  }, []);

  const saveSupabaseConfig = useCallback(async (newCfg) => {
    try {
      await supabase.from('atm_exit_config').upsert({
        id: 'global',
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        min_long_dist: newCfg.minLongDist,
        max_sell_qty: newCfg.maxSellQty,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* ignore */ }
  }, []);

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      tabBroadcast('ATM_EXIT_CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  const fetchActivePositions = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('atm_exit_active_positions').select('*')
        .order('entry_time', { ascending: true });
      if (error) { console.error('Fetch positions error', error); return; }
      if (data && data.length > 0) {
        setPositions(prev => {
          const prevMap = new Map(prev.map(p => [p.id, p]));
          const mapped = data.map(p => {
            const existing = prevMap.get(p.id);
            const buyLeg = safeParseLeg(p.buy_leg);
            const sellLeg = safeParseLeg(p.sell_leg);
            return {
              id: p.id,
              underlying: p.underlying,
              expiry: p.expiry,
              type: p.type,
              buyLeg,
              sellLeg,
              sellQty: p.sell_qty,
              strikeDiff: p.strike_diff,
              entryTime: new Date(p.entry_time),
              entryBuyPrice: p.entry_buy_price,
              entrySellPrice: p.entry_sell_price,
              entrySpotPrice: p.entry_spot_price,
              margin: p.margin || 0,
              entryFee: p.entry_fee || 0,
              accumulatedSellPnl: p.accumulated_sell_pnl || 0,
              // Carry over live PnL fields from previous render if present
              unrealizedGrossPnl: existing?.unrealizedGrossPnl ?? 0,
              unrealizedNetPnl: existing?.unrealizedNetPnl ?? -(p.entry_fee || 0),
            };
          });
          return mapped
            .filter(p => p.buyLeg && p.sellLeg)
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
              return a.type === 'call'
                ? a.buyLeg.strike - b.buyLeg.strike
                : b.buyLeg.strike - a.buyLeg.strike;
            });
        });
      } else if (data) {
        setPositions([]);
      }
    } catch (e) { console.error('Fetch positions exception', e); }
  }, []);

  const fetchTradeHistory = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('atm_exit_trade_history').select('*')
        .eq('underlying', underlying)
        .order('exit_time', { ascending: false });
      if (error || !data) return;
      setTradeHistory(data.map(t => ({
        id: t.trade_id || t.id,
        underlying: t.underlying,
        expiry: t.expiry,
        type: t.type,
        buyLeg: safeParseLeg(t.buy_leg),
        sellLeg: safeParseLeg(t.sell_leg),
        sellQty: t.sell_qty,
        strikeDiff: t.strike_diff,
        entryTime: new Date(t.entry_time),
        exitTime: new Date(t.exit_time),
        entryBuyPrice: t.entry_buy_price,
        entrySellPrice: t.entry_sell_price,
        exitBuyPrice: t.exit_buy_price,
        exitSellPrice: t.exit_sell_price,
        entrySpotPrice: t.entry_spot_price,
        exitSpotPrice: t.exit_spot_price,
        margin: t.margin,
        realizedGrossPnl: t.realized_gross_pnl,
        realizedNetPnl: t.realized_net_pnl,
        exitFee: t.exit_fee,
        totalFees: t.total_fees,
        exitReason: t.exit_reason,
      })));
    } catch (e) { /* ignore */ }
  }, [underlying]);

  const fetchAnalytics = useCallback(async () => {
    const buckets = [
      'atm_exit_qty_0_2_5', 'atm_exit_qty_2_5_5',
      'atm_exit_qty_5_7_5', 'atm_exit_qty_7_5_10',
    ];
    const results = {};
    for (const b of buckets) {
      const { data } = await supabase
        .from(b).select('*').eq('underlying', underlying).order('strike_diff');
      results[b] = data || [];
    }
    setAnalyticsData(results);
  }, [underlying]);

  const fetchHeartbeat = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('engine_heartbeat').select('*')
        .eq('id', 'atm_exit').maybeSingle();
      if (data && !error) setHeartbeat(data);
    } catch (e) { /* ignore */ }
  }, []);

  // ─── Products / spot ──────────────────────────────────────────────────────────

  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        updateConfig('expiry', exps[0]);
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setExpiries([]); refreshProducts(); }, [underlying]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(refreshProducts, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshProducts]);

  useEffect(() => {
    const fetchSpot = () =>
      getSpotPrice(underlying)
        .then(sp => { if (sp) setSpotPrice(sp); })
        .catch(() => { });
    fetchSpot();
    const id = setInterval(fetchSpot, 10000);
    return () => clearInterval(id);
  }, [underlying]);

  // ─── Polling ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchConfig();
    fetchActivePositions();
    fetchTradeHistory();
    fetchAnalytics();
    fetchHeartbeat();

    const id = setInterval(() => {
      fetchActivePositions();
      fetchTradeHistory();
      fetchAnalytics();
      fetchHeartbeat();
    }, 10000);

    return () => clearInterval(id);
  }, [fetchConfig, fetchActivePositions, fetchTradeHistory, fetchAnalytics, fetchHeartbeat]);

  // ─── Tab sync ─────────────────────────────────────────────────────────────────

  const { broadcast } = useTabListener((type, data) => {
    if (type === 'ATM_EXIT_CONFIG_SYNC') setConfig(prev => ({ ...prev, ...data.config }));
  });
  const tabBroadcast = (type, data) => { if (broadcast) broadcast({ type, data }); };

  // ─── Derived / memoised values ────────────────────────────────────────────────

  const uniqueTradeHistory = React.useMemo(() => {
    const seen = new Set();
    return tradeHistory.filter(t => {
      const id = t.id || t.trade_id;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [tradeHistory]);

  const filteredTradeHistory = React.useMemo(() => {
    if (!historyFilterDate) return uniqueTradeHistory;
    return uniqueTradeHistory.filter(t => {
      if (!t.exitTime) return false;
      const d = new Date(t.exitTime);
      if (isNaN(d.getTime())) return false;
      d.setUTCHours(d.getUTCHours() + 12);
      return d.toISOString().split('T')[0] === historyFilterDate;
    });
  }, [uniqueTradeHistory, historyFilterDate]);

  const todayRealizedPnl = React.useMemo(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    const todayUtc = d.toISOString().split('T')[0];
    return uniqueTradeHistory.reduce((s, t) => {
      if (!t.exitTime) return s;
      const dt = new Date(t.exitTime);
      if (isNaN(dt.getTime())) return s;
      dt.setUTCHours(dt.getUTCHours() + 12);
      if (dt.toISOString().split('T')[0] !== todayUtc) return s;
      return s + ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0);
    }, 0);
  }, [uniqueTradeHistory, includeFees]);

  const totalUnrealizedPnl = positions
    .filter(p => p.underlying === underlying)
    .reduce((s, p) => s + ((includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) || 0), 0);

  const totalRealizedPnl = uniqueTradeHistory
    .reduce((s, t) => s + ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0), 0);

  const todayPnl = todayRealizedPnl + totalUnrealizedPnl;
  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;
  const wins = uniqueTradeHistory.filter(t => ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0) > 0).length;
  const winRate = uniqueTradeHistory.length > 0 ? ((wins / uniqueTradeHistory.length) * 100).toFixed(1) : '—';
  const totalMargin = positions
    .filter(p => p.underlying === underlying)
    .reduce((s, p) => s + (p.margin || 0), 0);

  const calculatedAnalyticsData = React.useMemo(() => {
    const buckets = {
      'atm_exit_qty_0_2_5': [],
      'atm_exit_qty_2_5_5': [],
      'atm_exit_qty_5_7_5': [],
      'atm_exit_qty_7_5_10': [],
    };
    const groups = {};
    uniqueTradeHistory.forEach(t => {
      if (t.underlying !== underlying) return;
      const qty = t.sellQty || 0;
      let bucketName = 'atm_exit_qty_7_5_10';
      if (qty <= 2.5) bucketName = 'atm_exit_qty_0_2_5';
      else if (qty <= 5) bucketName = 'atm_exit_qty_2_5_5';
      else if (qty <= 7.5) bucketName = 'atm_exit_qty_5_7_5';
      const strikeDiff = Math.round((t.strikeDiff || 0) / 100) * 100;
      const key = `${bucketName}_${t.type}_${strikeDiff}`;
      if (!groups[key]) groups[key] = { bucketName, type: t.type, strike_diff: strikeDiff, trades: [] };
      groups[key].trades.push(t);
    });
    Object.values(groups).forEach(g => {
      const n = g.trades.length;
      const sumMargin = g.trades.reduce((s, t) => s + (t.margin || 0), 0);
      const sumFees = g.trades.reduce((s, t) => s + (t.totalFees || 0), 0);
      const sumPnl = g.trades.reduce((s, t) => s + (t.realizedNetPnl || 0), 0);
      const sumNP = g.trades.reduce((s, t) => s + ((t.sellQty || 0) * (t.entrySellPrice || 0) - (t.entryBuyPrice || 0)), 0);
      buckets[g.bucketName].push({
        type: g.type, strike_diff: g.strike_diff, trade_count: n,
        avg_margin: sumMargin / n, avg_fees: sumFees / n,
        avg_pnl: sumPnl / n, avg_net_premium: sumNP / n,
      });
    });
    Object.keys(buckets).forEach(b => buckets[b].sort((a, z) => a.strike_diff - z.strike_diff));
    return buckets;
  }, [uniqueTradeHistory, underlying]);

  // ─── Small helpers ────────────────────────────────────────────────────────────

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const getAnalyticsValue = (val, isTotal, count) =>
    isTotal ? Number((val || 0) * (count || 1)).toFixed(2)
      : Number(val || 0).toFixed(2);

  // Heartbeat freshness: treat as stale if updated_at is >60s ago
  const heartbeatAge = heartbeat
    ? Math.round((now - new Date(heartbeat.last_heartbeat).getTime()) / 1000)
    : null;
  const engineLive = heartbeat && heartbeatAge !== null && heartbeatAge < 60;
  const engineStatus = !heartbeat ? 'unknown'
    : engineLive ? (heartbeat.status || 'live')
      : 'stale';

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      {/* ── Navbar ──────────────────────────────────────────────────────────── */}
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="#0d1117" />
            <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
            <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
            <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
            <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
            <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
            <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
            <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
            <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
            <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
            <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
          </svg>
          VITTI OPTION<span>SCOPE</span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nav-tab" onClick={() => onNavigate('charts')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 20H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="7" y="12" width="3" height="6" rx="0.6" fill="currentColor" />
                <rect x="12" y="9" width="3" height="9" rx="0.6" fill="currentColor" />
                <rect x="17" y="6" width="3" height="12" rx="0.6" fill="currentColor" />
              </svg>
            </span> Charts
          </button>
          <button className="nav-tab" onClick={() => onNavigate('scanner')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> Ratio Spread
          </button>
          <button className="nav-tab" onClick={() => onNavigate('trading')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> Paper Trading
          </button>
          <button className="nav-tab active">
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </span> ATM Exit
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>

          {/* ── Server heartbeat badge ──────────────────────────────────────── */}
          <div
            className="ws-badge"
            title={
              !heartbeat
                ? 'No heartbeat data yet'
                : `Engine: ${heartbeat.status || 'unknown'} · WS: ${heartbeat.ws_status || '?'} · Updated ${heartbeatAge}s ago`
            }
          >
            <div
              className={`ws-dot ${engineStatus === 'live' ? 'live' : ''}`}
              style={engineStatus === 'stale' ? { background: '#e3b341' } : {}}
            />
            <span>
              {engineStatus === 'live' ? 'Engine Live'
                : engineStatus === 'stale' ? `Stale (${heartbeatAge}s)`
                  : 'Engine ?'}
            </span>
          </div>
        </div>
      </nav>

      <div className="body" style={{ flexDirection: 'column', overflowY: 'auto' }}>

        {/* ── Control Panel (config display + config writing, no trading toggle) ── */}
        <div className="pt-control-panel">
          <div className="pt-control-section" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span className="pt-control-label">Config</span>

            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Underlying:</label>
              <select value={underlying} onChange={e => updateConfig('underlying', e.target.value)} style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => updateConfig('expiry', e.target.value)} disabled={!expiries.length} style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
                {!expiries.length ? <option>Loading...</option> : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
              </select>
            </div>

            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }} />

            <span className="pt-control-label">Filters</span>
            {[
              { label: 'Min Strike Diff ($)', key: 'minStrikeDiff', width: 60, step: undefined },
              { label: 'Min IV Diff (%)', key: 'minIvDiff', width: 50, step: undefined },
              { label: 'Max Ratio Dev', key: 'maxRatioDeviation', width: 60, step: '0.01' },
              { label: 'Min Sell Prem ($)', key: 'minSellPremium', width: 60, step: undefined },
              { label: 'Max Debit ($)', key: 'maxNetPremium', width: 60, step: undefined },
              { label: 'Min Long Dist', key: 'minLongDist', width: 60, step: undefined },
              { label: 'Max Ratio (1:X)', key: 'maxSellQty', width: 65, step: '0.25' },
            ].map(({ label, key, width, step }) => (
              <div key={key} className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ marginBottom: 0 }}>{label}:</label>
                <input
                  type="number" step={step}
                  value={config[key] ?? ''}
                  onChange={e => updateConfig(key, Number(e.target.value))}
                  style={{ width, padding: '4px 8px', fontSize: '13px' }}
                />
              </div>
            ))}
          </div>

          {spotPrice && (
            <div className="pt-spot-display">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
            </div>
          )}

          {/* Engine status pill */}
          <div className={`pt-status-badge ${engineLive ? 'live' : ''}`}>
            {engineLive && <span className="pt-pulse" />}
            {engineStatus === 'live' ? 'SERVER ALGO LIVE'
              : engineStatus === 'stale' ? 'SERVER STALE'
                : 'SERVER UNKNOWN'}
          </div>

          <div style={{ flex: 1 }} />
        </div>

        {/* ── KPI Strip ───────────────────────────────────────────────────────── */}
        <div className="pt-kpi-strip">
          <div className={`pt-kpi-card ${todayPnl >= 0 ? 'accent-green' : 'accent-red'}`}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              Today's P&L
            </span>
            <span className={`pt-kpi-value ${todayPnl > 0 ? 'positive' : todayPnl < 0 ? 'negative' : 'neutral'}`}>
              {todayPnl > 0 ? '+' : ''}{todayPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Realized: {todayRealizedPnl.toFixed(2)} | Unrl: {totalUnrealizedPnl.toFixed(2)}</span>
          </div>

          <div className={`pt-kpi-card ${totalPnl >= 0 ? 'accent-blue' : 'accent-red'}`} style={{ borderLeft: '4px solid var(--accent)' }}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              All-Time P&L
            </span>
            <span className={`pt-kpi-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral'}`}>
              {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Total Realized: {totalRealizedPnl.toFixed(2)}</span>
          </div>

          <div className="pt-kpi-card accent-gold">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 12l3 3 5-5" /></svg>
              Win Rate
            </span>
            <span className="pt-kpi-value neutral">{winRate}{winRate !== '—' ? '%' : ''}</span>
            <span className="pt-kpi-sub">{wins}W / {uniqueTradeHistory.length - wins}L of {uniqueTradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.filter(p => p.underlying === underlying).length}</span>
            <span className="pt-kpi-sub">
              {positions.filter(p => p.type === 'call' && p.underlying === underlying).length} calls /&nbsp;
              {positions.filter(p => p.type === 'put' && p.underlying === underlying).length} puts
            </span>
          </div>

          <div className="pt-kpi-card accent-purple">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
              Trades
            </span>
            <span className="pt-kpi-value neutral">{uniqueTradeHistory.length}</span>
            <span className="pt-kpi-sub">Closed positions</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
              Margin Used
            </span>
            <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
            <span className="pt-kpi-sub">
              Across {positions.filter(p => p.underlying === underlying).length} position
              {positions.filter(p => p.underlying === underlying).length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── Active Positions ─────────────────────────────────────────────── */}
          <div className={`pt-section ${engineLive ? 'live' : ''}`}>
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions ({underlying})
                <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {/* Heartbeat last-updated stamp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {heartbeat && (
                    <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
                      Engine updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(heartbeat.last_heartbeat))}
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      fetchActivePositions();
                      fetchTradeHistory();
                      fetchAnalytics();
                      fetchHeartbeat();
                    }}
                    title="Refresh now"
                    style={{
                      padding: '4px 8px', fontSize: 12, background: 'var(--bg-card)',
                      border: '1px solid var(--border)', color: 'var(--text)',
                      borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      minWidth: '50px', justifyContent: 'center'
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" />
                    </svg>
                    {heartbeat ? `${Math.max(0, 30 - heartbeatAge)}s` : ''}
                  </button>
                </div>

                <div className="pt-fee-toggle-container">
                  <span className={`pt-fee-toggle-label ${!includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(false)}>Gross</span>
                  <label className="pt-switch">
                    <input type="checkbox" checked={includeFees} onChange={e => setIncludeFees(e.target.checked)} />
                    <span className="pt-slider"></span>
                  </label>
                  <span className={`pt-fee-toggle-label ${includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(true)}>Net</span>
                </div>

                <div style={{ fontSize: 14, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  Spot: {spotPrice ? `$${spotPrice.toLocaleString()}` : '—'}
                </div>

                {engineLive && (
                  <div className="pt-live-badge">
                    <div className="pt-live-dot" />
                    Monitoring
                  </div>
                )}
              </div>
            </div>

            {positions.filter(p => p.underlying === underlying).length === 0 ? (
              <div className="pt-empty">
                <div className={`pt-empty-icon ${engineLive ? 'scanning' : 'idle'}`}>
                  {engineLive ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0ecb81" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4">
                        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" />
                      </path>
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />
                    </svg>
                  )}
                </div>
                <span className="pt-empty-title">{engineLive ? 'No Open Positions' : 'Engine Offline'}</span>
                <span className="pt-empty-desc">
                  {engineLive
                    ? 'The server engine is running — positions will appear when entries are taken.'
                    : 'The server algo engine is not reporting a heartbeat.'}
                </span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type / Ratio</th>
                    <th>Expiry</th>
                    <th>Buy / Sell Strike</th>
                    <th>Entry Spot</th>
                    <th>In (Buy / Sell)</th>
                    <th>Unrl P&L</th>
                    <th>Margin</th>
                    <th>Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.filter(p => p.underlying === underlying).map(p => {
                      const pnlValue = (includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) || 0;
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {p.buyLeg.lotSize.toFixed(2)}:{p.sellQty.toFixed(2)}
                              </span>
                            </div>
                          </td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(p.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{p.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>
                              {p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{p.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <span className={`pt-pnl ${pnlClass}`}>
                              {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                            </span>
                          </td>
                          <td>
                            <div className="pt-margin-cell">
                              <span>${(p.margin || 0).toFixed(0)}</span>
                              <div className="pt-margin-bar">
                                <div className="pt-margin-fill" style={{ width: `${Math.min(100, (p.margin / (totalMargin || 1)) * 100)}%` }} />
                              </div>
                            </div>
                          </td>
                          <td><span className="pt-duration">{fmtDuration(Date.now() - p.entryTime)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Trade History ─────────────────────────────────────────────────── */}
          <div className="pt-section">
            <div className="pt-section-header" style={{
              flexDirection: 'column', alignItems: 'stretch', gap: '16px',
              padding: '16px 20px', borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', width: '100%', position: 'relative', minHeight: '36px' }}>
                {/* Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Trade History</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
                  </div>
                  <span style={{ background: 'var(--bg3)', color: 'var(--accent)', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, border: '1px solid rgba(240, 185, 11, 0.2)' }}>
                    {filteredTradeHistory.length}
                  </span>
                </div>

                {/* Centered date filter */}
                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--bg3)', padding: '4px 8px', borderRadius: '12px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                  <button onClick={() => adjustFilterDay(-1)} title="Previous Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px' }}>
                    <input type="date" value={historyFilterDate} onChange={e => setHistoryFilterDate(e.target.value)} style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '125px', outline: 'none', cursor: 'pointer' }} />
                  </div>
                  <button onClick={() => adjustFilterDay(1)} title="Next Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </button>
                  <button onClick={resetToToday} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '4px 12px', fontSize: '11px', color: 'var(--text)', fontWeight: 700, cursor: 'pointer', marginLeft: '4px' }}>TODAY</button>
                </div>
              </div>
            </div>

            {filteredTradeHistory.length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon idle">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                </div>
                <span className="pt-empty-title">No Closed Trades</span>
                <span className="pt-empty-desc">Trades will appear here once positions are exited for the selected day.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Entry Time</th>
                    <th>Exit Time</th>
                    <th>Duration</th>
                    <th>Expiry</th>
                    <th>Type / Ratio</th>
                    <th>Buy / Sell Strike</th>
                    <th>Spot (In / Out)</th>
                    <th>In (Buy / Sell)</th>
                    <th>Out (Buy / Sell)</th>
                    <th>Realized P&L</th>
                    <th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {filteredTradeHistory.map((t, i) => {
                      const pnlValue = (includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0;
                      const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;
                      return (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.entryTime)}</td>
                          <td style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.exitTime)}</td>
                          <td><span className="pt-duration" style={{ fontSize: '11px' }}>{fmtDuration(durationMs)}</span></td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(t.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${t.type}`}>{t.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {t.buyLeg?.lotSize?.toFixed(2)}:{t.sellQty?.toFixed(2)}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{t.buyLeg?.strike?.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{t.sellLeg?.strike?.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                              <span style={{ color: 'var(--text-dim)' }}>{t.entrySpotPrice?.toLocaleString() ?? '—'}</span>
                              <span style={{ color: 'var(--text-dim)', opacity: 0.8 }}>{t.exitSpotPrice?.toLocaleString() ?? '—'}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{t.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.exitBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{t.exitSellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                              <span className={`pt-pnl ${pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero'}`}>
                                {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${t.margin?.toFixed(0)}</span>
                            </div>
                          </td>
                          <td><span className="pt-exit-badge position">{t.exitReason}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Analytics Panel ───────────────────────────────────────────────── */}
          <div className="pt-section">
            <div className="pt-section-header" style={{ borderBottom: '1px solid var(--border)', padding: '16px 20px', background: 'var(--bg2)' }}>
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></svg>
                Analytics Engine
              </div>
              <div className="pt-fee-toggle-container">
                <span className={`pt-fee-toggle-label ${!showTotalMode ? 'active' : ''}`} onClick={() => setShowTotalMode(false)}>Average</span>
                <label className="pt-switch">
                  <input type="checkbox" checked={showTotalMode} onChange={() => setShowTotalMode(v => !v)} />
                  <span className="pt-slider"></span>
                </label>
                <span className={`pt-fee-toggle-label ${showTotalMode ? 'active' : ''}`} onClick={() => setShowTotalMode(true)}>Total</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px', padding: '20px' }}>
              {Object.entries({
                'atm_exit_qty_0_2_5': '<= 2.5',
                'atm_exit_qty_2_5_5': '2.5 to 5',
                'atm_exit_qty_5_7_5': '5 to 7.5',
                'atm_exit_qty_7_5_10': '7.5 to 10',
              }).map(([tableName, label]) => (
                <div key={tableName} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ background: 'var(--bg3)', padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                    Sell Qty: {label}
                  </div>
                  <div className="pt-table-scroll" style={{ maxHeight: '400px' }}>
                    <table className="pt-table">
                      <thead><tr>
                        <th>Strike Diff</th>
                        <th>Trades</th>
                        <th>Avg Margin</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} Prem</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} Fees</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} PnL</th>
                      </tr></thead>
                      <tbody>
                        {(calculatedAnalyticsData[tableName] || []).map(row => {
                          const np = row.avg_net_premium || 0;
                          const isCredit = np >= 0;
                          const pnlMV = getAnalyticsValue(row.avg_pnl, showTotalMode, row.trade_count);
                          const feesMV = getAnalyticsValue(row.avg_fees, showTotalMode, row.trade_count);
                          const npMV = getAnalyticsValue(Math.abs(np), showTotalMode, row.trade_count);
                          return (
                            <tr key={`${row.type}-${row.strike_diff}`}>
                              <td>
                                <span className={`pt-type-badge ${row.type}`} style={{ padding: '2px 6px', fontSize: '9px' }}>{row.type.toUpperCase()}</span>{' '}{row.strike_diff}
                              </td>
                              <td style={{ fontWeight: 600 }}>{row.trade_count}</td>
                              <td>${Number(row.avg_margin || 0).toFixed(0)}</td>
                              <td><span className={`pt-pnl ${isCredit ? 'positive' : 'negative'}`}>${npMV} {isCredit ? 'Credit' : 'Debit'}</span></td>
                              <td style={{ color: '#f85149' }}>${feesMV}</td>
                              <td><span className={`pt-pnl ${Number(pnlMV) >= 0 ? 'positive' : 'negative'}`}>${pnlMV}</span></td>
                            </tr>
                          );
                        })}
                        {!(calculatedAnalyticsData[tableName]?.length) && (
                          <tr><td colSpan="6" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-dim)' }}>No data available</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}