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
  tickerData
}) {
  const [expandedStrikes, setExpandedStrikes] = useState({});

  const currentSpot = spotPrice || 0;
  const atmStrike = trueAtmStrike || currentSpot;

  const getTickerPrice = (strike, optType, priceField) => {
    const lowerType = optType.toLowerCase();
    const ticker = Object.values(tickerData || {}).find(
      t => t.strike === strike && t.type === lowerType
    );
    if (!ticker) return 0;
    return ticker[priceField] ?? ticker.markPrice ?? 0;
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
          <div style={{ fontSize: 12 }}>
            Spot Price: {spotPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          {lastRefreshed > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
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
                <th>Buy/Sell Strikes</th>
                <th>Strike Δ</th>
                <th>Buy Prem</th>
                <th>Sell Prem</th>
                <th>Buy/Sell Qty</th>
                <th>Net Prem</th>
                <th>IV Diff</th>
                <th>Buy Δ / Sell Δ</th>
                <th>Net Δ</th>
                <th style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>At ATM Ask/Bid</th>
                <th style={{ background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>At ATM P&L</th>
                <th style={{ borderRight: '1px solid rgba(0, 217, 163, 0.2)', background: 'rgba(0, 217, 163, 0.04)', color: 'var(--accent)' }}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Pre-calculate ATM metrics & margins for each result row
                const processedResults = results.map(r => {
                  const buyIntrinsic = getTickerPrice(atmStrike, type, 'bid');
                  const targetSellStrike = type === 'CALL' ? atmStrike + r.strikeDiff : atmStrike - r.strikeDiff;
                  const sellIntrinsic = getTickerPrice(targetSellStrike, type, 'ask');
                  const lotSize = r.buyLeg.lotSize || 1;
                  const atAtmPnl = ((buyIntrinsic - r.buyPrice) - (sellIntrinsic - r.sellPrice) * r.sellQty) * lotSize;

                  // Margin calculation matching paper trading leverage tiers
                  const sellLotSize = r.sellLeg.lotSize || lotSize;
                  const shortValue = currentSpot * r.sellQty * sellLotSize;
                  let leverage = 200;
                  if (shortValue <= 200000) leverage = 200;
                  else if (shortValue <= 450000) leverage = 100;
                  else if (shortValue <= 950000) leverage = 50;
                  else if (shortValue <= 1950000) leverage = 25;
                  else leverage = 25;

                  const margin = (r.buyPrice * lotSize) + (shortValue / leverage);
                  const roi = margin > 0 ? (atAtmPnl / margin) * 100 : 0;
                  const atmRatio = sellIntrinsic > 0 ? (buyIntrinsic / sellIntrinsic) : 0;
                  const roundedAtmRatio = atmRatio > 0 ? (Math.round(atmRatio / 0.25) * 0.25).toFixed(2) : '—';

                  return {
                    ...r,
                    buyIntrinsic,
                    sellIntrinsic,
                    atAtmPnl,
                    margin,
                    roi,
                    roundedAtmRatio
                  };
                });

                // Group results by buy strike
                const groups = processedResults.reduce((acc, r) => {
                  const s = r.buyLeg.strike;
                  if (!acc[s]) acc[s] = [];
                  acc[s].push(r);
                  return acc;
                }, {});

                // Sort unique buy strikes descending by their group's highest ROI
                const sortedBuyStrikes = Object.keys(groups).sort((a, b) => {
                  const maxRoiA = Math.max(...groups[a].map(r => r.roi));
                  const maxRoiB = Math.max(...groups[b].map(r => r.roi));
                  return maxRoiB - maxRoiA;
                });

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
                              <span className={`scanner-buy`}>
                                {bestRow.buyLeg.strike.toLocaleString()}
                              </span>
                              /
                              <span className={`scanner-sell`}>
                                {bestRow.sellLeg.strike.toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>{bestRow.strikeDiff.toLocaleString()}</td>
                        <td><div><div className="scanner-buy">${bestRow.buyPrice?.toFixed(2)}</div><div>{bestRow.buyIv?.toFixed(1)}%</div></div></td>
                        <td><div><div className="scanner-sell">${bestRow.sellPrice?.toFixed(2)}</div><div>{bestRow.sellIv?.toFixed(1)}%</div></div></td>
                        <td style={{ fontWeight: 700 }}>
                          <div><span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                            <span className='scanner-sell'>{bestRow.sellQty}</span></div>
                        </td>
                        <td className={parseFloat(bestRow.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                          ${Math.abs(parseFloat(bestRow.netPremium))}
                        </td>
                        <td className="scanner-highlight">{bestRow.ivDiff.toFixed(1)}%</td>
                        <td style={{ fontWeight: 700 }}>
                          <div><span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                            <span className='scanner-sell'>{bestRow.sellLeg.delta?.toFixed(4)}</span></div>
                        </td>
                        <td>{bestRow.deltaDiff.toFixed(4)}</td>

                        <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.02)' }}>
                          <div>
                            <div className="scanner-buy">${bestRow.buyIntrinsic.toFixed(2)}</div>
                            <div className="scanner-sell">${bestRow.sellIntrinsic.toFixed(2)}</div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>1 : {bestRow.roundedAtmRatio}</div>
                          </div>
                        </td>
                        <td style={{ background: 'rgba(0, 217, 163, 0.02)', fontWeight: 700 }}>
                          <div>
                            <span className={bestRow.atAtmPnl >= 0 ? 'scanner-buy' : 'scanner-sell'}>
                              {bestRow.atAtmPnl >= 0 ? '+' : ''}${bestRow.atAtmPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                            <div className={bestRow.roi >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontSize: 10, marginTop: 2, fontWeight: 'normal' }}>
                              {bestRow.roi >= 0 ? '+' : ''}{bestRow.roi.toFixed(2)}%
                            </div>
                          </div>
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
                                <span className={`scanner-buy`}>
                                  {r.buyLeg.strike.toLocaleString()}
                                </span>
                                /
                                <span className={`scanner-sell`}>
                                  {r.sellLeg.strike.toLocaleString()}
                                </span>
                              </div>
                            </td>
                            <td>{r.strikeDiff.toLocaleString()}</td>
                            <td><div><div className="scanner-buy">${r.buyPrice?.toFixed(2)}</div><div>{r.buyIv?.toFixed(1)}%</div></div></td>
                            <td><div><div className="scanner-sell">${r.sellPrice?.toFixed(2)}</div><div>{r.sellIv?.toFixed(1)}%</div></div></td>
                            <td style={{ fontWeight: 700 }}>
                              <div><span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                                <span className='scanner-sell'>{r.sellQty}</span></div>
                            </td>
                            <td className={parseFloat(r.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                              ${Math.abs(parseFloat(r.netPremium))}
                            </td>
                            <td className="scanner-highlight">{r.ivDiff.toFixed(1)}%</td>
                            <td style={{ fontWeight: 700 }}>
                              <div><span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                                <span className='scanner-sell'>{r.sellLeg.delta?.toFixed(4)}</span></div>
                            </td>
                            <td>{r.deltaDiff.toFixed(4)}</td>

                            <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.01)' }}>
                              <div>
                                <div className="scanner-buy">${r.buyIntrinsic.toFixed(2)}</div>
                                <div className="scanner-sell">${r.sellIntrinsic.toFixed(2)}</div>
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>1 : {r.roundedAtmRatio}</div>
                              </div>
                            </td>
                            <td style={{ background: 'rgba(0, 217, 163, 0.01)', fontWeight: 700 }}>
                              <div>
                                <span className={r.atAtmPnl >= 0 ? 'scanner-buy' : 'scanner-sell'}>
                                  {r.atAtmPnl >= 0 ? '+' : ''}${r.atAtmPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                                <div className={r.roi >= 0 ? 'scanner-buy' : 'scanner-sell'} style={{ fontSize: 10, marginTop: 2, fontWeight: 'normal' }}>
                                  {r.roi >= 0 ? '+' : ''}{r.roi.toFixed(2)}%
                                </div>
                              </div>
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
