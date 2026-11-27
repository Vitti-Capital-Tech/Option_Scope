import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Download, FileSpreadsheet, Activity } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import { exportCsv, exportXlsx } from './exportTable';
import { loadProducts, getExpiries, fetchCandles } from './api';
import { impliedVol, yearsToExpiry } from './ivUtils';
import { supabase } from './supabase';
import { bucketize, movingAverage, detectSpikes, detectStable } from './ivEvents';

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
// Chart timeframe (bars of N minutes; the events below always use the 1-minute data).
const TIMEFRAMES = [
  { key: '1m', label: '1m', min: 1 },
  { key: '5m', label: '5m', min: 5 },
  { key: '15m', label: '15m', min: 15 },
  { key: '30m', label: '30m', min: 30 },
  { key: '1h', label: '1h', min: 60 },
  { key: '2h', label: '2h', min: 120 },
  { key: '4h', label: '4h', min: 240 },
  { key: '5h', label: '5h', min: 300 },
  { key: '12h', label: '12h', min: 720 },
  { key: '1d', label: '1d', min: 1440 },
];
// Custom timeframe text → minutes: "45", "45m", "3h", "1.5h", "2d" (1 minute … 7 days). null = invalid.
const parseTf = (txt) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day)?\s*$/i.exec(String(txt || ''));
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  const v = Number(m[1]) * (unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1);
  const min = Math.round(v);
  return min >= 1 && min <= 7 * 24 * 60 ? min : null;
};
const tfLabel = (min) => (min % 1440 === 0 ? `${min / 1440}d` : min % 60 === 0 ? `${min / 60}h` : `${min}m`);
const MA_LENGTHS = [0, 10, 20, 50]; // moving average over N bars of the chosen timeframe (0 = off)
const EVENTS_LIMIT = 200;
const EVENT_COLUMNS = [
  { key: 'event', label: 'Event' },
  { key: 'from', label: 'From (IST)' },
  { key: 'to', label: 'To (IST)' },
  { key: 'minutes', label: 'Duration (min)' },
  { key: 'ivFrom', label: 'IV From %' },
  { key: 'ivTo', label: 'IV To %' },
  { key: 'change', label: 'Δ IV (pts)' },
  { key: 'ivLow', label: 'IV Low %' },
  { key: 'ivHigh', label: 'IV High %' },
  { key: 'ivAvg', label: 'IV Avg %' },
  { key: 'spotFrom', label: 'Spot From' },
  { key: 'spotTo', label: 'Spot To' },
  { key: 'strikeFrom', label: 'ATM Strike From' },
  { key: 'strikeTo', label: 'ATM Strike To' },
];
const r2 = (v) => (v == null ? null : Number(v.toFixed(2)));
const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`);
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

// 1) IV over time (left axis) with the ATM strike as a step line (right axis). `points` are bars
//    of `barMin` minutes (1 = every minute); `ma` the moving average per bar; stable periods are
//    shaded and spikes marked (both from the 1-minute data).
function IvTimeChart({ points, seriesKey, barMin = 1, ma = [], maLen = 0, spikes = [], stables = [] }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 340;
  const M = { l: 56, r: 64, t: 14, b: 34 };
  const pts = useMemo(() => points.map((p, i) => ({ ...p, ma: ma[i] ?? null })).filter(p => p[seriesKey] != null), [points, seriesKey, ma]);
  const gapMs = Math.max(GAP_MS, barMin * 60_000 + GAP_MS);

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
    const ivPaths = [], kPaths = [], maPaths = [];
    let iv = '', kp = '', mp = '';
    pts.forEach((p, i) => {
      const gap = i > 0 && p.t - pts[i - 1].t > gapMs;
      if (gap) { ivPaths.push(iv); kPaths.push(kp); maPaths.push(mp); iv = ''; kp = ''; mp = ''; }
      const x = sx(p.t).toFixed(1);
      iv += `${iv ? 'L' : 'M'}${x},${sy(p[seriesKey]).toFixed(1)}`;
      // Step: hold the previous strike until this minute, then jump.
      kp += kp ? `H${x}V${sk(p.atmStrike).toFixed(1)}` : `M${x},${sk(p.atmStrike).toFixed(1)}`;
      if (p.ma != null) mp += `${mp ? 'L' : 'M'}${x},${sy(p.ma).toFixed(1)}`;
    });
    ivPaths.push(iv); kPaths.push(kp); maPaths.push(mp);
    const strikes = [...new Set(ks)].sort((a, b) => a - b);
    const kEvery = Math.max(1, Math.ceil(strikes.length / 6));
    return {
      sx, sy, sk, ivPaths, kPaths, maPaths, t0, t1, y0, y1,
      yTicks: linTicks(y0, y1, 5),
      xTicks: linTicks(t0, t1, Math.max(2, Math.min(8, Math.floor(iw / 110)))),
      kTicks: strikes.filter((_, i) => i % kEvery === 0),
      multiDay: t1 - t0 > 20 * HOUR,
      iw, ih,
    };
  }, [pts, seriesKey, width, gapMs, M.l, M.r, M.t, M.b]);

  if (!geo) return <div ref={wrapRef} className="pt-empty"><span className="pt-empty-title">Not enough data yet</span></div>;
  const { sx, sy, sk } = geo;
  const last = pts[pts.length - 1];
  const clampT = (t) => Math.min(geo.t1, Math.max(geo.t0, t));
  const clampY = (v) => sy(Math.min(geo.y1, Math.max(geo.y0, v)));
  const inView = (a, b) => b >= geo.t0 && a <= geo.t1;

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
        {stables.filter(r => inView(r.start, r.end)).map(r => (
          <rect key={`st${r.start}`} x={sx(clampT(r.start))} y={M.t} height={geo.ih}
            width={Math.max(1, sx(clampT(r.end)) - sx(clampT(r.start)))} className="iv-stable-band">
            <title>{`Stable ${fmtDur(r.minutes)} · IV ${r.low.toFixed(2)}–${r.high.toFixed(2)}%`}</title>
          </rect>
        ))}
        {geo.kPaths.map((d, i) => d && <path key={`kp${i}`} d={d} className="iv-strike-line" />)}
        {geo.ivPaths.map((d, i) => d && <path key={`ip${i}`} d={d} className="iv-iv-line" />)}
        {maLen > 1 && geo.maPaths.map((d, i) => d && <path key={`ma${i}`} d={d} className="iv-ma-line" />)}
        {spikes.filter(sp => inView(sp.peak, sp.peak)).map(sp => {
          const x = sx(sp.peak);
          const y = clampY(sp.to);
          const d = sp.dir === 'up' ? `M${x},${y - 12}l-5,-8h10z` : `M${x},${y + 12}l-5,8h10z`;
          return (
            <path key={`sp${sp.peak}${sp.dir}`} d={d} className={`iv-spike-${sp.dir}`}>
              <title>{`Spike ${sp.dir === 'up' ? '▲' : '▼'} ${fmtD(sp.change)} pts in ${fmtDur(sp.minutes)} (${sp.from.toFixed(2)} → ${sp.to.toFixed(2)}%)`}</title>
            </path>
          );
        })}
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
          <span>IV {fmtIv(hover[seriesKey])} <em className={tone(hover.dIv)}>({fmtD(hover.dIv)} vs prev {barMin > 1 ? 'bar' : 'min'})</em></span>
          {barMin > 1 && <span>O {hover.open.toFixed(2)} · H {hover.high.toFixed(2)} · L {hover.low.toFixed(2)} · C {hover.close.toFixed(2)}</span>}
          {maLen > 1 && hover.ma != null && <span>MA {maLen}: {hover.ma.toFixed(2)}%</span>}
          <span>ATM {hover.atmStrike.toLocaleString()}{hover.strikeMove ? <em className={tone(hover.strikeMove)}> (moved {fmtD(hover.strikeMove, 0)})</em> : null}</span>
          <span>Spot {fmtNum(hover.spot)} · Call {fmtIv(hover.callIv)} · Put {fmtIv(hover.putIv)}</span>
        </div>
      )}
      <div className="iv-legend">
        <span><i className="iv-key-iv" /> IV (left axis)</span>
        <span><i className="iv-key-strike" /> ATM strike (right axis)</span>
        {maLen > 1 && <span><i className="iv-key-ma" /> MA {maLen}</span>}
        <span><i className="iv-key-stable" /> Stable</span>
        <span><i className="iv-key-spike-up" /> Spike up</span>
        <span><i className="iv-key-spike-down" /> Spike down</span>
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
  const [tfKey, setTfKey] = useState('1m'); // a preset key, or 'custom' (customTf)
  const [customTf, setCustomTf] = useState('');
  const [maLen, setMaLen] = useState(20);
  // Event settings: a spike = IV moved ≥ spikeThr points within spikeWin minutes; stable = IV
  // stayed inside a stableBand-point band for ≥ stableMin minutes.
  const [spikeWin, setSpikeWin] = useState(15);
  const [spikeThr, setSpikeThr] = useState(1);
  const [stableBand, setStableBand] = useState(0.5);
  const [stableMin, setStableMin] = useState(30);
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

  const customMin = parseTf(customTf);
  const barMin = tfKey === 'custom' ? (customMin ?? 1) : (TIMEFRAMES.find(f => f.key === tfKey)?.min ?? 1);
  const bars = useMemo(() => bucketize(points, seriesKey, barMin), [points, seriesKey, barMin]);
  const maVals = useMemo(() => movingAverage(bars, maLen), [bars, maLen]);
  const spikes = useMemo(() => detectSpikes(points, seriesKey, { windowMin: spikeWin, threshold: spikeThr }), [points, seriesKey, spikeWin, spikeThr]);
  const stables = useMemo(() => detectStable(points, seriesKey, { band: stableBand, minMinutes: stableMin, gapMs: GAP_MS }), [points, seriesKey, stableBand, stableMin]);
  const events = useMemo(() => [...spikes, ...stables].sort((a, b) => b.start - a.start), [spikes, stables]);
  const eventStats = useMemo(() => {
    const s = points.filter(p => p[seriesKey] != null);
    const spanMin = s.length > 1 ? Math.round((s[s.length - 1].t - s[0].t) / 60_000) : 0;
    const stableMinTotal = stables.reduce((a, r) => a + r.minutes, 0);
    const biggest = spikes.reduce((b, sp) => (!b || Math.abs(sp.change) > Math.abs(b.change) ? sp : b), null);
    const lastT = s.length ? s[s.length - 1].t : null;
    const lastStable = stables[stables.length - 1];
    const stableNow = lastStable && lastT != null && lastT - lastStable.end <= GAP_MS ? lastStable : null;
    const lastSpike = spikes[spikes.length - 1] ?? null;
    return {
      up: spikes.filter(sp => sp.dir === 'up').length,
      down: spikes.filter(sp => sp.dir === 'down').length,
      biggest, stableCount: stables.length, stableMinTotal,
      stablePct: spanMin > 0 ? (stableMinTotal / spanMin) * 100 : null,
      stableNow, lastSpike,
    };
  }, [points, seriesKey, spikes, stables]);

  const eventRows = () => events.map(ev => ({
    event: ev.kind === 'stable' ? 'Stable' : ev.dir === 'up' ? 'Spike up' : 'Spike down',
    from: fmtIst(ev.start),
    to: fmtIst(ev.kind === 'stable' ? ev.end : ev.peak),
    minutes: ev.minutes,
    ivFrom: r2(ev.from), ivTo: r2(ev.to), change: r2(ev.change),
    ivLow: ev.kind === 'stable' ? r2(ev.low) : null,
    ivHigh: ev.kind === 'stable' ? r2(ev.high) : null,
    ivAvg: ev.kind === 'stable' ? r2(ev.avg) : null,
    spotFrom: r2(ev.spotFrom), spotTo: r2(ev.spotTo),
    strikeFrom: ev.strikeFrom, strikeTo: ev.strikeTo,
  }));

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
                  <span>Timeframe</span>
                  <div className="dr-seg" role="group" aria-label="Chart timeframe">
                    {TIMEFRAMES.map(f => (
                      <button key={f.key} type="button" className={tfKey === f.key ? 'on' : ''} aria-pressed={tfKey === f.key}
                        onClick={() => setTfKey(f.key)}>{f.label}</button>
                    ))}
                  </div>
                  <input className={`dr-date iv-tf-custom ${tfKey === 'custom' ? 'on' : ''} ${customTf && customMin == null ? 'bad' : ''}`}
                    placeholder="Custom e.g. 3h" value={customTf} aria-label="Custom timeframe (e.g. 45m, 3h)"
                    title="Any timeframe: minutes (45 or 45m), hours (3h, 1.5h) or days (2d). Bars start at fixed UTC boundaries (a 1d bar runs 05:30 → 05:30 IST)"
                    onChange={e => { setCustomTf(e.target.value); if (parseTf(e.target.value) != null) setTfKey('custom'); }} />
                </div>
                <div className="dr-field">
                  <span>Moving avg</span>
                  <div className="dr-seg" role="group" aria-label="Moving average length">
                    {MA_LENGTHS.map(n => (
                      <button key={n} type="button" className={maLen === n ? 'on' : ''} aria-pressed={maLen === n}
                        onClick={() => setMaLen(n)}>{n ? `MA ${n}` : 'Off'}</button>
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
                <span className="dr-card-title">{seriesLabel} IV over time · {barMin > 1 ? `${tfLabel(barMin)} bars` : '1 minute'}</span>
                <span className="dr-card-sub">Solid = IV{barMin > 1 ? ' (bar close)' : ''} · dotted = MA{maLen ? ` ${maLen}` : ' (off)'} · dashed = ATM strike (right axis) · shaded = stable · ▲▼ = spikes · hover for details</span>
              </div>
              <IvTimeChart points={bars} seriesKey={seriesKey} barMin={barMin} ma={maVals} maLen={maLen} spikes={spikes} stables={stables} />
            </div>

            <div className="dr-card">
              <div className="dr-card-head">
                <span className="dr-card-title">IV events · spikes and stable periods</span>
                <span className="dr-card-sub">From the 1-minute data (the timeframe doesn't change them)</span>
                <div className="dr-actions iv-ev-actions">
                  <button type="button" className="dr-btn" disabled={!events.length}
                    onClick={() => exportCsv(EVENT_COLUMNS, eventRows(), `${fileBase}_iv-events.csv`)}>
                    <Download size={13} /> CSV
                  </button>
                  <button type="button" className="dr-btn primary" disabled={!events.length}
                    onClick={() => exportXlsx(EVENT_COLUMNS, eventRows(), `${fileBase}_iv-events.xlsx`, 'IV events')}>
                    <FileSpreadsheet size={13} /> Excel
                  </button>
                </div>
              </div>
              <div className="iv-ev-settings">
                <label>Spike: IV moves ≥
                  <input type="number" min="0.1" step="0.1" value={spikeThr} onChange={e => setSpikeThr(Math.max(0.1, Number(e.target.value) || 0.1))} />
                  pts within
                  <select value={spikeWin} onChange={e => setSpikeWin(Number(e.target.value))}>
                    {[5, 10, 15, 30, 60].map(m => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </label>
                <label>Stable: IV stays within
                  <input type="number" min="0.1" step="0.1" value={stableBand} onChange={e => setStableBand(Math.max(0.1, Number(e.target.value) || 0.1))} />
                  pts for ≥
                  <select value={stableMin} onChange={e => setStableMin(Number(e.target.value))}>
                    {[15, 30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </label>
              </div>
              <div className="dr-tiles iv-ev-tiles">
                <div className="dr-tile"><span>Spikes up</span><strong className="iv-up">{eventStats.up}</strong><em>IV jumped</em></div>
                <div className="dr-tile"><span>Spikes down</span><strong className="iv-down">{eventStats.down}</strong><em>IV dropped</em></div>
                <div className="dr-tile">
                  <span>Biggest spike</span>
                  <strong className={eventStats.biggest ? (eventStats.biggest.dir === 'up' ? 'iv-up' : 'iv-down') : ''}>{eventStats.biggest ? `${fmtD(eventStats.biggest.change)} pts` : '—'}</strong>
                  <em>{eventStats.biggest ? `${fmtIst(eventStats.biggest.start)} · in ${fmtDur(eventStats.biggest.minutes)}` : 'none in range'}</em>
                </div>
                <div className="dr-tile">
                  <span>Stable time</span>
                  <strong>{fmtDur(eventStats.stableMinTotal)}</strong>
                  <em>{eventStats.stableCount} period{eventStats.stableCount === 1 ? '' : 's'}{eventStats.stablePct != null ? ` · ${eventStats.stablePct.toFixed(0)}% of range` : ''}</em>
                </div>
                <div className="dr-tile">
                  <span>Now</span>
                  <strong>{eventStats.stableNow ? 'Stable' : eventStats.lastSpike && points.length && points[points.length - 1].t - eventStats.lastSpike.end <= 5 * 60_000 ? (eventStats.lastSpike.dir === 'up' ? 'Spiking ▲' : 'Dropping ▼') : 'Moving'}</strong>
                  <em>{eventStats.stableNow ? `for ${fmtDur(eventStats.stableNow.minutes)} at ~${eventStats.stableNow.avg.toFixed(2)}%` : eventStats.lastSpike ? `last spike ${fmtIst(eventStats.lastSpike.start)}` : 'no spike in range'}</em>
                </div>
              </div>
              {events.length === 0 ? (
                <div className="pt-empty"><span className="pt-empty-title">{points.length ? 'No spikes or stable periods with these settings' : 'Loading…'}</span></div>
              ) : (
                <div className="pt-table-scroll">
                  <table className="pt-table dr-table">
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>From (IST)</th>
                        <th>To (IST)</th>
                        <th className="r">Duration</th>
                        <th className="r">IV</th>
                        <th className="r">Δ IV</th>
                        <th className="r">Spot</th>
                        <th className="r">ATM strike</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.slice(0, EVENTS_LIMIT).map(ev => (
                        <tr key={`${ev.kind}${ev.start}${ev.dir ?? ''}`}>
                          <td>
                            {ev.kind === 'stable'
                              ? <span className="iv-ev-tag stable">Stable</span>
                              : <span className={`iv-ev-tag ${ev.dir}`}>{ev.dir === 'up' ? 'Spike ▲' : 'Spike ▼'}</span>}
                          </td>
                          <td>{fmtIst(ev.start)}</td>
                          <td>{fmtIst(ev.kind === 'stable' ? ev.end : ev.peak)}</td>
                          <td className="r">{fmtDur(ev.minutes)}</td>
                          <td className="r">{ev.kind === 'stable' ? `${ev.low.toFixed(2)}–${ev.high.toFixed(2)}% (avg ${ev.avg.toFixed(2)})` : `${ev.from.toFixed(2)} → ${ev.to.toFixed(2)}%`}</td>
                          <td className="r"><span className={ev.kind === 'stable' ? '' : tone(ev.change)}>{fmtD(ev.change)}</span></td>
                          <td className="r">{fmtNum(ev.spotFrom)} → {fmtNum(ev.spotTo)}</td>
                          <td className="r">{ev.strikeFrom === ev.strikeTo ? fmtNum(ev.strikeFrom) : `${fmtNum(ev.strikeFrom)} → ${fmtNum(ev.strikeTo)}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
