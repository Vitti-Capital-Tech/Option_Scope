import React from 'react';
import { fmtExpiry } from '../../api';
import { formatDateTime } from '../../scannerUtils';

export default function TradeHistoryTable({
  filteredTradeHistory,
  historyFilterDate,
  setHistoryFilterDate,
  adjustFilterDay,
  resetToToday,
  filteredRealizedPnl,
  filteredWins,
  exportCSV,
  includeFees
}) {

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const exitBadgeClass = (reason) => {
    if (reason?.includes('Manual')) return 'manual';
    if (reason?.includes('Top 3')) return 'position';
    if (reason?.includes('ITM')) return 'itm';
    if (reason?.includes('OTM')) return 'otm';
    if (reason?.includes('ATM')) return 'atm';
    if (reason?.includes('Expiry')) return 'expiry';
    return 'position';
  };

  const renderRatio = (t) => {
    const r = t.exitReason || '';
    let mult = 1;
    if (r.includes('50%')) mult = 2;
    else if (r.includes('33%') || r.includes('34%')) mult = 3;

    const sellQty = t.sellQty || 0;
    const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;

    const uncappedSellQty = t.buyLeg?.originalSellQty !== undefined
      ? t.buyLeg.originalSellQty
      : sellQty / origLot;

    const originalSell = Math.round((uncappedSellQty * mult) * 4) / 4;
    return `1:${originalSell.toFixed(2)}`;
  };

  return (
    <div className="pt-section">
      <div className="pt-section-header pt-history-header" style={{
        flexDirection: 'column', alignItems: 'stretch', gap: '16px',
        padding: '16px 20px', borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)'
      }}>
        {/* Row 1: Title and Centered Filter */}
        <div className="pt-history-row-1">
          <div className="pt-history-title-area">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Trade History</span>
              <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
            </div>
            <span style={{ background: 'var(--bg3)', color: 'var(--accent)', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, border: '1px solid rgba(240, 185, 11, 0.2)' }}>
              {filteredTradeHistory.length}
            </span>
          </div>

          {/* Centered Date Filter */}
          <div className="pt-history-date-filter">
            <button onClick={() => adjustFilterDay(-1)} title="Previous Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px', justifyContent: 'center' }}>
              <input type="date" value={historyFilterDate} onChange={(e) => setHistoryFilterDate(e.target.value)}
                style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '120px', outline: 'none', cursor: 'pointer' }} />
              <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, background: 'rgba(240, 185, 11, 0.1)', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                12:00 UTC SESSION
              </span>
            </div>
            <button onClick={() => adjustFilterDay(1)} title="Next Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
            <button onClick={resetToToday} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '4px 12px', fontSize: '11px', color: 'var(--text)', fontWeight: 700, cursor: 'pointer', marginLeft: '4px' }}>
              TODAY
            </button>
            <button onClick={() => setHistoryFilterDate('')} title="Show All History"
              style={{ background: historyFilterDate ? 'none' : 'rgba(240, 185, 11, 0.1)', border: 'none', color: historyFilterDate ? 'var(--text-dim)' : 'var(--accent)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px', marginLeft: '4px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
            </button>
          </div>
        </div>

        {/* Row 2: Stats and Export */}
        {filteredTradeHistory.length > 0 && (
          <div className="pt-history-row-2">
            <div className="pt-history-stats" style={{ gap: '20px' }}>
              <div className="pt-history-stat">
                <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Realized:</span>
                <span className={`value ${filteredRealizedPnl >= 0 ? 'green' : 'red'}`} style={{ fontSize: '14px' }}>
                  {filteredRealizedPnl > 0 ? '+' : ''}{filteredRealizedPnl.toFixed(2)}
                </span>
              </div>
              <div style={{ width: '1px', height: '16px', background: 'var(--border)' }} />
              <div className="pt-history-stat">
                <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Win / Loss:</span>
                <span style={{ fontSize: '14px', fontWeight: 700 }}>
                  <span className="value green">{filteredWins}</span>
                  <span style={{ margin: '0 4px', color: 'var(--text-dim)', fontWeight: 400 }}>/</span>
                  <span className="value red">{filteredTradeHistory.length - filteredWins}</span>
                </span>
              </div>
            </div>
            <button className="pt-export-btn" onClick={exportCSV}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', borderRadius: '8px', background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Export CSV
            </button>
          </div>
        )}
      </div>

      {filteredTradeHistory.length === 0 ? (
        <div className="pt-empty">
          <div className="pt-empty-icon idle">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
          </div>
          <span className="pt-empty-title">No Closed Trades</span>
          <span className="pt-empty-desc">Trades will appear here once positions are exited for the selected day.</span>
        </div>
      ) : (
        <div className="pt-table-scroll">
          <table className="pt-table">
            <thead><tr>
              <th className="hide-mobile">Entry Time</th>
              <th className="hide-mobile">Exit Time</th>
              <th className="hide-mobile">Duration</th>
              <th>Expiry</th>
              <th>Type / Ratio</th>
              <th>Buy / Sell Strike</th>
              <th className="hide-mobile">Spot (In / Out)</th>
              <th>In (Buy / Sell)</th>
              <th className="hide-mobile">IV In (B/S)</th>
              <th className="hide-mobile">Entry ATM Ratio (Prices)</th>
              <th className="hide-mobile">Entry Fee</th>
              <th className="hide-mobile">Exit Fee</th>
              <th>Out (Buy / Sell)</th>
              <th className="hide-mobile">IV Out (B/S)</th>
              <th className="hide-mobile">Exit ATM Ratio (Prices)</th>
              <th>Realized P&L</th>
              <th>Exit Reason</th>
            </tr></thead>
            <tbody>
              {filteredTradeHistory.map((t, i) => {
                const pnlValue = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
                const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;

                const displayBuyQty = t.buyLeg.lotSize;
                const displaySellQty = t.sellQty;
                const displayMargin = t.margin || 0;

                const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;
                const rawOrigSellQty = t.buyLeg?.originalSellQty !== undefined ? t.buyLeg.originalSellQty : t.sellQty;
                const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;

                return (
                  <tr key={i}>
                    <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.entryTime)}</td>
                    <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.exitTime)}</td>
                    <td className="hide-mobile"><span className="pt-duration" style={{ fontSize: '11px' }}>{fmtDuration(durationMs)}</span></td>
                    <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(t.expiry)}</span></td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span className={`pt-type-badge ${t.type}`}>
                          {t.type.toUpperCase()}
                          {t._isPartial && (
                            <span style={{ fontSize: '9px', marginLeft: 4, opacity: 0.8 }}>
                              ({t.exitReason?.match(/\d+%/)?.[0] || 'P'})
                            </span>
                          )}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                          {displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}
                        </span>
                        <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                          (Orig 1:{displayOrigSellQty.toFixed(2)})
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                        <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{t.sellLeg.strike.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                        <span style={{ color: 'var(--text-dim)' }}>{t.entrySpotPrice ? t.entrySpotPrice.toLocaleString() : '—'}</span>
                        <span style={{ color: 'var(--text-dim)', opacity: 0.8 }}>{t.exitSpotPrice ? t.exitSpotPrice.toLocaleString() : '—'}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{t.entryBuyPrice?.toFixed(2)}</span>
                        <span style={{ color: '#f85149' }}>{t.entrySellPrice?.toFixed(2)}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600, marginTop: 2 }}>
                          {renderRatio(t)}
                        </span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                        <span>{t.entryBuyIv != null ? t.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{t.entrySellIv != null ? t.entrySellIv.toFixed(1) + '%' : '—'}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      {t.buyLeg?.entryAtmRatio != null ? (
                        <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                          <span style={{ fontWeight: 600 }}>{t.buyLeg.entryAtmRatio.toFixed(2)}</span>
                          <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                            ({t.buyLeg.entryBuyAtmPrice != null ? t.buyLeg.entryBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.entrySellAtmPrice != null ? t.buyLeg.entrySellAtmPrice.toFixed(2) : '—'})
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-dim)' }}>—</span>
                      )}
                    </td>
                    <td className="hide-mobile">
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                        ${t.entryFee?.toFixed(2) || '0.00'}
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                        ${t.exitFee?.toFixed(2) || '0.00'}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                        <span style={{ color: '#3fb950' }}>{t.exitBuyPrice?.toFixed(2) || '—'}</span>
                        <span style={{ color: '#f85149' }}>{t.exitSellPrice?.toFixed(2) || '—'}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text)' }}>
                        <span>{t.exitBuyIv != null ? t.exitBuyIv.toFixed(1) + '%' : '—'}</span>
                        <span>{t.exitSellIv != null ? t.exitSellIv.toFixed(1) + '%' : '—'}</span>
                      </div>
                    </td>
                    <td className="hide-mobile">
                      {t.buyLeg?.exitAtmRatio != null ? (
                        <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                          <span style={{ fontWeight: 600 }}>{t.buyLeg.exitAtmRatio.toFixed(2)}</span>
                          <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                            ({t.buyLeg.exitBuyAtmPrice != null ? t.buyLeg.exitBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.exitSellAtmPrice != null ? t.buyLeg.exitSellAtmPrice.toFixed(2) : '—'})
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-dim)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <span className={`pt-pnl ${pnlClass}`}>
                          {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${displayMargin.toFixed(0)}</span>
                      </div>
                    </td>
                    <td><span className={`pt-exit-badge ${exitBadgeClass(t.exitReason)}`}>{t.exitReason}</span></td>
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
