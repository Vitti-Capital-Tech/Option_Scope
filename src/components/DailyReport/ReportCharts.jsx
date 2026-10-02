import React, { useEffect, useRef, useState } from 'react';

// Two small SVG charts for the Daily Report: daily net P&L (columns above / below zero) and the
// cumulative net P&L over the range (line). Separate charts, one y-axis each. Colours come from
// the app tokens (--call / --put for sign, --accent for the running total), so both themes work.

const H = 200;
const PAD = { t: 14, r: 14, b: 26, l: 60 };

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const niceStep = (raw) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

// Y domain always includes 0, rounded out to clean ticks.
function yScale(values) {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

const fmtAxis = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : a >= 1e3 ? `${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`
    : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}$${s}`;
};
const fmtShortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

// Every k-th date label so they never collide (~72px each).
const labelEvery = (n, iw) => Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 72))));

function Axes({ w, ticks, y, xLabels }) {
  return (
    <g className="dr-axis">
      {ticks.map(t => (
        <g key={t}>
          <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'dr-zero' : 'dr-grid'} />
          <text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmtAxis(t)}</text>
        </g>
      ))}
      {xLabels.map(({ x, label }) => (
        <text key={`${x}-${label}`} x={x} y={H - 8} textAnchor="middle">{label}</text>
      ))}
    </g>
  );
}

function Tooltip({ x, w, children }) {
  if (x == null) return null;
  const left = Math.min(Math.max(x, 90), w - 90);
  return <div className="dr-tip" style={{ left }}>{children}</div>;
}

function ChartCard({ title, sub, children, innerRef }) {
  return (
    <div className="dr-chart">
      <div className="dr-chart-head">
        <span className="dr-chart-title">{title}</span>
        {sub && <span className="dr-chart-sub">{sub}</span>}
      </div>
      <div className="dr-chart-body" ref={innerRef}>{children}</div>
    </div>
  );
}

// days: ascending [{ date, netPnl, returnPct, exits, pnlEstimate }]
export function DailyPnlChart({ days, fmtUsd, fmtPct }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const n = days.length;
  const iw = Math.max(0, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const { lo, hi, ticks } = yScale(days.map(d => d.netPnl ?? 0));
  const y = (v) => PAD.t + ((hi - v) / (hi - lo)) * ih;
  const band = n ? iw / n : 0;
  const bw = Math.max(1, Math.min(24, band - 2)); // ≤24px, 2px surface gap between neighbours
  const cx = (i) => PAD.l + i * band + band / 2;
  const every = labelEvery(n, iw);
  const xLabels = days.map((d, i) => ({ i, x: cx(i), label: fmtShortDate(d.date) })).filter(({ i }) => (n - 1 - i) % every === 0);

  // Rounded at the data end, square at the baseline.
  const barPath = (i, v) => {
    const x0 = cx(i) - bw / 2;
    const y0 = y(0);
    const y1 = y(v);
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    const r = Math.min(4, bw / 2, h);
    const s = v >= 0 ? 1 : -1;
    return `M${x0},${y0} V${y1 + s * r} Q${x0},${y1} ${x0 + r},${y1} H${x0 + bw - r} Q${x0 + bw},${y1} ${x0 + bw},${y1 + s * r} V${y0} Z`;
  };

  const wins = days.filter(d => d.netPnl > 0).length;
  const losses = days.filter(d => d.netPnl < 0).length;
  const hd = hover != null ? days[hover] : null;

  return (
    <ChartCard title="Daily net P&L" sub={`${wins} up · ${losses} down`} innerRef={ref}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Daily net P&L by day" onPointerLeave={() => setHover(null)}>
          <Axes w={w} ticks={ticks} y={y} xLabels={xLabels} />
          {days.map((d, i) => (
            <path key={d.date} d={barPath(i, d.netPnl ?? 0)}
              className={`dr-bar ${d.netPnl >= 0 ? 'pos' : 'neg'}${hover != null && hover !== i ? ' dim' : ''}`} />
          ))}
          {days.map((d, i) => (
            <rect key={`hit-${d.date}`} x={PAD.l + i * band} y={PAD.t} width={band} height={ih} fill="transparent"
              onPointerEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hd && (
        <Tooltip x={cx(hover)} w={w}>
          <b>{fmtShortDate(hd.date)}</b>
          <span>Net P&amp;L <strong className={hd.netPnl > 0 ? 'positive' : hd.netPnl < 0 ? 'negative' : ''}>{fmtUsd(hd.netPnl)}</strong>{hd.pnlEstimate && <em className="dr-est"> est.</em>}</span>
          <span>Return <strong>{fmtPct(hd.returnPct)}</strong></span>
          <span>Exits <strong>{hd.exits}</strong></span>
        </Tooltip>
      )}
    </ChartCard>
  );
}

// Running total of daily net P&L — the range's equity curve, deposits excluded.
export function CumulativePnlChart({ days, fmtUsd }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const n = days.length;
  const pts = days.reduce((acc, d) => {
    acc.push({ date: d.date, day: d.netPnl, cum: (acc.at(-1)?.cum ?? 0) + (d.netPnl ?? 0) });
    return acc;
  }, []);
  const iw = Math.max(0, w - PAD.l - PAD.r);
  const ih = H - PAD.t - PAD.b;
  const { lo, hi, ticks } = yScale(pts.map(p => p.cum));
  const y = (v) => PAD.t + ((hi - v) / (hi - lo)) * ih;
  const x = (i) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const every = labelEvery(n, iw);
  const xLabels = pts.map((p, i) => ({ i, x: x(i), label: fmtShortDate(p.date) })).filter(({ i }) => (n - 1 - i) % every === 0);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.cum)}`).join(' ');
  const area = n ? `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z` : '';
  const last = pts[n - 1];

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    setHover(n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((mx - PAD.l) / iw) * (n - 1)))));
  };
  const hp = hover != null ? pts[hover] : null;

  return (
    <ChartCard title="Cumulative net P&L" sub={last ? `${fmtUsd(last.cum)} over ${n} day${n === 1 ? '' : 's'}` : null} innerRef={ref}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Cumulative net P&L over the range"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <Axes w={w} ticks={ticks} y={y} xLabels={xLabels} />
          <path d={area} className="dr-area" />
          <path d={line} className="dr-line" />
          {hp ? (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="dr-cross" />
              <circle cx={x(hover)} cy={y(hp.cum)} r={4.5} className="dr-dot" />
            </>
          ) : last && <circle cx={x(n - 1)} cy={y(last.cum)} r={4.5} className="dr-dot" />}
        </svg>
      )}
      {hp && (
        <Tooltip x={x(hover)} w={w}>
          <b>{fmtShortDate(hp.date)}</b>
          <span>Cumulative <strong className={hp.cum > 0 ? 'positive' : hp.cum < 0 ? 'negative' : ''}>{fmtUsd(hp.cum)}</strong></span>
          <span>That day <strong className={hp.day > 0 ? 'positive' : hp.day < 0 ? 'negative' : ''}>{fmtUsd(hp.day)}</strong></span>
        </Tooltip>
      )}
    </ChartCard>
  );
}
