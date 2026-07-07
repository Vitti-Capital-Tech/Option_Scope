import React, { useState } from 'react';
import ActivePositionsTable from './ActivePositionsTable';
import TradeHistoryTable from './TradeHistoryTable';

// ── Icons ───────────────────────────────────────────────────────────────
const ICONS = {
  positions: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  open: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
  stop: <><path d="M4.9 4.9 19.1 19.1" /><circle cx="12" cy="12" r="9" /></>,
  fills: <><path d="M20 6 9 17l-5-5" /></>,
  history: <><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 2" /></>,
  risk: <><path d="M12 2 2 7v6c0 5 4 8 10 9 6-1 10-4 10-9V7z" /></>,
};

const Icon = ({ name, size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>
);

// Exit trigger for a position — mirrors ActivePositionsTable's logic so the
// Stop Orders tab stays consistent with the distance-to-exit meter there.
function exitTrigger(p, exitType, exitPoints) {
  const isCall = p.type === 'call';
  const buyStrike = Number(p.buyLeg.strike);
  let triggerPrice = buyStrike;
  if (exitType === 'ITM') triggerPrice = isCall ? buyStrike + exitPoints : buyStrike - exitPoints;
  else if (exitType === 'OTM') triggerPrice = isCall ? buyStrike - exitPoints : buyStrike + exitPoints;
  const operator = isCall ? '≥' : '≤';
  return { triggerPrice, operator, isCall };
}

// ── Empty state ─────────────────────────────────────────────────────────
function EmptyPanel({ icon, title, desc }) {
  return (
    <div className="pt-empty">
      <div className="pt-empty-icon idle">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICONS[icon]}</svg>
      </div>
      <span className="pt-empty-title">{title}</span>
      <span className="pt-empty-desc">{desc}</span>
    </div>
  );
}

