import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, Activity } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import { exportCsv, exportXlsx } from './exportTable';
import { loadProducts, getExpiries, fetchCandles } from './api';
import { impliedVol, yearsToExpiry } from './ivUtils';

// IV Analysis — ATM strike (X) vs ATM IV (Y), one point per minute, computed in the browser
// from Delta's PUBLIC candles (no database, no engine): the spot index's 1m candles give each
// minute's ATM strike, and that strike's call / put 1m MARK candles are inverted with
// Black-Scholes into IV (ivUtils.js). The table below lists every minute and what changed.

const HOUR = 60 * 60 * 1000;
const RANGES = [
  { key: '1h', label: '1H', ms: HOUR },
  { key: '6h', label: '6H', ms: 6 * HOUR },
  { key: '24h', label: '24H', ms: 24 * HOUR },
  { key: '3d', label: '3D', ms: 72 * HOUR },
  { key: '7d', label: '7D', ms: 168 * HOUR },
];
const SERIES = [
  { key: 'atm_iv', label: 'Avg' },
  { key: 'call_iv', label: 'Call' },
  { key: 'put_iv', label: 'Put' },
];
const CHUNK_MIN = 3000;      // minutes per candle request (Delta returns up to ~4,000)
const CONCURRENCY = 4;       // parallel candle requests
const SPOT_INDEX = { BTC: '.DEXBTUSD', ETH: '.DEETHUSD' };
const UNDERLYINGS = ['BTC', 'ETH'];
const TABLE_LIMIT = 500;     // rows rendered in the table (export has all)
const REFRESH_MS = 60_000;
const GAP_MS = 3 * 60_000;   // a hole longer than this breaks the line

