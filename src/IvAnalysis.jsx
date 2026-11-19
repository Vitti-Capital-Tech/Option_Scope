import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, Activity } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import { exportCsv, exportXlsx } from './exportTable';
import { loadProducts, getExpiries, fetchCandles } from './api';
import { impliedVol, yearsToExpiry } from './ivUtils';
import { supabase } from './supabase';

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

const SAVED_DAYS = 21;
const SAVED_COLUMNS = [
  { key: 'time', label: 'Time (IST)' },
  { key: 'ts', label: 'Timestamp (UTC)' },
  { key: 'expiry', label: 'Expiry (IST)' },
  { key: 'expiry_rank', label: 'Expiry' },
  { key: 'hours_to_expiry', label: 'Hours to Expiry' },
  { key: 'spot', label: 'Spot' },
  { key: 'atm_strike', label: 'ATM Strike' },
  { key: 'call_iv', label: 'Call IV %' },
  { key: 'put_iv', label: 'Put IV %' },
  { key: 'atm_iv', label: 'ATM IV % (avg)' },
  { key: 'call_mark', label: 'Call Mark' },
  { key: 'put_mark', label: 'Put Mark' },
];

// ── Charts ───────────────────────────────────────────────────────────────────
// Width of a chart container, tracked with ResizeObserver.
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const fmtTick = (t, multiDay) => new Date(t).toLocaleString('en-GB', {
  ...(multiDay ? { day: '2-digit', month: 'short' } : {}),
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});
const linTicks = (lo, hi, n) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);

// 1) IV over time (left axis) with the ATM strike as a step line (right axis).
function IvTimeChart({ points, seriesKey }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 340;
  const M = { l: 56, r: 64, t: 14, b: 34 };
  const pts = useMemo(() => points.filter(p => p[seriesKey] != null), [points, seriesKey]);

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const ivs = pts.map(p => p[seriesKey]);
    let y0 = Math.min(...ivs), y1 = Math.max(...ivs);
    const pad = Math.max(0.2, (y1 - y0) * 0.08);
    y0 -= pad; y1 += pad;
    const ks = pts.map(p => p.atmStrike);
    let k0 = Math.min(...ks), k1 = Math.max(...ks);
    const kpad = Math.max(1, (k1 - k0) * 0.15 || k0 * 0.002);
    k0 -= kpad; k1 += kpad;
    const iw = width - M.l - M.r, ih = H - M.t - M.b;
    const sx = (t) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const sy = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * ih;
    const sk = (k) => M.t + (1 - (k - k0) / (k1 - k0)) * ih;
    const ivPaths = [], kPaths = [];
    let iv = '', kp = '';
    pts.forEach((p, i) => {
      const gap = i > 0 && p.t - pts[i - 1].t > GAP_MS;
      if (gap) { ivPaths.push(iv); kPaths.push(kp); iv = ''; kp = ''; }
      const x = sx(p.t).toFixed(1);
      iv += `${iv ? 'L' : 'M'}${x},${sy(p[seriesKey]).toFixed(1)}`;
      // Step: hold the previous strike until this minute, then jump.
      kp += kp ? `H${x}V${sk(p.atmStrike).toFixed(1)}` : `M${x},${sk(p.atmStrike).toFixed(1)}`;
    });
    ivPaths.push(iv); kPaths.push(kp);
    const strikes = [...new Set(ks)].sort((a, b) => a - b);
    const kEvery = Math.max(1, Math.ceil(strikes.length / 6));
    return {
      sx, sy, sk, ivPaths, kPaths, t0, t1,
      yTicks: linTicks(y0, y1, 5),
      xTicks: linTicks(t0, t1, Math.max(2, Math.min(8, Math.floor(iw / 110)))),
      kTicks: strikes.filter((_, i) => i % kEvery === 0),
      multiDay: t1 - t0 > 20 * HOUR,
      iw, ih,
    };
  }, [pts, seriesKey, width, M.l, M.r, M.t, M.b]);

  if (!geo) return <div ref={wrapRef} className="pt-empty"><span className="pt-empty-title">Not enough data yet</span></div>;
  const { sx, sy, sk } = geo;
  const last = pts[pts.length - 1];

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * width;
    if (mx < M.l || mx > width - M.r) { setHover(null); return; }
    const t = geo.t0 + ((mx - M.l) / geo.iw) * (geo.t1 - geo.t0);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid; else hi = mid; }
    setHover(Math.abs(pts[lo].t - t) < Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi]);
  };

  return (
    <div ref={wrapRef} className="iv-chart-wrap">
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label="ATM implied volatility over time, with the ATM strike">
        {geo.yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line x1={M.l} x2={width - M.r} y1={sy(v)} y2={sy(v)} className="iv-grid" />
            <text x={M.l - 8} y={sy(v)} className="iv-tick" textAnchor="end" dominantBaseline="middle">{v.toFixed(1)}%</text>
          </g>
        ))}
        {geo.kTicks.map(k => (
          <text key={`k${k}`} x={width - M.r + 8} y={sk(k)} className="iv-tick iv-tick-strike" dominantBaseline="middle">{k.toLocaleString()}</text>
        ))}
        {geo.xTicks.map((t, i) => (
          <text key={`x${i}`} x={sx(t)} y={H - M.b + 18} className="iv-tick"
            textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}>{fmtTick(t, geo.multiDay)}</text>
        ))}
        {geo.kPaths.map((d, i) => d && <path key={`kp${i}`} d={d} className="iv-strike-line" />)}
        {geo.ivPaths.map((d, i) => d && <path key={`ip${i}`} d={d} className="iv-iv-line" />)}
        <circle cx={sx(last.t)} cy={sy(last[seriesKey])} r={4.5} className="iv-latest-dot" />
        {hover && (
          <g>
            <line x1={sx(hover.t)} x2={sx(hover.t)} y1={M.t} y2={H - M.b} className="iv-crosshair" />
            <circle cx={sx(hover.t)} cy={sy(hover[seriesKey])} r={4} className="iv-hover-dot" />
            <circle cx={sx(hover.t)} cy={sk(hover.atmStrike)} r={3} className="iv-hover-strike" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="iv-tip" style={{ left: Math.min(sx(hover.t) + 12, width - 214), top: 10 }}>
          <strong>{fmtIst(hover.t)} IST</strong>
          <span>IV {fmtIv(hover[seriesKey])} <em className={tone(hover.dIv)}>({fmtD(hover.dIv)} vs prev min)</em></span>
          <span>ATM {hover.atmStrike.toLocaleString()}{hover.strikeMove ? <em className={tone(hover.strikeMove)}> (moved {fmtD(hover.strikeMove, 0)})</em> : null}</span>
          <span>Spot {fmtNum(hover.spot)} · Call {fmtIv(hover.callIv)} · Put {fmtIv(hover.putIv)}</span>
        </div>
      )}
      <div className="iv-legend">
        <span><i className="iv-key-iv" /> IV (left axis)</span>
        <span><i className="iv-key-strike" /> ATM strike (right axis)</span>
      </div>
    </div>
  );
}

