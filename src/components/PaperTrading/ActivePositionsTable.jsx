import React, { useState } from 'react';
import { fmtExpiry } from '../../api';
import { formatDateTime } from '../../scannerUtils';
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

  // Trader-friendly instrument label, e.g. "BTC-CALL 98k/100k" (or single strike
  // for a long-only leg). Strikes shown in k-notation to keep it compact.
  const kStrike = (s) => `${Number((Number(s) / 1000).toFixed(2))}k`;
  const instrumentName = (p) => {
    const base = `${p.underlying}-${p.type.toUpperCase()}`;
    return (p.sellQty || 0) === 0
      ? `${base} ${kStrike(p.buyLeg.strike)}`
      : `${base} ${kStrike(p.buyLeg.strike)}/${kStrike(p.sellLeg.strike)}`;
  };

  // A "long / short" value pair, coloured green/red (or dimmed for IV).
  const legPair = (l, s, { longOnly = false, dim = false } = {}) => (
    <span className={`pt-ls${dim ? ' dim' : ''}`}>
      <span className="pt-ls-l">{l ?? '—'}</span>
      <span className="pt-ls-sep">/</span>
      <span className="pt-ls-s">{longOnly ? '—' : (s ?? '—')}</span>
    </span>
  );

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
      <div className={`pt-section-header pt-pos-header${embedded ? ' pt-embedded-header' : ''}`}>
        <div className="pt-section-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
          Open Positions · {underlying}
          <span className="pt-section-count">{visiblePositions.length}</span>
        </div>

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

          <div className="pt-gn-toggle" role="group" aria-label="P&L basis">
            <span className={`pt-gn-opt ${!includeFees ? 'on' : ''}`} onClick={() => setIncludeFees(false)}>Gross</span>
            <span className="pt-gn-sep">/</span>
            <span className={`pt-gn-opt ${includeFees ? 'on' : ''}`} onClick={() => setIncludeFees(true)}>Net</span>
          </div>

          {visiblePositions.length > 0 && (
            <div className="pt-sort">
              <span>Sort:</span>
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
          )}
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
          <table className="pt-table pt-lean">
            <thead><tr>
              <th>Position</th>
              <th>Ratio (L/S)</th>
              <th>Init. Ratio</th>
              <th>Init. Scaled (L/S)</th>
              <th>Expiry</th>
              <th>Strikes L/S</th>
              <th>Entry Spot</th>
              <th>Entry Prem.</th>
              <th>Entry IV (L/S)</th>
              <th>Mark Prem.</th>
              <th>Mark IV (L/S)</th>
              <th>Dist. to Exit</th>
              <th>Scale-Out</th>
              <th>Unrealized P&L</th>
              <th>Margin</th>
              <th>Entry Time</th>
              <th>Age</th>
              <th></th>
            </tr></thead>
            <tbody>
              {sortedPositions.map(p => {
                const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
                const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';

                const displayBuyQty = p.buyLeg.lotSize;
                const displaySellQty = p.sellQty;
                const isLongOnly = (p.sellQty || 0) === 0;

                // ── Original & initial-scaled ratios (shown in the detail drawer) ──
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
                  <tr key={p.id} className={`pt-row-${p.type}`}>
                    <td>
                      <div className="pt-pos-cell">
                        <span className={`pt-legrail ${isLongOnly ? 'long' : p.type}`} />
                        <div className="pt-pos-id">
                          <span className="pt-instrument">{instrumentName(p)}</span>
                          <span className="pt-pos-meta">
                            {isLongOnly ? (
                              <>
                                <span className="pt-type-badge long">LONG ONLY</span>
                                <span className="pt-pos-note">· short exited</span>
                              </>
                            ) : (
                              <>
                                <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                                <span className="pt-pos-note">spread</span>
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>{legPair(displayBuyQty.toFixed(2), displaySellQty.toFixed(2), { longOnly: isLongOnly })}</td>
                    <td><span className="pt-mono pt-dim">1:{displayOrigSellQty.toFixed(2)}</span></td>
                    <td>{legPair(initBuyQty.toFixed(2), initSellQty.toFixed(2))}</td>
                    <td><span className="pt-mono">{fmtExpiry(p.expiry)}</span></td>
                    <td>{legPair(p.buyLeg.strike.toLocaleString(), isLongOnly ? null : p.sellLeg.strike.toLocaleString(), { longOnly: isLongOnly })}</td>
                    <td><span className="pt-mono pt-dim">{p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span></td>
                    <td>{legPair(p.entryBuyPrice != null ? p.entryBuyPrice.toFixed(2) : null, p.entrySellPrice != null ? p.entrySellPrice.toFixed(2) : null, { longOnly: isLongOnly })}</td>
                    <td>{legPair(p.entryBuyIv != null ? p.entryBuyIv.toFixed(1) : null, p.entrySellIv != null ? p.entrySellIv.toFixed(1) : null, { longOnly: isLongOnly, dim: true })}</td>
                    <td>{legPair(p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : null, p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : null, { longOnly: isLongOnly })}</td>
                    <td>{legPair(p.currentBuyIv != null ? p.currentBuyIv.toFixed(1) : null, p.currentSellIv != null ? p.currentSellIv.toFixed(1) : null, { longOnly: isLongOnly, dim: true })}</td>
                    <td>
                      <div className="pt-dist" title={`Spot ${liveSpot.toLocaleString()} vs exit ${getExitTriggerDesc(p, exitType, exitPoints).text} (${exitType})`}>
                        <span className="pt-dist-trigger">{getExitTriggerDesc(p, exitType, exitPoints).text}</span>
                        <div className="pt-track">
                          <i className={distNear ? 'near' : ''} style={{ width: `${distPct}%` }} />
                          <span className="pt-track-mk" style={{ left: `${distPct}%` }} />
                        </div>
                        <span className="pt-dist-away">spot {liveSpot.toLocaleString()} · {Math.round(away).toLocaleString()} away</span>
                      </div>
                    </td>
                    <td>
                      {showLadder ? (
                        <div className="pt-scaleout"
                          title={`Scale-out ${ladderStage}/${exitLevels.length} · entry $${Number(p.entryBuyPrice).toFixed(2)}${nextLevel != null ? ` · next $${Number(nextLevel).toFixed(2)}` : ''} · now ${p.currentBuyPrice != null ? `$${p.currentBuyPrice.toFixed(2)}` : '—'}${rangeTop != null ? ` · range top $${Number(rangeTop).toFixed(2)}` : ''}`}>
                          <div className="pt-rungs">
                            {exitLevels.map((lvl, i) => (
                              <span key={i} className={`pt-rung ${i < ladderStage ? 'hit' : i === ladderStage ? 'next' : ''}`} />
                            ))}
                          </div>
                          <span className="pt-dist-away">
                            {ladderStage} / {exitLevels.length} slices{nextLevel != null ? ` · next $${Number(nextLevel).toFixed(2)}` : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="pt-mono pt-dim">—</span>
                      )}
                    </td>
                    <td>
                      <div className="pt-pnlcell">
                        <span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span>
                        <span className="pt-roibar"><i style={{ width: `${pnlPct}%`, background: pnlValue >= 0 ? 'var(--call)' : 'var(--put)' }} /></span>
                      </div>
                    </td>
                    <td><span className="pt-margin-val">${calculatePositionMargin(p).toFixed(0)}</span></td>
                    <td><span className="pt-mono pt-dim">{formatDateTime(p.entryTime)}</span></td>
                    <td><span className="pt-duration">{fmtDuration(now - p.entryTime)}</span></td>
                    <td>
                      <button onClick={() => onExitPosition(p)} className="pt-btn-close">Close</button>
                    </td>
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
