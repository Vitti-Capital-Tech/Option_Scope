import React from 'react';

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
  totalMargin
}) {
  const fmt = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
  const cls = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral');
  const losses = Math.max(0, tradeHistoryLength - wins);
  const wrNum = winRate === '—' ? 0 : parseFloat(winRate);

  return (
    <div className="pt-kpi-strip">
      {/* Hero: the two P&L figures lead */}
      <div className="pt-kpi-hero-row">
        <div className={`pt-kpi-hero ${todayPnl >= 0 ? 'up' : 'down'}`}>
          <span className="pt-kpi-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
            Daily P&amp;L
          </span>
          <span className={`pt-kpi-hero-value ${cls(todayPnl)}`}>{fmt(todayPnl)}</span>
          <div className="pt-kpi-pills">
            <span className="pt-kpi-pill">Realized <b className={cls(todayRealizedPnl)}>{fmt(todayRealizedPnl)}</b></span>
            <span className="pt-kpi-pill">Unrealized <b className={cls(totalUnrealizedPnl)}>{fmt(totalUnrealizedPnl)}</b></span>
          </div>
        </div>

        <div className="pt-kpi-hero gold">
          <span className="pt-kpi-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 4-6" /></svg>
            Cumulative P&amp;L
          </span>
          <span className={`pt-kpi-hero-value ${cls(totalPnl)}`}>{fmt(totalPnl)}</span>
          <div className="pt-kpi-pills">
            <span className="pt-kpi-pill">Realized <b className={cls(totalRealizedPnl)}>{fmt(totalRealizedPnl)}</b></span>
          </div>
        </div>
      </div>

      {/* Compact secondary metrics */}
      <div className="pt-kpi-mini-row">
        <div className="pt-kpi-mini">
          <span className="pt-kpi-mini-label">Win Rate</span>
          <span className="pt-kpi-mini-value">{winRate}{winRate !== '—' ? '%' : ''}</span>
          <div className="pt-kpi-wr">
            <div className="pt-kpi-wr-fill" style={{ width: `${wrNum}%` }} />
          </div>
          <span className="pt-kpi-mini-sub">{wins}W / {losses}L of {tradeHistoryLength}</span>
        </div>

        <div className="pt-kpi-mini">
          <span className="pt-kpi-mini-label">Open Positions</span>
          <span className="pt-kpi-mini-value">{activePositionsCount}</span>
          <span className="pt-kpi-mini-sub">
            <span style={{ color: 'var(--call)' }}>{activeCallsCount}C</span> · <span style={{ color: 'var(--put)' }}>{activePutsCount}P</span>
          </span>
        </div>

        <div className="pt-kpi-mini">
          <span className="pt-kpi-mini-label">Completed</span>
          <span className="pt-kpi-mini-value">{tradeHistoryLength}</span>
          <span className="pt-kpi-mini-sub">Closed trades</span>
        </div>

        <div className="pt-kpi-mini">
          <span className="pt-kpi-mini-label">Margin Used</span>
          <span className="pt-kpi-mini-value">${totalMargin.toFixed(0)}</span>
          <span className="pt-kpi-mini-sub">Across {activePositionsCount} position{activePositionsCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}