const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const fmtIv = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);
const fmtD = (v, digits = 2, suffix = '') => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}${suffix}`);
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const tone = (v) => (v == null || Math.abs(v) < 1e-9 ? '' : v > 0 ? 'positive' : 'negative');
const fmtIst = (ts) => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const fmtExpiry = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

const EXPORT_COLUMNS = [
  { key: 'time', label: 'Time (IST)' },
  { key: 'ts', label: 'Timestamp (UTC)' },
  { key: 'spot', label: 'Spot' },
  { key: 'atmStrike', label: 'ATM Strike' },
  { key: 'callIv', label: 'Call IV %' },
  { key: 'putIv', label: 'Put IV %' },
  { key: 'atmIv', label: 'ATM IV % (avg)' },
  { key: 'dIv', label: 'Δ IV (1m)' },
  { key: 'dSpot', label: 'Δ Spot (1m)' },
  { key: 'strikeMove', label: 'ATM Strike Change' },
];

// ── Chart ────────────────────────────────────────────────────────────────────
function IvChart({ points, seriesKey }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 380;
  const M = { l: 56, r: 16, t: 16, b: 40 };
  const pts = useMemo(() => points.filter(p => p[seriesKey] != null), [points, seriesKey]);

  const geo = useMemo(() => {
    if (pts.length === 0) return null;
    const strikes = [...new Set(pts.map(p => p.atmStrike))].sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < strikes.length; i++) step = Math.min(step, strikes[i] - strikes[i - 1]);
    if (!Number.isFinite(step)) step = Math.max(1, strikes[0] * 0.005);
    const x0 = strikes[0] - step / 2;
    const x1 = strikes[strikes.length - 1] + step / 2;
    const ivs = pts.map(p => p[seriesKey]);
    let y0 = Math.min(...ivs), y1 = Math.max(...ivs);
    const pad = Math.max(0.25, (y1 - y0) * 0.1);
    y0 -= pad; y1 += pad;
    const iw = width - M.l - M.r;
    const ih = H - M.t - M.b;
    const sx = (v) => M.l + ((v - x0) / (x1 - x0)) * iw;
    const sy = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * ih;
    // X ticks: every strike when they fit, else every n-th.
    const maxTicks = Math.max(2, Math.floor(iw / 70));
    const every = Math.max(1, Math.ceil(strikes.length / maxTicks));
    const xTicks = strikes.filter((_, i) => i % every === 0);
    const yTicks = Array.from({ length: 6 }, (_, i) => y0 + ((y1 - y0) * i) / 5);
    // Line segments in time order, broken at data gaps.
    const segs = [];
    let cur = [];
    pts.forEach((p, i) => {
      if (i > 0 && p.t - pts[i - 1].t > GAP_MS) { if (cur.length > 1) segs.push(cur); cur = []; }
      cur.push(`${sx(p.atmStrike).toFixed(1)},${sy(p[seriesKey]).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push(cur);
    return { sx, sy, xTicks, yTicks, segs, t0: pts[0].t, t1: pts[pts.length - 1].t, iw, ih };
  }, [pts, seriesKey, width, M.l, M.r, M.t, M.b]);

  if (!geo) return <div ref={wrapRef} className="pt-empty"><span className="pt-empty-title">No data for this selection yet</span></div>;

  const { sx, sy, xTicks, yTicks, segs, t0, t1 } = geo;
  const age = (t) => (t1 > t0 ? (t - t0) / (t1 - t0) : 1); // 0 = oldest, 1 = latest
  const last = pts[pts.length - 1];

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * width;
    const my = ((e.clientY - r.top) / r.height) * H;
    let best = null, bd = Infinity;
    for (const p of pts) {
      const d = (sx(p.atmStrike) - mx) ** 2 + (sy(p[seriesKey]) - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    setHover(bd < 30 ** 2 ? best : null);
  };

  return (
    <div ref={wrapRef} className="iv-chart-wrap">
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label="ATM strike versus ATM implied volatility, one point per minute">
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line x1={M.l} x2={width - M.r} y1={sy(v)} y2={sy(v)} className="iv-grid" />
            <text x={M.l - 8} y={sy(v)} className="iv-tick" textAnchor="end" dominantBaseline="middle">{v.toFixed(1)}%</text>
          </g>
        ))}
        {xTicks.map(k => (
          <g key={`x${k}`}>
            <line x1={sx(k)} x2={sx(k)} y1={M.t} y2={H - M.b} className="iv-grid" />
            <text x={sx(k)} y={H - M.b + 16} className="iv-tick" textAnchor="middle">{k.toLocaleString()}</text>
          </g>
        ))}
        <text x={M.l + geo.iw / 2} y={H - 4} className="iv-axis-label" textAnchor="middle">ATM strike</text>
        <text x={12} y={M.t + geo.ih / 2} className="iv-axis-label" textAnchor="middle" transform={`rotate(-90 12 ${M.t + geo.ih / 2})`}>IV %</text>
        {segs.map((s, i) => <polyline key={i} points={s.join(' ')} className="iv-line" />)}
        {pts.map(p => (
          <circle key={p.t} cx={sx(p.atmStrike)} cy={sy(p[seriesKey])} r={3}
            className="iv-dot" style={{ opacity: 0.2 + 0.8 * age(p.t) }} />
        ))}
        <circle cx={sx(last.atmStrike)} cy={sy(last[seriesKey])} r={7} className="iv-latest" />
        {hover && <circle cx={sx(hover.atmStrike)} cy={sy(hover[seriesKey])} r={6} className="iv-hover" />}
      </svg>
      {hover && (
        <div className="iv-tip" style={{
          left: Math.min(sx(hover.atmStrike) + 12, width - 210),
          top: Math.max(4, sy(hover[seriesKey]) - 80),
        }}>
          <strong>{fmtIst(hover.t)} IST</strong>
          <span>ATM {hover.atmStrike.toLocaleString()} · spot {fmtNum(hover.spot)}</span>
          <span>IV {fmtIv(hover[seriesKey])} <em className={tone(hover.dIv)}>({fmtD(hover.dIv)} vs prev min)</em></span>
          <span>Call {fmtIv(hover.callIv)} · Put {fmtIv(hover.putIv)}</span>
        </div>
      )}
      <div className="iv-legend">
        <span><i className="iv-dot-key" /> one minute (faded = older)</span>
        <span><i className="iv-latest-key" /> latest</span>
        <span>Line joins the minutes in time order</span>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function IvAnalysis({ onNavigate, theme, toggleTheme, active }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [products, setProducts] = useState({ underlying: '', list: [], expiries: [] });
  const [pickedExpiry, setExpiry] = useState('');
  const [rangeKey, setRangeKey] = useState('6h');
  const [seriesKey, setSeriesKey] = useState('atm_iv');
  const [result, setResult] = useState({ key: '', rows: [] });
  const [progress, setProgress] = useState(null); // { done, total } while loading
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Live option products of the underlying (expiries, strikes, symbols, spot index).
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    loadProducts(underlying)
      .then(list => {
        if (cancelled) return;
        const l = list || [];
        // Unsettled expiries only (Delta can still list a just-settled one for a moment).
        const now = Date.now();
        setProducts({ underlying, list: l, expiries: getExpiries(l).filter(e => new Date(e).getTime() > now) });
      })
      .catch(e => { if (!cancelled) setError(`Couldn't load ${underlying} options from Delta: ${e.message}`); });
    return () => { cancelled = true; };
  }, [active, underlying, reloadToken]);

  const current = products.underlying === underlying;
  const list = useMemo(() => (current ? products.list : []), [current, products]);
  const expiries = useMemo(() => (current ? products.expiries : []), [current, products]);
  const expiry = expiries.includes(pickedExpiry) ? pickedExpiry : (expiries[0] ?? '');
  const spotSymbol = list.find(p => p.spot_index?.symbol)?.spot_index.symbol ?? SPOT_INDEX[underlying];
  // strike → { call, put } symbols of the selected expiry, strikes ascending.
  const chain = useMemo(() => {
    const m = new Map();
    for (const p of list) {
      if (p.settlement_time !== expiry) continue;
      const k = Number(p.strike_price);
      if (!m.has(k)) m.set(k, {});
      m.get(k)[p.contract_type === 'call_options' ? 'call' : 'put'] = p.symbol;
    }
    return { strikes: [...m.keys()].sort((a, b) => a - b), legs: m };
  }, [list, expiry]);
  const selKey = `${underlying}|${expiry}|${rangeKey}|${reloadToken}`;

  // Build the per-minute rows straight from Delta's public candles — no database:
  //   spot = 1m candles of the spot index; ATM = listed strike nearest that minute's spot;
  //   call / put IV = Black-Scholes inversion of their 1m MARK candles (ivUtils.js).
  // A minute whose nearest strike has no mark candle (strike listed later) falls back to the
  // next-nearest strike. First run loads the whole range; then every minute only the new
  // minutes are fetched (candle caches + coverage per symbol live in this effect).
  useEffect(() => {
    if (!active || !expiry || chain.strikes.length === 0 || !spotSymbol) return undefined;
    let cancelled = false;
    const rangeMs = RANGES.find(r => r.key === rangeKey).ms;
    const series = new Map();   // symbol → Map(minuteSec → close)
    const covered = new Map();  // symbol → { from, to } seconds already fetched
    const ivMemo = new Map();   // `${symbol}|${minuteSec}` → IV %

    const fetchInto = async (symbol, from, to, mark) => {
      const m = series.get(symbol) ?? new Map();
      series.set(symbol, m);
      for (let s = from; s < to; s += CHUNK_MIN * 60) {
        const candles = await fetchCandles(symbol, '1m', s, Math.min(to, s + CHUNK_MIN * 60), mark ? 'mark' : 'last');
        for (const c of candles) if (c.close > 0) m.set(c.time, c.close);
      }
    };
    // Fetch only what this symbol is missing in [from, to], re-reading the last few minutes
    // (their candle may still have been forming). A re-read close also clears its IV memo.
    const ensure = async (symbol, from, to, mark) => {
      const cov = covered.get(symbol);
      if (!cov) await fetchInto(symbol, from, to, mark);
      else {
        if (from < cov.from) await fetchInto(symbol, from, cov.from, mark);
        if (to > cov.to - 180) {
          const reFrom = Math.max(from, cov.to - 180);
          for (const k of ivMemo.keys()) if (k.startsWith(`${symbol}|`) && Number(k.split('|')[1]) >= reFrom) ivMemo.delete(k);
          await fetchInto(symbol, reFrom, to, mark);
        }
      }
      covered.set(symbol, { from: Math.min(from, cov?.from ?? from), to: Math.max(to, cov?.to ?? to) });
    };
    const pool = async (tasks, onDone) => {
      let i = 0;
      const worker = async () => { while (i < tasks.length && !cancelled) { const t = tasks[i++]; await t(); onDone(); } };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    };
    const nearest = (spot) => [...chain.strikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    const iv = (symbol, t, spot, strike, isCall) => {
      const key = `${symbol}|${t}`;
      if (ivMemo.has(key)) return ivMemo.get(key);
      const px = series.get(symbol)?.get(t);
      if (px == null) return null;
      // Candle close = the end of the minute → time to expiry from t + 60s.
      const v = impliedVol(px, spot, strike, yearsToExpiry(expiry, (t + 60) * 1000), isCall);
      ivMemo.set(key, v);
      return v;
    };

    const run = async (first) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const from = Math.floor((Date.now() - rangeMs) / 60000) * 60;
        // Never ask past settlement.
        const to = Math.min(now, Math.floor(new Date(expiry).getTime() / 1000));
        if (first) setProgress({ done: 0, total: 1 });
        await ensure(spotSymbol, from, to, false);
        if (cancelled) return;
        const spot = series.get(spotSymbol);
        const minutes = [...spot.keys()].filter(t => t >= from).sort((a, b) => a - b);
        const legsOf = (k) => chain.legs.get(k) || {};
        // Pass 1: nearest strike of every minute; pass 2: next-nearest where pass 1 has no marks.
        const pick = minutes.map(t => ({ t, ranked: nearest(spot.get(t)).slice(0, 2) }));
        const need = new Set(pick.map(p => p.ranked[0]));
        const tasksFor = (strikes) => [...strikes]
          .flatMap(k => [legsOf(k).call, legsOf(k).put].filter(Boolean))
          .map(sym => () => ensure(sym, from, to, true));
        const tasks = tasksFor(need);
        let done = 0;
        if (first) setProgress({ done: 1, total: 1 + tasks.length });
        await pool(tasks, () => { done++; if (first && !cancelled) setProgress({ done: 1 + done, total: 1 + tasks.length }); });
        if (cancelled) return;
        const has = (k, t) => { const l = legsOf(k); return !!(series.get(l.call)?.has(t) || series.get(l.put)?.has(t)); };
        const fallback = [...new Set(pick.filter(p => !has(p.ranked[0], p.t) && p.ranked[1] != null).map(p => p.ranked[1]))]
          .filter(k => !need.has(k));
        await pool(tasksFor(fallback), () => {});
        if (cancelled) return;

        const rows = [];
        for (const { t, ranked } of pick) {
          const k = ranked.find(s => has(s, t));
          if (k == null) continue;
          const s = spot.get(t);
          const l = legsOf(k);
          const callIv = l.call ? iv(l.call, t, s, k, true) : null;
          const putIv = l.put ? iv(l.put, t, s, k, false) : null;
          const ivs = [callIv, putIv].filter(v => v != null);
          if (!ivs.length) continue;
          rows.push({
            ts: new Date(t * 1000).toISOString(), spot: s, atm_strike: k,
            call_iv: callIv, put_iv: putIv, atm_iv: ivs.reduce((a, b) => a + b, 0) / ivs.length,
          });
        }
        setResult({ key: selKey, rows });
        setError('');
        setLoadedAt(Date.now());
      } catch (e) {
        if (!cancelled) setError(`Couldn't load IV data from Delta: ${e.message}`);
      } finally {
        if (!cancelled && first) setProgress(null);
      }
    };
    run(true);
    const timer = setInterval(() => run(false), REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, expiry, chain, spotSymbol, rangeKey, selKey]);

  const load = () => setReloadToken(n => n + 1);
  const loading = progress != null;

  // Rows of the CURRENT selection only (a switch shows nothing until its rows arrive).
  const raw = useMemo(() => (result.key === selKey ? result.rows : []), [result, selKey]);
  const pending = result.key !== selKey;

  // Per-minute points with the change vs the previous minute.
  const points = useMemo(() => raw.map((r, i) => {
    const prev = i > 0 ? raw[i - 1] : null;
    const p = {
      t: new Date(r.ts).getTime(),
      ts: r.ts,
      spot: num(r.spot),
      atmStrike: num(r.atm_strike),
      callIv: num(r.call_iv),
      putIv: num(r.put_iv),
      atm_iv: num(r.atm_iv),
    };
    p.call_iv = p.callIv;
    p.put_iv = p.putIv;
    const prevIv = prev ? num(prev[seriesKey]) : null;
    p.dIv = p[seriesKey] != null && prevIv != null ? p[seriesKey] - prevIv : null;
    p.dSpot = prev && p.spot != null && num(prev.spot) != null ? p.spot - num(prev.spot) : null;
    p.strikeMove = prev && num(prev.atm_strike) != null && p.atmStrike !== num(prev.atm_strike) ? p.atmStrike - num(prev.atm_strike) : 0;
    return p;
  }).filter(p => p.atmStrike != null), [raw, seriesKey]);

  const stats = useMemo(() => {
    const s = points.filter(p => p[seriesKey] != null);
    if (!s.length) return null;
    const last = s[s.length - 1];
    const ago = (ms) => {
      const target = last.t - ms;
      for (let i = s.length - 1; i >= 0; i--) if (s[i].t <= target) return last[seriesKey] - s[i][seriesKey];
      return null;
    };
    const ivs = s.map(p => p[seriesKey]);
    return {
      last,
      d1: last.dIv,
      d15: ago(15 * 60_000),
      d60: ago(HOUR),
      min: Math.min(...ivs),
      max: Math.max(...ivs),
      strikeChanges: s.filter(p => p.strikeMove !== 0).length,
      strikes: new Set(s.map(p => p.atmStrike)).size,
    };
  }, [points, seriesKey]);

  const tableRows = useMemo(() => [...points].reverse(), [points]);
  const exportRows = () => tableRows.map(p => ({
    time: fmtIst(p.t), ts: p.ts, spot: p.spot, atmStrike: p.atmStrike, callIv: p.callIv, putIv: p.putIv, atmIv: p.atm_iv,
    dIv: p.dIv != null ? Number(p.dIv.toFixed(4)) : null, dSpot: p.dSpot != null ? Number(p.dSpot.toFixed(2)) : null, strikeMove: p.strikeMove || null,
  }));
  const fileBase = `atm-iv_${underlying}_${expiry.slice(0, 10)}_${rangeKey}`;
  const seriesLabel = SERIES.find(s => s.key === seriesKey).label;

  return (
    <div className="app">
      <Navbar activeTab="iv" onNavigate={onNavigate} theme={theme} toggleTheme={toggleTheme}
        badgeLabel={loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'IV Analysis'} />

      <div className="body dr-body">
        <>
            <div className="dr-toolbar">
              <span className="dr-title"><Activity size={15} /> ATM Strike vs IV</span>
              <div className="dr-filters">
                <div className="dr-field">
                  <span>Underlying</span>
                  <div className="dr-seg" role="group" aria-label="Underlying">
                    {UNDERLYINGS.map(u => (
                      <button key={u} type="button" className={underlying === u ? 'on' : ''} aria-pressed={underlying === u}
                        onClick={() => setUnderlying(u)}>{u}</button>
                    ))}
                  </div>
                </div>
                <label className="dr-field">
                  <span>Expiry (IST)</span>
                  <select className="dr-date" value={expiry} onChange={e => setExpiry(e.target.value)} disabled={!expiries.length}>
                    {expiries.length === 0 && <option value="">Loading…</option>}
                    {expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
                  </select>
                </label>
                <div className="dr-field">
                  <span>Range</span>
                  <div className="dr-seg" role="group" aria-label="Time range">
                    {RANGES.map(r => (
                      <button key={r.key} type="button" className={rangeKey === r.key ? 'on' : ''} aria-pressed={rangeKey === r.key}
                        onClick={() => setRangeKey(r.key)}>{r.label}</button>
                    ))}
                  </div>
                </div>
                <div className="dr-field">
                  <span>IV</span>
                  <div className="dr-seg" role="group" aria-label="IV series">
                    {SERIES.map(s => (
                      <button key={s.key} type="button" className={seriesKey === s.key ? 'on' : ''} aria-pressed={seriesKey === s.key}
                        onClick={() => setSeriesKey(s.key)}>{s.label}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="dr-actions">
                <button type="button" className="dr-btn" onClick={load} disabled={loading} title="Refresh">
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
                </button>
                <button type="button" className="dr-btn" disabled={!points.length}
                  onClick={() => exportCsv(EXPORT_COLUMNS, exportRows(), `${fileBase}.csv`)}>
                  <Download size={13} /> CSV
                </button>
                <button type="button" className="dr-btn primary" disabled={!points.length}
                  onClick={() => exportXlsx(EXPORT_COLUMNS, exportRows(), `${fileBase}.xlsx`, 'ATM IV')}>
                  <FileSpreadsheet size={13} /> Excel
                </button>
              </div>
            </div>

            {error && <div className="dr-error">{error}</div>}
            {progress && (
              <div className="iv-progress">
                Loading from Delta… {progress.done}/{progress.total} candle series
              </div>
            )}

            {stats && (
              <div className="dr-tiles">
                <div className="dr-tile">
                  <span>Latest {seriesLabel} IV</span>
                  <strong>{fmtIv(stats.last[seriesKey])}</strong>
                  <em>ATM {stats.last.atmStrike.toLocaleString()} · spot {fmtNum(stats.last.spot)} · {fmtIst(stats.last.t)}</em>
                </div>
                <div className="dr-tile"><span>Δ 1 min</span><strong className={tone(stats.d1)}>{fmtD(stats.d1)}</strong><em>IV points</em></div>
                <div className="dr-tile"><span>Δ 15 min</span><strong className={tone(stats.d15)}>{fmtD(stats.d15)}</strong><em>IV points</em></div>
                <div className="dr-tile"><span>Δ 1 hour</span><strong className={tone(stats.d60)}>{fmtD(stats.d60)}</strong><em>IV points</em></div>
                <div className="dr-tile"><span>IV range</span><strong>{stats.min.toFixed(2)}–{stats.max.toFixed(2)}%</strong><em>in the selected range</em></div>
                <div className="dr-tile"><span>ATM strike moves</span><strong>{stats.strikeChanges}</strong><em>{stats.strikes} distinct strike{stats.strikes === 1 ? '' : 's'}</em></div>
              </div>
            )}

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">ATM strike vs {seriesLabel} IV</span>
                <span className="dr-card-sub">One point per minute · hover a point for details</span>
              </div>
              <IvChart points={points} seriesKey={seriesKey} />
            </div>

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">Minute by minute</span>
                <span className="dr-card-sub">Newest first{tableRows.length > TABLE_LIMIT ? ` · showing ${TABLE_LIMIT} of ${tableRows.length} (export has all)` : ''}</span>
              </div>
              {tableRows.length === 0 ? (
                <div className="pt-empty"><span className="pt-empty-title">{loading || (pending && expiry) || !expiry ? 'Loading…' : 'No data in this range'}</span></div>
              ) : (
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table">
                    <thead>
                      <tr>
                        <th>Time (IST)</th>
                        <th className="r">Spot</th>
                        <th className="r">Δ Spot</th>
                        <th className="r">ATM Strike</th>
                        <th className="r">Call IV</th>
                        <th className="r">Put IV</th>
                        <th className="r">Avg IV</th>
                        <th className="r">Δ {seriesLabel} IV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.slice(0, TABLE_LIMIT).map(p => (
                        <tr key={p.t} className={p.strikeMove ? 'iv-strike-moved' : undefined}>
                          <td>{fmtIst(p.t)}</td>
                          <td className="r">{fmtNum(p.spot)}</td>
                          <td className="r"><span className={tone(p.dSpot)}>{fmtD(p.dSpot, 1)}</span></td>
                          <td className="r">
                            {p.atmStrike.toLocaleString()}
                            {p.strikeMove !== 0 && <span className={`iv-move ${tone(p.strikeMove)}`}> {p.strikeMove > 0 ? '▲' : '▼'}</span>}
                          </td>
                          <td className="r">{fmtIv(p.callIv)}</td>
                          <td className="r">{fmtIv(p.putIv)}</td>
                          <td className="r">{fmtIv(p.atm_iv)}</td>
                          <td className="r"><span className={tone(p.dIv)}>{fmtD(p.dIv)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <details className="dr-note">
              <summary>How this is calculated</summary>
              <p>
                Everything comes from Delta's public candles, loaded in your browser — nothing is stored. For each minute: spot =
                the close of the spot index's 1-minute candle ({spotSymbol || 'spot index'}); ATM strike = the listed strike of this
                expiry nearest that spot (the next-nearest if that strike has no candle yet); call / put IV = the IV that makes
                Black-Scholes (r = 0) equal that strike's 1-minute MARK price close. Delta builds its mark price from its mark IV,
                so this matches Delta's own mark IV to within about 0.05 points. Avg = the mean of the call and put IV.
              </p>
              <p>
                An option only has candles since it was listed (daily expiries are listed about 1–2 days ahead), so a long range
                on a near expiry starts where its options start. Minutes Delta has no candle for are skipped (the line breaks there).
              </p>
            </details>
          </>
      </div>
    </div>
  );
}
