import React, { useState } from 'react';
import { fmtExpiry } from '../../api';
import CustomSelect from '../common/CustomSelect';

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
  exitPoints = 0,
  onExitPosition,
  embedded = false
}) {

  const [sortKey, setSortKey] = useState('none');

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const secsSinceEval = lastEvaluated > 0 ? Math.max(0, Math.round((now - lastEvaluated) / 1000)) : null;
  const isStale = secsSinceEval != null && secsSinceEval > 30;

  // Proximity of live spot to the exit trigger (0 = at entry, 100 = trigger hit).
  const exitMeter = (p) => {
    const isCall = p.type === 'call';
    const buyStrike = Number(p.buyLeg.strike);
    let triggerPrice = buyStrike;
    if (exitType === 'ITM') triggerPrice = isCall ? buyStrike - exitPoints : buyStrike + exitPoints;
    else if (exitType === 'OTM') triggerPrice = isCall ? buyStrike + exitPoints : buyStrike - exitPoints;
    const entrySpot = p.entrySpotPrice || spotPrice || triggerPrice;
    const liveSpot = spotPrice || entrySpot;
    const towardTrigger = isCall ? (liveSpot - entrySpot) : (entrySpot - liveSpot);
    const fullSpan = isCall ? (triggerPrice - entrySpot) : (entrySpot - triggerPrice);
    const distPct = fullSpan > 0
      ? Math.max(0, Math.min(100, (towardTrigger / fullSpan) * 100))
      : (towardTrigger >= 0 ? 100 : 0);
    return { triggerPrice, distPct, away: Math.abs(triggerPrice - liveSpot) };
  };

  const pnlOf = (p) => (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0));

  const visiblePositions = positions.filter(p => p.underlying === underlying);
  const sortedPositions = [...visiblePositions];
  if (sortKey === 'pnl') sortedPositions.sort((a, b) => pnlOf(b) - pnlOf(a));
  else if (sortKey === 'margin') sortedPositions.sort((a, b) => calculatePositionMargin(b) - calculatePositionMargin(a));
  else if (sortKey === 'exit') sortedPositions.sort((a, b) => exitMeter(b).distPct - exitMeter(a).distPct);

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
    <div className={embedded ? 'pt-embedded live' : 'pt-section live'}>
      <div className={`pt-section-header${embedded ? ' pt-embedded-header' : ''}`}>
        {!embedded && (
          <div className="pt-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
            Active Positions ({underlying})
            <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
          </div>
        )}

        <div className="pt-section-controls">
          <div className={`pt-statusbar ${isStale ? 'stale' : ''}`}>
            <span className="pt-status-live">
              <span className="pt-status-pulse" style={{ background: engineStatusColor }} />
              {engineStatusLabel}
            </span>
            {secsSinceEval != null && (
              <>
                <span className="pt-status-sep" />
                <span className="pt-status-fresh" title="Time since last engine evaluation">
                  last tick <b>{secsSinceEval}s</b> ago{isStale ? ' · stale' : ''}
                </span>
              </>
            )}
            <span className="pt-status-sep" />
            <span className="pt-status-spot">Spot <b>{spotPrice ? spotPrice.toLocaleString() : '---'}</b></span>
            <button
              onClick={async () => {
                fetchSupabaseActivePositions();
                fetchSupabaseTradeHistory();
                fetchHeartbeat();
              }}
              title="Refresh now"
              className="pt-status-refresh"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" />
              </svg>
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
        <>
        <div className="pt-table-toolbar">
          <div className="pt-sort">
            <span>Sort</span>
            <CustomSelect
              variant="inline"
              className="pt-sort-select"
              value={sortKey}
              onChange={setSortKey}
              options={[
                { label: 'Default', value: 'none' },
                { label: 'Unrealized P&L', value: 'pnl' },
                { label: 'Closest to exit', value: 'exit' },
                { label: 'Margin', value: 'margin' }
              ]}
            />
          </div>
        </div>
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
              <th>Actions</th>
            </tr></thead>
            <tbody>
              {sortedPositions.map(p => {
                const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
                const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';

                const displayBuyQty = p.buyLeg.lotSize;
                const displaySellQty = p.sellQty;
                const isLongOnly = (p.sellQty || 0) === 0;

                const origLot = p.buyLeg?.originalLotSize || p.buyLeg?.lotSize || 1;
                const rawOrigSellQty = p.buyLeg?.originalSellQty !== undefined ? p.buyLeg.originalSellQty : p.sellQty;
                const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;

                const initBuyQty = p.buyLeg?.initialScaledLotSize ?? p.buyLeg?.lotSize ?? 0;
                const initSellQty = p.buyLeg?.initialScaledLotSize !== undefined && p.buyLeg?.originalSellQty !== undefined
                  ? (p.buyLeg.initialScaledLotSize * p.buyLeg.originalSellQty)
                  : p.sellQty;

                // ── Distance-to-exit meter (spot vs the buy-strike trigger) ──
                const { distPct, away } = exitMeter(p);
                const distNear = distPct >= 85;
                const liveSpot = spotPrice || p.entrySpotPrice || 0;

                // ── P&L bar (magnitude relative to margin) ──
                const posMargin = calculatePositionMargin(p);
                const pnlPct = Math.max(0, Math.min(100, (Math.abs(pnlValue) / (posMargin || 1)) * 100));

                // ── Long-only scale-out ladder ──
                const exitLevels = Array.isArray(p.buyLeg?.longExitLevels) ? p.buyLeg.longExitLevels : [];
                const ladderStage = p.buyLeg?.longExitStage || 0;
                const nextLevel = exitLevels[ladderStage];
                const rangeTop = exitLevels[exitLevels.length - 1];
                const showLadder = isLongOnly && exitLevels.length > 0;

                return (
                  <React.Fragment key={p.id}>
                  <tr className={`pt-row-${p.type}`}>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span className={`pt-legrail ${isLongOnly ? 'long' : p.type}`} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                          {isLongOnly ? (
                            <>
                              <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.3px' }}>LONG ONLY</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {displayBuyQty.toFixed(2)} long
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                Init: {initBuyQty.toFixed(2)}L / {initSellQty.toFixed(2)}S
                              </span>
                            </>
                          ) : (
                            <>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                (Orig 1:{displayOrigSellQty.toFixed(2)})
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                Init: {initBuyQty.toFixed(2)}L / {initSellQty.toFixed(2)}S
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                    <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(p.expiry)}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                        <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{isLongOnly ? '—' : p.sellLeg.strike.toLocaleString()}</span>
                        <div className="pt-dist" title={`Spot ${liveSpot.toLocaleString()} · exits ${getExitTriggerDesc(p, exitType, exitPoints).text}`}>
                          <div className="pt-dist-top">
                            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{getExitTriggerDesc(p, exitType, exitPoints).text}</span>
                            <span>{Math.round(away).toLocaleString()} away</span>
                          </div>
                          <div className="pt-track">
                            <i className={distNear ? 'near' : ''} style={{ width: `${distPct}%` }} />
                            <span className="pt-track-mk" style={{ left: `${distPct}%` }} />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hide-mobile"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>{p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                        <span style={{ color: '#f85149' }}>{isLongOnly ? '—' : p.entrySellPrice?.toFixed(2)}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                        <span>{p.entryBuyIv != null ? p.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{isLongOnly ? '—' : (p.entrySellIv != null ? p.entrySellIv.toFixed(1) + '%' : '—')}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
                        <span style={{ color: '#f85149' }}>{isLongOnly ? '—' : (p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—')}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--accent)' }}>
                        <span>{p.currentBuyIv != null ? p.currentBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{isLongOnly ? '—' : (p.currentSellIv != null ? p.currentSellIv.toFixed(1) + '%' : '—')}</span>
                      </div>
                    </td>
                    <td>
                      <div className="pt-pnlcell">
                        <span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span>
                        <span className="pt-roibar"><i style={{ width: `${pnlPct}%`, background: pnlValue >= 0 ? 'var(--call)' : 'var(--put)' }} /></span>
                      </div>
                    </td>
                    <td className="hide-xs">
                      <div className="pt-margin-cell">
                        <span>${calculatePositionMargin(p).toFixed(0)}</span>
                        <div className="pt-margin-bar">
                          <div className="pt-margin-fill" style={{ width: `${Math.min(100, (calculatePositionMargin(p) / (totalMargin || 1)) * 100)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="hide-mobile"><span className="pt-duration">{fmtDuration(now - p.entryTime)}</span></td>
                    <td>
                      <button
                        onClick={() => onExitPosition(p)}
                        className="pt-btn-exit-pos"
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          background: 'rgba(248, 81, 73, 0.15)',
                          border: '1px solid rgba(248, 81, 73, 0.3)',
                          color: '#f85149',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 600,
                          transition: 'all 0.2s ease',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        Exit
                      </button>
                    </td>
                  </tr>
                  {showLadder && (
                    <tr className="pt-ladder-row">
                      <td colSpan={12}>
                        <div className="pt-ladder">
                          <div className="pt-ladder-head">
                            <span className="pt-ladder-title">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20h16M7 16V8M12 16V4M17 16v-6" /></svg>
                              Long scale-out ladder
                            </span>
                            <span className="pt-ladder-count">{ladderStage} / {exitLevels.length} slices exited</span>
                          </div>
                          <div className="pt-rungs">
                            {exitLevels.map((lvl, i) => (
                              <span
                                key={i}
                                className={`pt-rung ${i < ladderStage ? 'hit' : i === ladderStage ? 'next' : ''}`}
                                title={`Level ${i + 1}: $${Number(lvl).toFixed(2)}${i < ladderStage ? ' — exited' : i === ladderStage ? ' — next' : ''}`}
                              />
                            ))}
                          </div>
                          <div className="pt-ladder-meta">
                            <span>entry <b>${Number(p.entryBuyPrice).toFixed(2)}</b></span>
                            {nextLevel != null && <span>next level <b style={{ color: 'var(--accent)' }}>${Number(nextLevel).toFixed(2)}</b></span>}
                            <span>now <b>{p.currentBuyPrice != null ? `$${p.currentBuyPrice.toFixed(2)}` : '—'}</b></span>
                            {rangeTop != null && <span>range top <b>${Number(rangeTop).toFixed(2)}</b></span>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
