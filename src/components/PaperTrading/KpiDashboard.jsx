import React from 'react';
import { ArrowUp, TrendingUp, Wallet } from 'lucide-react';

export default function KpiDashboard({
  todayPnl,
  todayRealizedPnl,
  totalUnrealizedPnl,
  totalPnl,
  totalRealizedPnl,
  winRate,
  wins,
  tradeHistoryLength,
  activePositionsCount,
  activeCallsCount,
  activePutsCount,
  totalMargin,
  isLive = false,
  walletBalance = null,
  allocationPct = 90,
  maxPositions = 6,
  isPaper = false,
  paperEquity = null
}) {
  const fmt = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
  const cls = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral');
  const losses = Math.max(0, tradeHistoryLength - wins);
  const wrNum = winRate === '—' ? 0 : parseFloat(winRate);
  const money = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const showBalance = isLive && walletBalance != null;
  const allocated = showBalance ? walletBalance * (allocationPct / 100) : 0;
  const perPosition = showBalance ? allocated / Math.max(1, maxPositions) : 0;

  // Paper funded-account view: equity = initial + realized P&L. Allocated pool =
  // equity × allocation%; the remainder is an untouched buffer. Per-position margin =
  // allocated ÷ the active window's Max Combined Positions (maxPositions prop).
  const showPaperBalance = isPaper && paperEquity != null;
  const paperAllocated = showPaperBalance ? paperEquity * (allocationPct / 100) : 0;
  const paperBuffer = showPaperBalance ? Math.max(0, paperEquity - paperAllocated) : 0;
  const paperPerPosition = showPaperBalance ? paperAllocated / Math.max(1, maxPositions) : 0;

  return (
    <div className="pt-kpi-grid">
      {/* Daily P&L */}
      <div className={`pt-kpi-cell hero ${todayPnl >= 0 ? 'up' : 'down'}`}>
        <span className="pt-k-lbl">
          <ArrowUp size={11} strokeWidth={2} />
          Daily P&amp;L
        </span>
        <span className={`pt-k-val ${cls(todayPnl)}`}>{fmt(todayPnl)}</span>
        <span className="pt-k-sub">
          <b className={cls(todayRealizedPnl)}>{fmt(todayRealizedPnl)}</b> realized · <b className={cls(totalUnrealizedPnl)}>{fmt(totalUnrealizedPnl)}</b> unrl.
        </span>
      </div>

      {/* Cumulative P&L */}
      <div className="pt-kpi-cell hero gold">
        <span className="pt-k-lbl">
          <TrendingUp size={11} strokeWidth={2} />
          Cumulative P&amp;L
        </span>
        <span className={`pt-k-val ${cls(totalPnl)}`}>{fmt(totalPnl)}</span>
        <span className="pt-k-sub">Realized <b className={cls(totalRealizedPnl)}>{fmt(totalRealizedPnl)}</b></span>
      </div>

      {/* Win Rate */}
      <div className="pt-kpi-cell">
        <span className="pt-k-lbl">Win Rate</span>
        <span className="pt-k-val">{winRate}{winRate !== '—' ? '%' : ''}</span>
        <div className="pt-k-wr"><i style={{ width: `${wrNum}%` }} /></div>
        <span className="pt-k-sub">{wins}W / {losses}L of {tradeHistoryLength}</span>
      </div>

      {/* Open Positions */}
      <div className="pt-kpi-cell">
        <span className="pt-k-lbl">Open Positions</span>
        <span className="pt-k-val">{activePositionsCount}</span>
        <span className="pt-k-sub">
          <b style={{ color: 'var(--call)' }}>{activeCallsCount}C</b> · <b style={{ color: 'var(--put)' }}>{activePutsCount}P</b>
        </span>
      </div>

      {/* Margin Used */}
      <div className="pt-kpi-cell">
        <span className="pt-k-lbl">Margin Used</span>
        <span className="pt-k-val">${totalMargin.toFixed(0)}</span>
        <span className="pt-k-sub">Across {activePositionsCount} position{activePositionsCount !== 1 ? 's' : ''}</span>
      </div>

      {/* Live wallet balance & allocation (live accounts only) */}
      {showBalance && (
        <div className="pt-kpi-cell">
          <span className="pt-k-lbl">
            <Wallet size={11} strokeWidth={2} />
            Live Balance
          </span>
          <span className="pt-k-val">{money(walletBalance)} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>USDT</span></span>
          <span className="pt-k-sub">
            Allocated <b>{money(allocated)}</b> ({allocationPct}%) · <b>{money(perPosition)}</b>/pos
          </span>
        </div>
      )}

      {/* Paper simulated balance & allocation (paper accounts only) */}
      {showPaperBalance && (
        <div className="pt-kpi-cell">
          <span className="pt-k-lbl">
            <Wallet size={11} strokeWidth={2} />
            Paper Balance
          </span>
          <span className="pt-k-val">{money(paperEquity)} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>USD</span></span>
          <span className="pt-k-sub">
            Alloc <b>{money(paperAllocated)}</b> ({allocationPct}%) · Buffer <b>{money(paperBuffer)}</b> · <b>{money(paperPerPosition)}</b>/pos
          </span>
        </div>
      )}
    </div>
  );
}
