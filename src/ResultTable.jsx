import React, { useState, useMemo, useCallback } from 'react';
import { RefreshCw, Target, ChevronRight } from 'lucide-react';

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
  spotPrice,
  lastRefreshed,
  trueAtmStrike,
  tickerData
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
  const getTickerPrice = useCallback((strike, optType, priceField) => {
    const lowerType = optType.toLowerCase();
    const allTickers = Object.values(tickerData || {}).filter(t => t.type === lowerType);
    if (!allTickers.length) return null;

    // Exact match first
    const exact = allTickers.find(t => t.strike === strike);
    if (exact) {
      const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
      return (val != null && val > 0) ? val : null;
    }

    // The requested strike isn't listed (a "weird" ATM ± diff can land between two grid
    // strikes). BRACKET it: take the nearest listed strike BELOW and the nearest ABOVE
    // (within tolerance) and AVERAGE their prices as a midpoint estimate — matches the
    // scanner's scanTickers getTickerPrice and the engine, so the shown ATM P&L/ratio
    // aligns. If only one side exists within tolerance, fall back to it.
    const sampleSymbol = allTickers[0]?.symbol || '';
    const isEth = sampleSymbol.includes('ETH');
    const maxTolerance = isEth ? 50 : 1000;
    const priceOf = (t) => {
      if (!t) return null;
      const v = t[priceField] ?? t.lastPrice ?? t.markPrice;
      return (v != null && v > 0) ? v : null;
    };
    let below = null, belowDist = Infinity;
    let above = null, aboveDist = Infinity;
    for (const t of allTickers) {
      const d = t.strike - strike;
      if (d < 0 && -d <= maxTolerance && -d < belowDist) { belowDist = -d; below = t; }
      if (d > 0 && d <= maxTolerance && d < aboveDist) { aboveDist = d; above = t; }
    }
    const pBelow = priceOf(below);
    const pAbove = priceOf(above);
    if (pBelow != null && pAbove != null) return (pBelow + pAbove) / 2;
    return pBelow ?? pAbove;
  }, [tickerData]);

  const filteredResults = useMemo(() => {
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

      const { atmRatioScaling } = config || {};

      const atmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
        ? (buyIntrinsic / sellIntrinsic)
        : null;
      const roundedAtmRatio = atmRatio != null
        ? (Math.round(atmRatio / 0.25) * 0.25).toFixed(2)
        : '—';

      // Scaling now happens in the scanner (before the max-debit filter);
      // consume the scaled qty directly instead of recomputing it here.
      const totalSellQty = r.scaledSellQty ?? r.sellQty;

      let shortValue = currentSpot * totalSellQty * sellLotSize;

      let adjustedLotSize = lotSize;
      let adjustedSellQty = totalSellQty;
      let scale = 1;

      if (shortValue >= 195000) {
        scale = 195000 / shortValue;
        adjustedLotSize = Number((lotSize * scale).toFixed(2));
        adjustedSellQty = Number((totalSellQty * scale).toFixed(2));
        shortValue = 195000;
      }

      const leverage = 200; // Fixed leverage as 200

      // Compute P&L scaled to the adjusted lot size
      const atAtmPnl = hasAtmData
        ? ((buyIntrinsic - r.buyPrice) + (r.sellPrice - sellIntrinsic) * totalSellQty) * adjustedLotSize
        : null;

      const margin = (r.buyPrice * adjustedLotSize) + (shortValue / leverage);
      const roi = (atAtmPnl != null && margin > 0) ? (atAtmPnl / margin) * 100 : null;

      // Net premium is computed in the scanner from the scaled qty.
      const rawNetPremium = r.netPremium;

      const isRatioChanged = atmRatioScaling && totalSellQty !== r.sellQty;

      return {
        ...r,
        buyLeg: {
          ...r.buyLeg,
          lotSize: adjustedLotSize
        },
        sellQty: adjustedSellQty,
        originalSellQty: totalSellQty,
        originalLotSize: lotSize,
        naturalSellQty: r.sellQty,
        isRatioChanged,
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

    // ATM Edge (P&L) floors — only active alongside Dynamic ATM Scaling (the
    // inputs live in that section). Drop spreads whose at-ATM P&L or ROI falls
    // below the configured minimums. Rows without ATM data (P&L/ROI unknowable)
    // are left in and shown as "—" rather than hidden on transient missing quotes.
    const minAtmPnl = Number(config?.minAtmPnl) || 0;
    const minAtmRoi = Number(config?.minAtmRoi) || 0;
    return processedResults.filter(r =>
      !r.hasAtmData || (r.atAtmPnl >= minAtmPnl && r.roi >= minAtmRoi)
    );
  }, [results, getTickerPrice, atmStrike, type, config, currentSpot]);

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
          {filteredResults.length > 0 && (
            <span className="scanner-match-badge">{filteredResults.length} match{filteredResults.length !== 1 ? 'es' : ''}</span>
          )}
          <div style={{ fontSize: 12 }}>
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
            <RefreshCw size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="scanner-table-body" style={{ flex: 1, overflow: 'auto' }}>
        {!scanning && filteredResults.length === 0 && (
          <div className="scanner-empty">
            <div className="scanner-empty-icon" aria-hidden="true">
              <Target size={28} strokeWidth={1.8} />
            </div>
            <div className="scanner-empty-title">RATIO SPREAD SCANNER ({type})</div>
            <div className="scanner-empty-desc">
              Configure filters and click START SCANNER to find optimal ratio spread opportunities in real-time.
            </div>
          </div>
        )}

        {scanning && filteredResults.length === 0 && (
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

        {filteredResults.length > 0 && (
          <table className="scanner-table">
            <thead>
              <tr>
                <th>Spread Strikes</th>
                <th>Premium (L/S)</th>
                <th>Ratio (L/S)</th>
                <th>Net Premium & IV Edge</th>
                <th className="hide-mobile">Delta (L/S)</th>
                <th style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>ATM Pricing</th>
                <th style={{ background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>ATM Edge (P&L)</th>
                <th style={{ borderRight: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>Req. Margin</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Group results by buy strike
                const groups = filteredResults.reduce((acc, r) => {
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
                                <ChevronRight size={12} strokeWidth={3} />
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
                            <div style={{ fontSize: '9px', color: bestRow.isRatioChanged ? 'var(--accent)' : 'var(--text)', fontWeight: 'normal', marginTop: 2 }}>
                              {bestRow.isRatioChanged
                                ? `(1:${(Math.round((bestRow.naturalSellQty / bestRow.originalLotSize) * 4) / 4).toFixed(2)} → 1:${(Math.round((bestRow.originalSellQty / bestRow.originalLotSize) * 4) / 4).toFixed(2)})`
                                : `(1:${(Math.round((bestRow.originalSellQty / bestRow.originalLotSize) * 4) / 4).toFixed(2)})`
                              }
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

                        <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.02)' }}>
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
                                <div style={{ fontSize: '9px', color: r.isRatioChanged ? 'var(--accent)' : 'var(--text)', fontWeight: 'normal', marginTop: 2 }}>
                                  {r.isRatioChanged
                                    ? `(1:${(Math.round((r.naturalSellQty / r.originalLotSize) * 4) / 4).toFixed(2)} → 1:${(Math.round((r.originalSellQty / r.originalLotSize) * 4) / 4).toFixed(2)})`
                                    : `(1:${(Math.round((r.originalSellQty / r.originalLotSize) * 4) / 4).toFixed(2)})`
                                  }
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

                            <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.01)' }}>
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