// 2) ATM strike (X) vs IV (Y): for each strike, the IV range while it was ATM (bar),
//    the average (dot) and how many minutes it was ATM.
function IvStrikeChart({ points, seriesKey }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 300;
  const M = { l: 56, r: 16, t: 14, b: 50 };

  const stats = useMemo(() => {
    const m = new Map();
    for (const p of points) {
      const v = p[seriesKey];
      if (v == null) continue;
      const s = m.get(p.atmStrike) ?? { strike: p.atmStrike, n: 0, sum: 0, min: Infinity, max: -Infinity, lastT: 0 };
      s.n++; s.sum += v; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.lastT = Math.max(s.lastT, p.t);
      m.set(p.atmStrike, s);
    }
    return [...m.values()].map(s => ({ ...s, avg: s.sum / s.n })).sort((a, b) => a.strike - b.strike);
  }, [points, seriesKey]);

  if (!stats.length) return <div ref={wrapRef} className="pt-empty"><span className="pt-empty-title">Not enough data yet</span></div>;

  const iw = width - M.l - M.r, ih = H - M.t - M.b;
  let y0 = Math.min(...stats.map(s => s.min)), y1 = Math.max(...stats.map(s => s.max));
  const pad = Math.max(0.2, (y1 - y0) * 0.08);
  y0 -= pad; y1 += pad;
  const band = iw / stats.length;
  const cx = (i) => M.l + band * (i + 0.5);
  const sy = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * ih;
  const barW = Math.max(6, Math.min(28, band * 0.45));
  const latestT = Math.max(...stats.map(s => s.lastT));
  const every = Math.max(1, Math.ceil(stats.length / Math.max(2, Math.floor(iw / 64))));

  return (
    <div ref={wrapRef} className="iv-chart-wrap">
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} onMouseLeave={() => setHover(null)}
        role="img" aria-label="IV range and average for each ATM strike">
        {linTicks(y0, y1, 5).map((v, i) => (
          <g key={`y${i}`}>
            <line x1={M.l} x2={width - M.r} y1={sy(v)} y2={sy(v)} className="iv-grid" />
            <text x={M.l - 8} y={sy(v)} className="iv-tick" textAnchor="end" dominantBaseline="middle">{v.toFixed(1)}%</text>
          </g>
        ))}
        {stats.map((s, i) => {
          const isLatest = s.lastT === latestT;
          return (
            <g key={s.strike} onMouseEnter={() => setHover({ ...s, i })}>
              <rect x={cx(i) - band / 2} y={M.t} width={band} height={ih} fill="transparent" />
              <rect x={cx(i) - barW / 2} y={sy(s.max)} width={barW} height={Math.max(2, sy(s.min) - sy(s.max))} rx={3}
                className={`iv-range-bar${isLatest ? ' latest' : ''}`} />
              <circle cx={cx(i)} cy={sy(s.avg)} r={4} className={`iv-avg-dot${isLatest ? ' latest' : ''}`} />
              {i % every === 0 && (
                <>
                  <text x={cx(i)} y={H - M.b + 16} className="iv-tick" textAnchor="middle">{s.strike.toLocaleString()}</text>
                  <text x={cx(i)} y={H - M.b + 30} className="iv-tick iv-tick-sub" textAnchor="middle">{s.n}m</text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="iv-tip" style={{ left: Math.min(cx(hover.i) + 14, width - 214), top: 10 }}>
          <strong>ATM {hover.strike.toLocaleString()}</strong>
          <span>ATM for {hover.n} minute{hover.n === 1 ? '' : 's'}</span>
          <span>Avg IV {fmtIv(hover.avg)}</span>
          <span>Range {fmtIv(hover.min)} – {fmtIv(hover.max)}</span>
          <span>Last ATM {fmtIst(hover.lastT)} IST</span>
        </div>
      )}
      <div className="iv-legend">
        <span><i className="iv-key-bar" /> IV range while ATM</span>
        <span><i className="iv-dot-key" /> average IV</span>
        <span><i className="iv-key-latest" /> current ATM strike</span>
        <span>Under each strike: minutes it was ATM</span>
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

  // Saved history (iv_history, migration 073; written once a minute by engine/ivRecorder.js):
  // every row of the last SAVED_DAYS days for this underlying, both expiry ranks, as CSV.
  const [savedBusy, setSavedBusy] = useState(false);
  const downloadSaved = async () => {
    setSavedBusy(true);
    try {
      const since = new Date(Date.now() - SAVED_DAYS * 24 * HOUR).toISOString();
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: e } = await supabase.from('iv_history')
          .select('ts,expiry,expiry_rank,hours_to_expiry,spot,atm_strike,call_iv,put_iv,atm_iv,call_mark,put_mark')
          .eq('underlying', underlying).gte('ts', since)
          .order('ts', { ascending: true }).order('expiry_rank', { ascending: true })
          .range(from, from + 999);
        if (e) throw e;
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      if (!all.length) { setError(`No saved IV history for ${underlying} yet — the server recorder writes one row a minute once it is running.`); return; }
      exportCsv(SAVED_COLUMNS, all.map(r => ({ ...r, time: fmtIst(r.ts), expiry: fmtExpiry(r.expiry), expiry_rank: r.expiry_rank === 0 ? 'nearest' : 'next' })),
        `atm-iv-saved_${underlying}_${SAVED_DAYS}d.csv`);
      setError('');
    } catch (e) {
      setError(`Couldn't load saved IV history: ${e.message}`);
    } finally {
      setSavedBusy(false);
    }
  };
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
                <button type="button" className="dr-btn" disabled={savedBusy} onClick={downloadSaved}
                  title={`Saved ATM IV history (recorded every minute on the server) — ${underlying}, last ${SAVED_DAYS} days, nearest and next expiry`}>
                  <Download size={13} /> {savedBusy ? 'Loading…' : `Saved ${SAVED_DAYS}D`}
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
                <span className="dr-card-title">{seriesLabel} IV over time</span>
                <span className="dr-card-sub">Solid = IV (left axis) · dashed = ATM strike (right axis) · hover for any minute</span>
              </div>
              <IvTimeChart points={points} seriesKey={seriesKey} />
            </div>

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">ATM strike vs {seriesLabel} IV</span>
                <span className="dr-card-sub">For each strike: IV range while it was ATM, average dot, minutes as ATM</span>
              </div>
              <IvStrikeChart points={points} seriesKey={seriesKey} />
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