// ── Stop Orders — derived from active positions' exit triggers ────────────
function StopOrdersTab({ positions, underlying, spotPrice, exitType, exitPoints, onExitPosition }) {
  // Spreads only — long-only positions exit via their scale-out ladder and live
  // under Open Orders, not as spot-trigger stops.
  const rows = positions.filter(p => p.underlying === underlying && (p.sellQty || 0) > 0);
  if (rows.length === 0) {
    return (
      <EmptyPanel icon="stop" title="No Stop Orders"
        desc="Each open position arms an automatic exit trigger. They appear here while the engine watches spot against the exit level." />
    );
  }
  const liveSpot = spotPrice || 0;
  return (
    <div className="pt-table-scroll">
      <table className="pt-table">
        <thead><tr>
          <th>Linked Position</th>
          <th>Trigger</th>
          <th>Condition</th>
          <th>Trigger Spot</th>
          <th>Spot Now</th>
          <th>Distance</th>
          <th>Action</th>
          <th>Status</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          {rows.map(p => {
            const isLongOnly = (p.sellQty || 0) === 0;
            const { triggerPrice, operator, isCall } = exitTrigger(p, exitType, exitPoints);
            const away = Math.abs(triggerPrice - liveSpot);
            const awayPct = liveSpot > 0 ? (away / liveSpot) * 100 : 0;
            const hit = isCall ? liveSpot >= triggerPrice : liveSpot <= triggerPrice;
            return (
              <tr key={p.id} className={`pt-row-${p.type}`}>
                <td>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className={`pt-legrail ${p.type}`} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>
                        {p.buyLeg.strike.toLocaleString()}{isLongOnly ? '' : ` / ${p.sellLeg.strike.toLocaleString()}`}
                      </span>
                    </div>
                  </div>
                </td>
                <td><span className="pt-exit-badge atm">{isLongOnly ? 'LADDER' : `${exitType} EXIT`}</span></td>
                <td><span style={{ fontFamily: 'Inter', fontWeight: 600, color: 'var(--text-dim)' }}>Spot {operator}</span></td>
                <td><span style={{ color: 'var(--accent)', fontWeight: 700 }}>{triggerPrice.toLocaleString()}</span></td>
                <td><span style={{ fontWeight: 600 }}>{liveSpot ? liveSpot.toLocaleString() : '—'}</span></td>
                <td>
                  <span className={hit ? 'pt-pnl negative' : ''} style={{ fontWeight: 700 }}>
                    {Math.round(away).toLocaleString()}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 4 }}>
                    ({awayPct.toFixed(2)}%)
                  </span>
                </td>
                <td><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Close {isLongOnly ? 'long' : 'spread'}</span></td>
                <td>
                  <span className="pt-stop-status" style={{ color: hit ? 'var(--put)' : 'var(--call)' }}>
                    <span className="pt-status-pulse" style={{ background: hit ? 'var(--put)' : 'var(--call)' }} />
                    {hit ? 'Triggering' : 'Armed'}
                  </span>
                </td>
                <td>
                  <button onClick={() => onExitPosition(p)} className="pt-btn-exit-pos pt-mini-btn">
                    Close now
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Risk & Margin — derived from open positions + margin math ─────────────
function RiskMarginTab({ positions, underlying, spotPrice, totalMargin, calculatePositionMargin, includeFees }) {
  const rows = positions.filter(p => p.underlying === underlying);
  if (rows.length === 0) {
    return (
      <EmptyPanel icon="risk" title="No Exposure"
        desc="Margin, exposure and risk metrics for open positions appear here once the engine enters a trade." />
    );
  }

  const totalUnrl = rows.reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0)), 0);
  const calls = rows.filter(p => p.type === 'call').length;
  const puts = rows.filter(p => p.type === 'put').length;
  const maxMargin = Math.max(...rows.map(calculatePositionMargin), 1);
  const worst = rows.reduce((a, b) => (calculatePositionMargin(b) > calculatePositionMargin(a) ? b : a), rows[0]);
  // Rough notional at risk: short-leg notional across positions.
  const notional = rows.reduce((s, p) => {
    const sellLot = p.sellLeg?.lotSize || 0;
    return s + (spotPrice || p.entrySpotPrice || 0) * (p.sellQty || 0) * sellLot;
  }, 0);

  const cards = [
    { label: 'Total Margin Used', big: `$${totalMargin.toFixed(0)}`, sub: `Across ${rows.length} position${rows.length !== 1 ? 's' : ''}`, pct: 100, color: 'var(--accent)' },
    { label: 'Unrealized P&L', big: `${totalUnrl >= 0 ? '+' : ''}${totalUnrl.toFixed(2)}`, sub: includeFees ? 'Net of fees' : 'Gross', pct: Math.min(100, Math.abs(totalUnrl) / (totalMargin || 1) * 100), color: totalUnrl >= 0 ? 'var(--call)' : 'var(--put)', valClass: totalUnrl >= 0 ? 'positive' : 'negative' },
    { label: 'Open Exposure', big: `${calls}C · ${puts}P`, sub: `Short notional ≈ $${notional.toFixed(0)}`, pct: (calls + puts) ? (calls / (calls + puts)) * 100 : 0, color: 'var(--call)' },
    { label: 'Largest Position', big: `$${calculatePositionMargin(worst).toFixed(0)}`, sub: `${worst.type.toUpperCase()} ${worst.buyLeg.strike.toLocaleString()}`, pct: (calculatePositionMargin(worst) / (totalMargin || 1)) * 100, color: 'var(--accent)' },
  ];

  return (
    <>
      <div className="pt-risk-grid">
        {cards.map((c, i) => (
          <div key={i} className="pt-risk-card">
            <h4>{c.label}</h4>
            <span className={`pt-risk-big ${c.valClass || ''}`}>{c.big}</span>
            <div className="pt-meter"><i style={{ width: `${c.pct}%`, background: c.color }} /></div>
            <span className="pt-risk-sub">{c.sub}</span>
          </div>
        ))}
      </div>

      <div className="pt-table-scroll" style={{ borderTop: '1px solid var(--border)' }}>
        <table className="pt-table">
          <thead><tr>
            <th>Position</th>
            <th>Strikes (L/S)</th>
            <th>Req. Margin</th>
            <th>% of Total</th>
            <th>Unrealized P&L</th>
          </tr></thead>
          <tbody>
            {rows.map(p => {
              const m = calculatePositionMargin(p);
              const pnl = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
              const isLongOnly = (p.sellQty || 0) === 0;
              return (
                <tr key={p.id} className={`pt-row-${p.type}`}>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className={`pt-legrail ${p.type}`} />
                      <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                    </div>
                  </td>
                  <td>
                    <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                    <span className="pt-strike-sell" style={{ marginLeft: 6, opacity: 0.8 }}>{isLongOnly ? '—' : p.sellLeg.strike.toLocaleString()}</span>
                  </td>
                  <td><span style={{ fontWeight: 600 }}>${m.toFixed(0)}</span></td>
                  <td>
                    <div className="pt-margin-cell">
                      <span>{((m / (totalMargin || 1)) * 100).toFixed(1)}%</span>
                      <div className="pt-margin-bar"><div className="pt-margin-fill" style={{ width: `${Math.min(100, (m / maxMargin) * 100)}%` }} /></div>
                    </div>
                  </td>
                  <td><span className={`pt-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero'}`}>{pnl > 0 ? '+' : ''}{pnl.toFixed(2)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Workspace shell ───────────────────────────────────────────────────────
export default function TradingWorkspace(props) {
  const { positions, underlying, filteredTradeHistory, isLiveAccount } = props;

  const [tab, setTab] = useState('positions');

  const visible = positions.filter(p => p.underlying === underlying);
  const spreadCount = visible.filter(p => (p.sellQty || 0) > 0).length;
  const longCount = visible.filter(p => (p.sellQty || 0) === 0).length;
  const histCount = filteredTradeHistory.length;

  const TABS = [
    { key: 'positions', label: 'Positions', icon: 'positions', count: spreadCount },
    { key: 'open', label: 'Open Orders', icon: 'open', count: longCount },
    { key: 'stop', label: 'Stop Orders', icon: 'stop', count: spreadCount },
    { key: 'fills', label: 'Fills', icon: 'fills', count: null },
    { key: 'history', label: 'Order History', icon: 'history', count: histCount },
    { key: 'risk', label: 'Risk & Margin', icon: 'risk', count: null },
  ];

  return (
    <div className="pt-tables-container">
      <div className="pt-workspace pt-section">
        <div className="pt-tabbar" role="tablist">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`pt-tab ${tab === t.key ? 'on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
              {t.count != null && <span className="pt-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="pt-workspace-body">
          {tab === 'positions' && (
            <ActivePositionsTable
              positions={props.positions}
              underlying={props.underlying}
              lastEvaluated={props.lastEvaluated}
              fetchSupabaseActivePositions={props.fetchSupabaseActivePositions}
              fetchSupabaseTradeHistory={props.fetchSupabaseTradeHistory}
              fetchHeartbeat={props.fetchHeartbeat}
              now={props.now}
              includeFees={props.includeFees}
              setIncludeFees={props.setIncludeFees}
              spotPrice={props.spotPrice}
              engineStatusColor={props.engineStatusColor}
              engineStatusLabel={props.engineStatusLabel}
              calculatePositionMargin={props.calculatePositionMargin}
              totalMargin={props.totalMargin}
              exitType={props.exitType}
              exitPoints={props.exitPoints}
              onExitPosition={props.onExitPosition}
              embedded
              legFilter="spread"
              title="Open Positions"
              emptyTitle="No Open Positions"
              emptyDesc="Spread positions (long + short legs) appear here. The engine enters them automatically when conditions are met."
            />
          )}

          {tab === 'open' && (
            <ActivePositionsTable
              positions={props.positions}
              underlying={props.underlying}
              lastEvaluated={props.lastEvaluated}
              fetchSupabaseActivePositions={props.fetchSupabaseActivePositions}
              fetchSupabaseTradeHistory={props.fetchSupabaseTradeHistory}
              fetchHeartbeat={props.fetchHeartbeat}
              now={props.now}
              includeFees={props.includeFees}
              setIncludeFees={props.setIncludeFees}
              spotPrice={props.spotPrice}
              engineStatusColor={props.engineStatusColor}
              engineStatusLabel={props.engineStatusLabel}
              calculatePositionMargin={props.calculatePositionMargin}
              totalMargin={props.totalMargin}
              exitType={props.exitType}
              exitPoints={props.exitPoints}
              onExitPosition={props.onExitPosition}
              embedded
              legFilter="long"
              title="Open Orders"
              emptyTitle="No Open Orders"
              emptyDesc="Long-only holdings (short leg already exited, scaling out via the ladder) appear here."
            />
          )}

          {tab === 'stop' && (
            <StopOrdersTab
              positions={props.positions}
              underlying={props.underlying}
              spotPrice={props.spotPrice}
              exitType={props.exitType}
              exitPoints={props.exitPoints}
              onExitPosition={props.onExitPosition}
            />
          )}

          {tab === 'fills' && (
            <EmptyPanel
              icon="fills"
              title="No Fills Yet"
              desc={isLiveAccount
                ? 'Individual leg executions from Delta Exchange appear here as orders fill.'
                : 'Leg-by-leg fills are reported for live accounts. Closed paper trades are summarised under Order History.'}
            />
          )}

          {tab === 'history' && (
            <TradeHistoryTable
              filteredTradeHistory={props.filteredTradeHistory}
              historyFilterDate={props.historyFilterDate}
              setHistoryFilterDate={props.setHistoryFilterDate}
              adjustFilterDay={props.adjustFilterDay}
              resetToToday={props.resetToToday}
              filteredRealizedPnl={props.filteredRealizedPnl}
              filteredWins={props.filteredWins}
              exportCSV={props.exportCSV}
              includeFees={props.includeFees}
              schedules={props.schedules}
              positions={props.positions}
              underlying={props.underlying}
              tradeHistory={props.tradeHistory || []}
              embedded
            />
          )}

          {tab === 'risk' && (
            <RiskMarginTab
              positions={props.positions}
              underlying={props.underlying}
              spotPrice={props.spotPrice}
              totalMargin={props.totalMargin}
              calculatePositionMargin={props.calculatePositionMargin}
              includeFees={props.includeFees}
            />
          )}
        </div>
      </div>
    </div>
  );
}
