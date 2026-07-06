import React from 'react';
import { fmtExpiry } from '../../api';
import { formatDateTime } from '../../scannerUtils';
import CustomInput from '../common/CustomInput';

// Same palette as the schedule timeline so the capacity chips line up visually
// with the windows shown in SchedulePanel.
const WINDOW_COLORS = [
  '#00d9a3', '#2f81f7', '#e3b341', '#ff2ebd', '#f85149',
  '#a371f7', '#ffa657', '#3fb950', '#79c0ff', '#ff9a8b',
];

export default function TradeHistoryTable({
  filteredTradeHistory,
  historyFilterDate,
  setHistoryFilterDate,
  adjustFilterDay,
  resetToToday,
  filteredRealizedPnl,
  filteredWins,
  exportCSV,
  includeFees,
  schedules = [],
  embedded = false
}) {

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const kStrike = (s) => `${Number((Number(s) / 1000).toFixed(2))}k`;
  const instrumentName = (t) => {
    const base = `${t.underlying}-${t.type.toUpperCase()}`;
    return t.sellLeg?.strike
      ? `${base} ${kStrike(t.buyLeg.strike)}/${kStrike(t.sellLeg.strike)}`
      : `${base} ${kStrike(t.buyLeg.strike)}`;
  };

  // A "long / short" value pair, coloured green/red (or dimmed for IV).
  const legPair = (l, s, { dim = false } = {}) => (
    <span className={`pt-ls${dim ? ' dim' : ''}`}>
      <span className="pt-ls-l">{l ?? '—'}</span>
      <span className="pt-ls-sep">/</span>
      <span className="pt-ls-s">{s ?? '—'}</span>
    </span>
  );

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
    <div className={embedded ? 'pt-embedded' : 'pt-section'}>
      <div className="pt-section-header pt-history-header" style={{
        flexDirection: 'column', alignItems: 'stretch', gap: '16px',
        padding: '16px 20px', borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)'
      }}>
        {/* Row 1: Title (left) and Date navigator (right) */}
        <div className="pt-history-row-1">
          <div className="pt-history-title-area">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Order History</span>
              <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
            </div>
            <span style={{ background: 'var(--bg3)', color: 'var(--accent)', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, border: '1px solid rgba(240, 185, 11, 0.2)' }}>
              {filteredTradeHistory.length}
            </span>
          </div>

          {/* Date navigator (right-aligned) */}
          <div className="pt-history-date-filter">
            <button onClick={() => adjustFilterDay(-1)} title="Previous Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px', justifyContent: 'center' }}>
              <CustomInput type="date" value={historyFilterDate} onChange={(e) => setHistoryFilterDate(e.target.value)}
                style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '120px', outline: 'none', cursor: 'pointer', boxShadow: 'none' }} />
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

        {/* Row 1.5: Per-window capacity (max calls/puts). One chip per window,
            colored to match the Schedule Panel timeline. */}
        {schedules.length > 0 && (
          <div className="pt-history-windows" style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            borderTop: '1px solid var(--border)', paddingTop: 12
          }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-dim)', fontWeight: 700 }}>
              Window Capacity:
            </span>

            {schedules.map((s, i) => {
              const dot = WINDOW_COLORS[i % WINDOW_COLORS.length];
              const name = s.label || `Window ${i + 1}`;
              return (
                <div
                  key={s.id ?? i}
                  title={`${name} (${(s.startTime || '').slice(0, 5)}–${(s.endTime || '').slice(0, 5)} IST) — max ${s.numberOfCalls} calls / ${s.numberOfPuts} puts${s.isActive ? '' : ' · inactive'}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 20, padding: '3px 10px',
                    opacity: s.isActive ? 1 : 0.45,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text)' }}>{name}</span>
                  <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-dim)' }}>
                    C:{s.numberOfCalls} · P:{s.numberOfPuts}
                  </span>
                </div>
              );
            })}
          </div>
        )}

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
          <table className="pt-table pt-lean">
            <thead><tr>
              <th>Entry Time</th>
              <th>Closed</th>
              <th>Duration</th>
              <th>Position</th>
              <th>Ratio</th>
              <th>Init. Ratio</th>
              <th>Init. Scaled (L/S)</th>
              <th>Expiry</th>
              <th>Strikes L/S</th>
              <th>Spot (In / Out)</th>
              <th>Entry Prem.</th>
              <th>Entry IV (L/S)</th>
              <th>Entry ATM Scaling</th>
              <th>Exit Prem.</th>
              <th>Exit IV (L/S)</th>
              <th>Exit ATM Scaling</th>
              <th>Entry Fee</th>
              <th>Exit Fee</th>
              <th>Net P&L</th>
              <th>Exit Reason</th>
            </tr></thead>
            <tbody>
              {filteredTradeHistory.map((t, i) => {
                const pnlValue = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
                const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;
                const displayMargin = t.margin || 0;
                const hasShort = !!t.sellLeg?.strike;

                // ── Original & initial-scaled ratios ──
                const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;
                const rawOrigSellQty = t.buyLeg?.originalSellQty !== undefined ? t.buyLeg.originalSellQty : t.sellQty;
                const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;
                const initBuyQty = t.buyLeg?.initialScaledLotSize ?? t.buyLeg?.lotSize ?? 0;
                const initSellQty = t.buyLeg?.initialScaledLotSize !== undefined && t.buyLeg?.originalSellQty !== undefined
                  ? (t.buyLeg.initialScaledLotSize * t.buyLeg.originalSellQty)
                  : t.sellQty;
                const atm = (ratio, buy, sell) => ratio != null
                  ? `${ratio.toFixed(2)} (${buy != null ? buy.toFixed(2) : '—'} / ${sell != null ? sell.toFixed(2) : '—'})`
                  : '—';

                return (
                  <tr key={i} className={`pt-row-${t.type}`}>
                    <td><span className="pt-mono pt-dim">{formatDateTime(t.entryTime)}</span></td>
                    <td><span className="pt-hist-time">{formatDateTime(t.exitTime)}</span></td>
                    <td><span className="pt-duration">{fmtDuration(durationMs)}</span></td>
                    <td>
                      <div className="pt-pos-cell">
                        <span className={`pt-legrail ${t.type}`} />
                        <div className="pt-pos-id">
                          <span className="pt-instrument">{instrumentName(t)}</span>
                          <span className="pt-pos-meta">
                            <span className={`pt-type-badge ${t.type}`}>
                              {t.type.toUpperCase()}
                              {t._isPartial && (
                                <span style={{ fontSize: '9px', marginLeft: 4, opacity: 0.8 }}>
                                  ({t.exitReason?.match(/\d+%/)?.[0] || 'P'})
                                </span>
                              )}
                            </span>
                            <span className="pt-pos-note">spread</span>
                          </span>
                        </div>
                      </div>
                    </td>
                    <td><span className="pt-ratio">{renderRatio(t)}</span></td>
                    <td><span className="pt-mono pt-dim">1:{displayOrigSellQty.toFixed(2)}</span></td>
                    <td>{legPair(initBuyQty.toFixed(2), initSellQty.toFixed(2))}</td>
                    <td><span className="pt-mono">{fmtExpiry(t.expiry)}</span></td>
                    <td>{legPair(t.buyLeg.strike.toLocaleString(), hasShort ? t.sellLeg.strike.toLocaleString() : null)}</td>
                    <td><span className="pt-mono pt-dim">{t.entrySpotPrice ? t.entrySpotPrice.toLocaleString() : '—'} / {t.exitSpotPrice ? t.exitSpotPrice.toLocaleString() : '—'}</span></td>
                    <td>{legPair(t.entryBuyPrice != null ? t.entryBuyPrice.toFixed(2) : null, t.entrySellPrice != null ? t.entrySellPrice.toFixed(2) : null)}</td>
                    <td>{legPair(t.entryBuyIv != null ? t.entryBuyIv.toFixed(1) : null, t.entrySellIv != null ? t.entrySellIv.toFixed(1) : null, { dim: true })}</td>
                    <td><span className="pt-mono pt-dim">{atm(t.buyLeg?.entryAtmRatio, t.buyLeg?.entryBuyAtmPrice, t.buyLeg?.entrySellAtmPrice)}</span></td>
                    <td>{legPair(t.exitBuyPrice != null ? t.exitBuyPrice.toFixed(2) : null, t.exitSellPrice != null ? t.exitSellPrice.toFixed(2) : null)}</td>
                    <td>{legPair(t.exitBuyIv != null ? t.exitBuyIv.toFixed(1) : null, t.exitSellIv != null ? t.exitSellIv.toFixed(1) : null, { dim: true })}</td>
                    <td><span className="pt-mono pt-dim">{atm(t.buyLeg?.exitAtmRatio, t.buyLeg?.exitBuyAtmPrice, t.buyLeg?.exitSellAtmPrice)}</span></td>
                    <td><span className="pt-mono pt-dim">${t.entryFee?.toFixed(2) || '0.00'}</span></td>
                    <td><span className="pt-mono pt-dim">${t.exitFee?.toFixed(2) || '0.00'}</span></td>
                    <td>
                      <div className="pt-pnlcell" style={{ alignItems: 'flex-start' }}>
                        <span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span>
                        <span className="pt-hist-margin">Margin ${displayMargin.toFixed(0)}</span>
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
