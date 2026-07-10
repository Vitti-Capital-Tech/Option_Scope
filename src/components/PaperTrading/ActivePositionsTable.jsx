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
  embedded = false,
  legFilter = 'all',          // 'all' | 'spread' | 'long'
  title = 'Open Positions',
  emptyTitle = 'No Active Positions',
  emptyDesc = 'The server engine is scanning for entries. Positions appear here automatically when entered.'
}) {

  const [sortKey, setSortKey] = useState('none');

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  // Trader-friendly instrument label, e.g. "BTC-CALL 64,000/100,000" (or single
  // strike for a long-only leg). Full strike numbers, not k-notation.
  const kStrike = (s) => Number(s).toLocaleString();
  const instrumentName = (p) => {
    const base = `${p.underlying}-${p.type.toUpperCase()}`;
    return (p.sellQty || 0) === 0
      ? `${base} ${kStrike(p.buyLeg.strike)}`
      : `${base} ${kStrike(p.buyLeg.strike)}/${kStrike(p.sellLeg.strike)}`;
  };

  // A long/short value pair, stacked vertically (long on top green, short below
  // red) to keep columns narrow. Dimmed variant for secondary values like IV.
  const legStack = (l, s, { longOnly = false, dim = false } = {}) => (
    <div className={`pt-legstack${dim ? ' dim' : ''}`}>
      <span className="pt-ls-l">{l ?? '—'}</span>
      <span className="pt-ls-s">{longOnly ? '—' : (s ?? '—')}</span>
    </div>
  );

  const secsSinceEval = lastEvaluated > 0 ? Math.max(0, Math.round((now - lastEvaluated) / 1000)) : null;
  const isStale = secsSinceEval != null && secsSinceEval > 30;

  // Proximity of live spot to the exit trigger (0 = at entry, 100 = trigger hit).
  const exitMeter = (p) => {
    const isCall = p.type === 'call';
    const buyStrike = Number(p.buyLeg.strike);
    let triggerPrice = buyStrike;
    // ITM/OTM direction reversed per exit convention: ITM = strike − pts (call) / + pts (put);
    // OTM = strike + pts (call) / − pts (put).
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

  const matchesLeg = (p) => legFilter === 'all'
    ? true
    : legFilter === 'long' ? (p.sellQty || 0) === 0 : (p.sellQty || 0) > 0;
  const visiblePositions = positions.filter(p => p.underlying === underlying && matchesLeg(p));
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
      // Reversed convention: ITM = strike − pts (call) / + pts (put).
      triggerPrice = isCall ? buyStrike - exitPoints : buyStrike + exitPoints;
      operator = isCall ? '≥' : '≤';
    } else if (exitType === 'OTM') {
      // Reversed convention: OTM = strike + pts (call) / − pts (put).
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
          {title} · {underlying}
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

      {visiblePositions.length === 0 ? (
        <div className="pt-empty">
          <div className="pt-empty-icon scanning">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={engineStatusColor} strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" />
              </path>
            </svg>
          </div>
          <span className="pt-empty-title">{emptyTitle}</span>
          <span className="pt-empty-desc">{emptyDesc}</span>
        </div>
      ) : (
        <div className="pt-table-scroll">
          <table className="pt-table pt-lean">
            <thead><tr>
              <th>Position</th>
              <th>Strikes<span className="pt-th-sub">spot</span></th>
              <th>Entry<span className="pt-th-sub">prem · iv</span></th>
              <th>Mark<span className="pt-th-sub">prem · iv</span></th>
              <th>Dist. to Exit</th>
              {legFilter !== 'spread' && <th>Scale-Out</th>}
              <th>Unrealized P&L</th>
              <th>Margin</th>
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

                // ── Original & initial-scaled ratios ──
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

                const ivText = (b, s) => `${b != null ? b.toFixed(1) : '—'}/${(isLongOnly || s == null) ? '—' : s.toFixed(1)}`;

                return (
                  <tr key={p.id} className={`pt-row-${p.type}`}>
                    {/* Position: instrument + tag + expiry + ratio/init sub-lines */}
                    <td>
                      <div className="pt-pos-cell">
                        <span className={`pt-legrail ${p.type}`} />
                        <div className="pt-pos-id">
                          <span className="pt-instrument">{instrumentName(p)}</span>
                          <span className="pt-pos-meta">
                            <span className={`pt-type-badge ${isLongOnly ? 'long' : p.type}`}>{isLongOnly ? 'LONG ONLY' : p.type.toUpperCase()}</span>
                            <span className="pt-pos-note">{isLongOnly ? '· short exited' : 'spread'} · {fmtExpiry(p.expiry)}</span>
                          </span>
                          <span className="pt-cell-sub">
                            ratio <b>{displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}</b> · orig 1:{displayOrigSellQty.toFixed(2)} · init {initBuyQty.toFixed(2)}L/{initSellQty.toFixed(2)}S
                          </span>
                        </div>
                      </div>
                    </td>
                    {/* Strikes (stacked) + entry spot */}
                    <td>
                      {legStack(p.buyLeg.strike.toLocaleString(), isLongOnly ? null : p.sellLeg.strike.toLocaleString(), { longOnly: isLongOnly })}
                      <span className="pt-cell-sub">spot {p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span>
                    </td>
                    {/* Entry premium (stacked) + entry IV */}
                    <td>
                      {legStack(p.entryBuyPrice != null ? p.entryBuyPrice.toFixed(2) : null, p.entrySellPrice != null ? p.entrySellPrice.toFixed(2) : null, { longOnly: isLongOnly })}
                      <span className="pt-cell-sub">iv {ivText(p.entryBuyIv, p.entrySellIv)}</span>
                    </td>
                    {/* Mark premium (stacked) + mark IV */}
                    <td>
                      {legStack(p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : null, p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : null, { longOnly: isLongOnly })}
                      <span className="pt-cell-sub">iv {ivText(p.currentBuyIv, p.currentSellIv)}</span>
                    </td>
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
                    {legFilter !== 'spread' && (
                      <td>
                        {showLadder ? (
                          <div className="pt-scaleout"
                            title={`Scale-out ${ladderStage}/${exitLevels.length} · entry $${Number(p.entryBuyPrice).toFixed(2)}${nextLevel != null ? ` · next $${Number(nextLevel).toFixed(2)}` : ''} · now ${p.currentBuyPrice != null ? `$${p.currentBuyPrice.toFixed(2)}` : '—'}${rangeTop != null ? ` · range top $${Number(rangeTop).toFixed(2)}` : ''}`}>
                            <div className="pt-rungs">
                              {exitLevels.map((lvl, i) => (
                                <span key={i} className={`pt-rung ${i < ladderStage ? 'hit' : i === ladderStage ? 'next' : ''}`} />
                              ))}
                            </div>
                            <span className="pt-cell-sub">
                              {ladderStage}/{exitLevels.length} slices{nextLevel != null ? ` · next $${Number(nextLevel).toFixed(2)}` : ''}
                            </span>
                          </div>
                        ) : (
                          <span className="pt-mono pt-dim">—</span>
                        )}
                      </td>
                    )}
                    <td>
                      <div className="pt-pnlcell">
                        <span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span>
                        <span className="pt-roibar"><i style={{ width: `${pnlPct}%`, background: pnlValue >= 0 ? 'var(--call)' : 'var(--put)' }} /></span>
                      </div>
                    </td>
                    <td><span className="pt-margin-val">${calculatePositionMargin(p).toFixed(0)}</span></td>
                    <td>
                      <span className="pt-duration">{fmtDuration(now - p.entryTime)}</span>
                      <span className="pt-cell-sub">{formatDateTime(p.entryTime)}</span>
                    </td>
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
