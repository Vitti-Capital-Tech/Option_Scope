import React, { useState } from 'react';

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
  spotPrice
}) {
  const [expandedStrikes, setExpandedStrikes] = useState({});

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
                <th>Rank</th>
                <th>Buy/Sell Strikes</th>
                <th>Strike Δ</th>
                <th>Buy Prem</th>
                <th>Sell Prem</th>
                <th>Buy/Sell Qty</th>
                <th>Net Prem</th>
                <th>IV Diff</th>
                <th>Buy Δ / Sell Δ</th>
                <th>Net Δ</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Group results by buy strike
                const groups = results.reduce((acc, r) => {
                  const s = r.buyLeg.strike;
                  if (!acc[s]) acc[s] = [];
                  acc[s].push(r);
                  return acc;
                }, {});

                // Sort unique buy strikes by the best score in their group
                const sortedBuyStrikes = Object.keys(groups).sort((a, b) => {
                  return groups[a][0].netPremium - groups[b][0].netPremium;
                });

                let globalRank = 1;

                return sortedBuyStrikes.map((strike) => {
                  const groupRows = groups[strike];
                  const bestRow = groupRows[0];
                  const others = groupRows.slice(1);
                  const isExpanded = !!expandedStrikes[strike];
                  const hasOthers = others.length > 0;

                  return (
                    <React.Fragment key={strike}>
                      {/* Best row for this strike */}
                      <tr
                        className={`${globalRank === 1 ? 'scanner-row-best' : ''} ${hasOthers ? 'scanner-row-group' : ''}`}
                        onClick={() => hasOthers && setExpandedStrikes(prev => ({ ...prev, [strike]: !prev[strike] }))}
                        style={{ cursor: hasOthers ? 'pointer' : 'default' }}
                      >
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                            {hasOthers && (
                              <span className={`scanner-group-toggle ${isExpanded ? 'expanded' : ''}`}>
                                ▸
                              </span>
                            )}
                            <span className={`scanner-rank ${globalRank < 4 ? `rank-${globalRank}` : ''}`}>
                              #{globalRank++}
                            </span>
                          </div>
                        </td>
                        <td><div><span className="scanner-buy">{bestRow.buyLeg.strike.toLocaleString()}</span>/<span className="scanner-sell">{bestRow.sellLeg.strike.toLocaleString()}</span></div></td>
                        <td>{bestRow.strikeDiff.toLocaleString()}</td>
                        <td><div><div className="scanner-buy">${bestRow.buyLeg.markPrice?.toFixed(2)}</div><div>{bestRow.buyLeg.iv?.toFixed(1)}%</div></div></td>
                        <td><div><div className="scanner-sell">${bestRow.sellLeg.markPrice?.toFixed(2)}</div><div>{bestRow.sellLeg.iv?.toFixed(1)}%</div></div></td>
                        <td style={{ fontWeight: 700 }}>
                          <div><span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                            <span className='scanner-sell'>{bestRow.sellQty}</span></div>
                        </td>
                        <td className={parseFloat(bestRow.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                          ${Math.abs(parseFloat(bestRow.netPremium))}
                        </td>
                        <td className="scanner-highlight">{bestRow.ivDiff.toFixed(1)}%</td>
                        <td style={{ fontWeight: 700 }}>
                          <div><span className='scanner-buy'>{bestRow.buyLeg.delta?.toFixed(4)}</span>/
                            <span className='scanner-sell'>{bestRow.sellLeg.delta?.toFixed(4)}</span></div>
                        </td>
                        <td>{bestRow.deltaDiff.toFixed(4)}</td>
                      </tr>

                      {/* Other rows for this strike */}
                      {isExpanded && others.map((r) => (
                        <tr key={`${r.buyLeg.strike}-${r.sellLeg.strike}`} className="scanner-row-sub">
                          <td></td>
                          <td><div><span className="scanner-buy">{r.buyLeg.strike.toLocaleString()}</span>/<span className="scanner-sell">{r.sellLeg.strike.toLocaleString()}</span></div></td>
                          <td>{r.strikeDiff.toLocaleString()}</td>
                          <td><div><div className="scanner-buy">${r.buyLeg.markPrice?.toFixed(2)}</div><div>{r.buyLeg.iv?.toFixed(1)}%</div></div></td>
                          <td><div><div className="scanner-sell">${r.sellLeg.markPrice?.toFixed(2)}</div><div>{r.sellLeg.iv?.toFixed(1)}%</div></div></td>
                          <td style={{ fontWeight: 700 }}>
                            <div><span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                              <span className='scanner-sell'>{r.sellQty}</span></div>
                          </td>
                          <td className={parseFloat(r.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                            ${Math.abs(parseFloat(r.netPremium))}
                          </td>
                          <td className="scanner-highlight">{r.ivDiff.toFixed(1)}%</td>
                          <td style={{ fontWeight: 700 }}>
                            <div><span className='scanner-buy'>{r.buyLeg.delta?.toFixed(4)}</span>/
                              <span className='scanner-sell'>{r.sellLeg.delta?.toFixed(4)}</span></div>
                          </td>
                          <td>{r.deltaDiff.toFixed(4)}</td>
                        </tr>
                      ))}
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
