import React, { useState, useMemo } from 'react';

export default function ResultTable({
  title,
  type,
  results,
  scanning,
  hasLiveFeed,
  tickerCount,
  expectedTickerCount,
  config,
  onRefresh,
  timeRemaining,
  spotPrice,
  lastRefreshed,
  trueAtmStrike,
  tickerData,
  extraCreditMode,
  extraCreditAmountCall,
  extraCreditAmountPut
}) {
  const [expandedStrikes, setExpandedStrikes] = useState({});

  const currentSpot = spotPrice || 0;
  const atmStrike = trueAtmStrike || currentSpot;

  /**
   * Find the best price for a given strike + option type.
   * Falls back to the nearest available strike when an exact match is missing,
   * within a tolerance of 10% of spot price (or 5000 absolute, whichever is larger).
   * Returns null when no suitable ticker exists at all.
   */
  const getTickerPrice = (strike, optType, priceField) => {
    const lowerType = optType.toLowerCase();
    const allTickers = Object.values(tickerData || {}).filter(t => t.type === lowerType);
    if (!allTickers.length) return null;

    // Exact match first
    const exact = allTickers.find(t => t.strike === strike);
    if (exact) {
      const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
      return (val != null && val > 0) ? val : null;
    }

    // Nearest strike fallback - tight tolerance
    const sampleSymbol = allTickers[0]?.symbol || '';
    const isEth = sampleSymbol.includes('ETH');
    const maxTolerance = isEth ? 50 : 500;

    let nearest = null;
    let minDist = Infinity;
    for (const t of allTickers) {
      const dist = Math.abs(t.strike - strike);
      if (dist < minDist && dist <= maxTolerance) {
        minDist = dist;
        nearest = t;
      }
    }
    if (!nearest) return null;
    const val = nearest[priceField] ?? nearest.lastPrice ?? nearest.markPrice;
    return (val != null && val > 0) ? val : null;
  };

  return (
    <div className="scanner-table-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="scanner-table-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="scanner-pulse" data-active={scanning} />
          <span className="scanner-table-title">
            {title} OPPORTUNITIES
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {results.length > 0 && (
            <span className="scanner-match-badge">{results.length} match{results.length !== 1 ? 'es' : ''}</span>
          )}
          <div className="hide-mobile" style={{ fontSize: 12 }}>
            Spot Price: {spotPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          {lastRefreshed > 0 && (
            <div className="hide-xs" style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
              Updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastRefreshed))}
            </div>
          )}
          <button
            onClick={onRefresh}
            disabled={!scanning}
            title="Refresh now"
            style={{
              padding: '4px 8px', fontSize: 12, background: 'var(--bg-card)',
              border: '1px solid var(--border)', color: 'var(--text)',
              borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              minWidth: '50px', justifyContent: 'center'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {scanning && timeRemaining !== null && timeRemaining <= 60 ? `${timeRemaining}s` : ''}
          </button>
        </div>
      </div>

      <div className="scanner-table-body" style={{ flex: 1, overflow: 'auto' }}>
        {!scanning && results.length === 0 && (
          <div className="scanner-empty">
            <div className="scanner-empty-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </div>
            <div className="scanner-empty-title">RATIO SPREAD SCANNER ({type})</div>
            <div className="scanner-empty-desc">
              Configure filters and click START SCANNER to find optimal ratio spread opportunities in real-time.
            </div>
          </div>
        )}

        {scanning && results.length === 0 && (
          <div className="scanner-empty">
            {!hasLiveFeed && <div className="spinner" />}
            <div className="scanner-empty-title" style={{ marginTop: 12 }}>
              {hasLiveFeed ? 'NO MATCHES YET' : 'SCANNING…'}
            </div>
            <div className="scanner-empty-desc">
              {hasLiveFeed
                ? `Live ticker data received. Current filters have not produced a ratio spread match yet.`
                : `Waiting for live ticker data. Matches will appear here once quotes arrive.`}
            </div>
          </div>
        )}

        {results.length > 0 && (
          <table className="scanner-table">
            <thead>
              <tr>
                <th>Strikes</th>
                <th>Prem (B/S)</th>
                <th>Qty (B/S)</th>
                <th>Net/IV</th>
                <th className="hide-mobile">Δ (B/S)</th>
                <th className="hide-mobile" style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>ATM Ask/Bid</th>
                <th style={{ background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>ATM P&L</th>
                <th style={{ borderRight: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Pre-calculate ATM metrics & margins for each result row
                const processedResults = results.map(r => {
                  // Use nearest-available strike when exact ATM is missing
                  const buyIntrinsic = getTickerPrice(atmStrike, type, 'bid');          // null if unavailable
                  const targetSellStrike = type === 'CALL' ? atmStrike + r.strikeDiff : atmStrike - r.strikeDiff;
                  const sellIntrinsic = getTickerPrice(targetSellStrike, type, 'ask'); // null if unavailable
                  const lotSize = r.buyLeg.lotSize || 1;

                  // Only compute P&L when both legs have valid prices
                  const hasAtmData = buyIntrinsic != null && sellIntrinsic != null;

                  // Margin calculation matching paper trading leverage tiers
                  const sellLotSize = r.sellLeg.lotSize || lotSize;

                  const extraCredit = type.toLowerCase() === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
                  const extraQty = extraCreditMode && r.sellPrice > 0
                    ? (Math.round((extraCredit / r.sellPrice) / 0.25) * 0.25)
                    : 0;
                  const totalSellQty = r.sellQty + extraQty;

                  let shortValue = currentSpot * totalSellQty * sellLotSize;

                  let adjustedLotSize = lotSize;
                  let adjustedSellQty = totalSellQty;
                  let scale = 1;

                  if (shortValue >= 200000) {
                    scale = 200000 / shortValue;
                    adjustedLotSize = Number((lotSize * scale).toFixed(2));
                    adjustedSellQty = Number((totalSellQty * scale).toFixed(2));
                    shortValue = 200000;
                  }

                  const leverage = 200; // Fixed leverage as 200

                  // Compute P&L scaled to the adjusted lot size
                  const atAtmPnl = hasAtmData
                    ? ((buyIntrinsic - r.buyPrice) + (r.sellPrice - sellIntrinsic) * totalSellQty) * adjustedLotSize
                    : null;

                  const margin = (r.buyPrice * adjustedLotSize) + (shortValue / leverage);
                  const roi = (atAtmPnl != null && margin > 0) ? (atAtmPnl / margin) * 100 : null;
                  const atmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
                    ? (buyIntrinsic / sellIntrinsic)
                    : null;
                  const roundedAtmRatio = atmRatio != null
                    ? (Math.round(atmRatio / 0.25) * 0.25).toFixed(2)
                    : '—';

                  const rawNetPremium = extraCreditMode 
                    ? ((r.sellPrice * totalSellQty) - r.buyPrice) * scale
                    : r.netPremium;

                  return {
                    ...r,
                    buyLeg: {
                      ...r.buyLeg,
                      lotSize: adjustedLotSize
                    },
                    sellQty: adjustedSellQty,
                    originalSellQty: r.sellQty,
                    originalLotSize: lotSize,
                    netPremium: Number(rawNetPremium).toFixed(2),
                    buyIntrinsic,
                    sellIntrinsic,
                    atAtmPnl,
                    margin,
                    roi,
                    roundedAtmRatio,
                    hasAtmData
                  };
                });

                // Group results by buy strike
                const groups = processedResults.reduce((acc, r) => {
                  const s = r.buyLeg.strike;
                  if (!acc[s]) acc[s] = [];
                  acc[s].push(r);
                  return acc;
                }, {});

                // Sort unique buy strikes by distance to ATM within each option type
                // Calls should be listed ascending from ATM, puts descending from ATM.
                const sortedBuyStrikes = Object.keys(groups)
                  .map(Number)
                  .sort((a, b) => {
                    if (type === 'CALL') return a - b;
                    if (type === 'PUT') return b - a;
                    return a - b;
                  })
                  .map(String);

                // Sort sub-rows within each group by ROI descending
                Object.keys(groups).forEach(strike => {
                  groups[strike].sort((a, b) => b.roi - a.roi);
                });

                let globalRank = 1;

                return sortedBuyStrikes.map((strike) => {
                  const groupRows = groups[strike];
                  const bestRow = groupRows[0];
                  const others = groupRows.slice(1);
                  const isExpanded = !!expandedStrikes[strike];
                  const hasOthers = others.length > 0;

                  const currentRank = globalRank;
                  globalRank++;

                  return (
                    <React.Fragment key={strike}>
                      <tr
                        className={`${currentRank === 1 ? 'scanner-row-best' : ''} ${hasOthers ? 'scanner-row-group' : ''}`}
                        onClick={() => hasOthers && setExpandedStrikes(prev => ({ ...prev, [strike]: !prev[strike] }))}
                        style={{ cursor: hasOthers ? 'pointer' : 'default' }}
                      >
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                            {hasOthers && (
                              <span className={`scanner-group-toggle ${isExpanded ? 'expanded' : ''}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.2s', transform: isExpanded ? 'rotate(0deg)' : 'none' }}>
                                  <polyline points="9 18 15 12 9 6"></polyline>
                                </svg>
                              </span>
                            )}
                            <div>
                              <div>
                                <span className={`scanner-buy`}>
                                  {bestRow.buyLeg.strike.toLocaleString()}
                                </span>
                                /
                                <span className={`scanner-sell`}>
                                  {bestRow.sellLeg.strike.toLocaleString()}
                                </span>
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Δ: {bestRow.strikeDiff.toLocaleString()}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div>
                            <span className="scanner-buy">${bestRow.buyPrice?.toFixed(2)}</span> <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({bestRow.buyIv?.toFixed(1)}%)</span>
                            <br />
                            <span className="scanner-sell">${bestRow.sellPrice?.toFixed(2)}</span> <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({bestRow.sellIv?.toFixed(1)}%)</span>
                          </div>
                        </td>
                        <td style={{ fontWeight: 700 }}>
                          <div>
                            <span className='scanner-buy'>{bestRow.buyLeg.lotSize.toFixed(2)}</span>/
                            <span className='scanner-sell'>{bestRow.sellQty.toFixed(2)}</span>
                          </div>
                          {bestRow.originalSellQty !== undefined && bestRow.originalLotSize !== undefined && (
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 'normal', marginTop: 2 }}>
                              (1:{(Math.round((bestRow.originalSellQty / bestRow.originalLotSize) * 4) / 4).toFixed(2)})
                            </div>
                          )}
                        </td>
                        <td>
                          <div className={parseFloat(bestRow.netPremium) >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontWeight: 700 }}>
                            ${Math.abs(parseFloat(bestRow.netPremium))}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            {bestRow.ivDiff.toFixed(1)}% IV
                          </div>
                        </td>
                        <td className="hide-mobile">
                          <div>
                            <span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                            <span className='scanner-sell'>{bestRow.sellLeg.delta?.toFixed(4)}</span>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            N: {bestRow.deltaDiff.toFixed(4)}
                          </div>
                        </td>

                        <td className="hide-mobile" style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.02)' }}>
                          <div>
                            <div className="scanner-buy">{bestRow.buyIntrinsic != null ? `$${bestRow.buyIntrinsic.toFixed(2)}` : '—'}</div>
                            <div className="scanner-sell">{bestRow.sellIntrinsic != null ? `$${bestRow.sellIntrinsic.toFixed(2)}` : '—'}</div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>1:{bestRow.roundedAtmRatio}</div>
                          </div>
                        </td>
                        <td style={{ background: 'rgba(0, 217, 163, 0.02)', fontWeight: 700 }}>
                          {bestRow.hasAtmData ? (
                            <div>
                              <span className={bestRow.atAtmPnl >= 0 ? 'scanner-buy' : 'scanner-sell'}>
                                {bestRow.atAtmPnl >= 0 ? '+' : ''}${bestRow.atAtmPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                              <div className={bestRow.roi >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontSize: 10, marginTop: 2, fontWeight: 'normal' }}>
                                {bestRow.roi >= 0 ? '+' : ''}{bestRow.roi.toFixed(2)}%
                              </div>
                            </div>
                          ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={{ borderRight: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.02)', fontWeight: 700 }}>
                          ${bestRow.margin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>

                      {isExpanded && others.map((r) => {
                        return (
                          <tr key={`${r.buyLeg.strike}-${r.sellLeg.strike}`} className="scanner-row-sub">
                            <td>
                              <div>
                                <div>
                                  <span className={`scanner-buy`}>
                                    {r.buyLeg.strike.toLocaleString()}
                                  </span>
                                  /
                                  <span className={`scanner-sell`}>
                                    {r.sellLeg.strike.toLocaleString()}
                                  </span>
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Δ: {r.strikeDiff.toLocaleString()}</div>
                              </div>
                            </td>
                            <td>
                              <div>
                                <span className="scanner-buy">${r.buyPrice?.toFixed(2)}</span> <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({r.buyIv?.toFixed(1)}%)</span>
                                <br />
                                <span className="scanner-sell">${r.sellPrice?.toFixed(2)}</span> <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({r.sellIv?.toFixed(1)}%)</span>
                              </div>
                            </td>
                            <td style={{ fontWeight: 700 }}>
                              <div>
                                <span className='scanner-buy'>{r.buyLeg.lotSize.toFixed(2)}</span>/
                                <span className='scanner-sell'>{r.sellQty.toFixed(2)}</span>
                              </div>
                              {r.originalSellQty !== undefined && r.originalLotSize !== undefined && (
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 'normal', marginTop: 2 }}>
                                  (1:{(Math.round((r.originalSellQty / r.originalLotSize) * 4) / 4).toFixed(2)})
                                </div>
                              )}
                            </td>
                            <td>
                              <div className={parseFloat(r.netPremium) >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontWeight: 700 }}>
                                ${Math.abs(parseFloat(r.netPremium))}
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                {r.ivDiff.toFixed(1)}% IV
                              </div>
                            </td>
                            <td className="hide-mobile">
                              <div>
                                <span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                                <span className='scanner-sell'>{r.sellLeg.delta?.toFixed(4)}</span>
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                N: {r.deltaDiff.toFixed(4)}
                              </div>
                            </td>

                            <td className="hide-mobile" style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.01)' }}>
                              <div>
                                <div className="scanner-buy">{r.buyIntrinsic != null ? `$${r.buyIntrinsic.toFixed(2)}` : '—'}</div>
                                <div className="scanner-sell">{r.sellIntrinsic != null ? `$${r.sellIntrinsic.toFixed(2)}` : '—'}</div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>1:{r.roundedAtmRatio}</div>
                              </div>
                            </td>
                            <td style={{ background: 'rgba(0, 217, 163, 0.01)', fontWeight: 700 }}>
                              {r.hasAtmData ? (
                                <div>
                                  <span className={r.atAtmPnl >= 0 ? 'scanner-buy' : 'scanner-sell'}>
                                    {r.atAtmPnl >= 0 ? '+' : ''}${r.atAtmPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </span>
                                  <div className={r.roi >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontSize: 10, marginTop: 2, fontWeight: 'normal' }}>
                                    {r.roi >= 0 ? '+' : ''}{r.roi.toFixed(2)}%
                                  </div>
                                </div>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ borderRight: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.01)', fontWeight: 700 }}>
                              ${r.margin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                });
              })()}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
