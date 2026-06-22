import React from 'react';
import { fmtExpiry } from '../../api';

export default function ActivePositionsTable({
  positions,
  underlying,
  lastEvaluated,
  fetchSupabaseActivePositions,
  fetchSupabaseTradeHistory,
  fetchHeartbeat,
  now,
  includeFees,
  setIncludeFees,
  spotPrice,
  engineStatusColor,
  engineStatusLabel,
  calculatePositionMargin,
  totalMargin,
  exitType = 'ATM',
  exitPoints = 0
}) {

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const getExitTriggerDesc = (p, exitType = 'ATM', exitPoints = 0) => {
    const isCall = p.type === 'call';
    const buyStrike = Number(p.buyLeg.strike);
    let triggerPrice = buyStrike;
    let operator = isCall ? '≥' : '≤';

    if (exitType === 'ITM') {
      triggerPrice = isCall ? buyStrike - exitPoints : buyStrike + exitPoints;
      operator = isCall ? '≥' : '≤';
    } else if (exitType === 'OTM') {
      triggerPrice = isCall ? buyStrike + exitPoints : buyStrike - exitPoints;
      operator = isCall ? '≥' : '≤';
    } else {
      triggerPrice = buyStrike;
      operator = isCall ? '≥' : '≤';
    }

    return {
      text: `${operator} ${triggerPrice.toLocaleString()}`,
      type: exitType
    };
  };

  return (
    <div className="pt-section live">
      <div className="pt-section-header">
        <div className="pt-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
          Active Positions ({underlying})
          <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
        </div>

        <div className="pt-section-controls">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {lastEvaluated > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
                Updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastEvaluated))}
              </div>
            )}
            <button
              onClick={async () => {
                fetchSupabaseActivePositions();
                fetchSupabaseTradeHistory();
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
              {lastEvaluated > 0 ? `${Math.max(0, 30 - Math.round((now - lastEvaluated) / 1000))}s` : ''}
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
            Spot: {spotPrice ? spotPrice.toLocaleString() : '---'}
          </div>

          <div className="pt-live-badge">
            <div className="pt-live-dot" style={{ background: engineStatusColor }} />
            {engineStatusLabel}
          </div>
        </div>
      </div>

      {positions.filter(p => p.underlying === underlying).length === 0 ? (
        <div className="pt-empty">
          <div className="pt-empty-icon scanning">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={engineStatusColor} strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" />
              </path>
            </svg>
          </div>
          <span className="pt-empty-title">No Active Positions</span>
          <span className="pt-empty-desc">The server engine is scanning for entries. Positions appear here automatically when entered.</span>
        </div>
      ) : (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead><tr>
              <th>Position / Ratio</th>
              <th>Expiry</th>
              <th>Strikes (Long/Short)</th>
              <th className="hide-mobile">Entry Spot</th>
              <th>Entry Premium (L/S)</th>
              <th className="hide-mobile">Entry IV (L/S)</th>
              <th>Current Premium (L/S)</th>
              <th className="hide-mobile">Current IV (L/S)</th>
              <th>Unrealized P&L</th>
              <th className="hide-xs">Req. Margin</th>
              <th className="hide-mobile">Duration</th>
            </tr></thead>
            <tbody>
              {positions.filter(p => p.underlying === underlying).map(p => {
                const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
                const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';

                const displayBuyQty = p.buyLeg.lotSize;
                const displaySellQty = p.sellQty;

                const origLot = p.buyLeg?.originalLotSize || p.buyLeg?.lotSize || 1;
                const rawOrigSellQty = p.buyLeg?.originalSellQty !== undefined ? p.buyLeg.originalSellQty : p.sellQty;
                const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;

                return (
                  <tr key={p.id} className={`pt-row-${p.type}`}>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                          {displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}
                        </span>
                        <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                          (Orig 1:{displayOrigSellQty.toFixed(2)})
                        </span>
                      </div>
                    </td>
                    <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(p.expiry)}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                        <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{p.sellLeg.strike.toLocaleString()}</span>
                        <span style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                          Exit: <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{getExitTriggerDesc(p, exitType, exitPoints).text}</span> ({getExitTriggerDesc(p, exitType, exitPoints).type})
                        </span>
                      </div>
                    </td>
                    <td className="hide-mobile"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>{p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                        <span style={{ color: '#f85149' }}>{p.entrySellPrice?.toFixed(2)}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                        <span>{p.entryBuyIv != null ? p.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{p.entrySellIv != null ? p.entrySellIv.toFixed(1) + '%' : '—'}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
                        <span style={{ color: '#f85149' }}>{p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—'}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--accent)' }}>
                        <span>{p.currentBuyIv != null ? p.currentBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{p.currentSellIv != null ? p.currentSellIv.toFixed(1) + '%' : '—'}</span>
                      </div>
                    </td>
                    <td><span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span></td>
                    <td className="hide-xs">
                      <div className="pt-margin-cell">
                        <span>${calculatePositionMargin(p).toFixed(0)}</span>
                        <div className="pt-margin-bar">
                          <div className="pt-margin-fill" style={{ width: `${Math.min(100, (calculatePositionMargin(p) / (totalMargin || 1)) * 100)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="hide-mobile"><span className="pt-duration">{fmtDuration(now - p.entryTime)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
