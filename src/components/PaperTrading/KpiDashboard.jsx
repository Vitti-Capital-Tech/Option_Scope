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
  return (
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
        <span className="pt-kpi-sub">{wins}W / {tradeHistoryLength - wins}L of {tradeHistoryLength}</span>
      </div>

      <div className="pt-kpi-card accent-blue">
        <span className="pt-kpi-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
          Active
        </span>
        <span className="pt-kpi-value neutral">{activePositionsCount}</span>
        <span className="pt-kpi-sub">
          {activeCallsCount} calls /&nbsp;
          {activePutsCount} puts
        </span>
      </div>

      <div className="pt-kpi-card accent-purple">
        <span className="pt-kpi-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
          Trades
        </span>
        <span className="pt-kpi-value neutral">{tradeHistoryLength}</span>
        <span className="pt-kpi-sub">Closed positions</span>
      </div>

      <div className="pt-kpi-card accent-blue">
        <span className="pt-kpi-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
          Margin Used
        </span>
        <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
        <span className="pt-kpi-sub">
          Across {activePositionsCount} position{activePositionsCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
