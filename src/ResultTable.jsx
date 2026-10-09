import React, { useState, useMemo, useCallback } from 'react';
import { RefreshCw, Target, ChevronRight } from 'lucide-react';
import { leverageFor } from './scannerUtils';

// Human-readable explanation of how an ATM intrinsic price was resolved for a target
// strike — exact listed / bracket-average / single-neighbour / omitted. Rendered as a
// hover tooltip on the ATM P&L intrinsic cells so the bracket-and-average fallback
// (getTickerPrice) can be verified at a glance without hand-checking the option chain.
function describeIntrinsic(detail, field) {
  if (!detail) return undefined;
  const m = (n) => `$${Number(n).toFixed(2)}`;
  const k = (s) => Number(s).toLocaleString();
  switch (detail.mode) {
    case 'exact':
      return `${k(detail.strike)} — exact listed strike · ${field} ${m(detail.exactPrice)}`;
    case 'bracket':
      return `${k(detail.strike)} not listed → bracket-average of ${k(detail.below.strike)} (${m(detail.below.price)}) & ${k(detail.above.strike)} (${m(detail.above.price)}) = ${m((detail.below.price + detail.above.price) / 2)}  ·  tolerance ±${detail.tolerance}`;
    case 'single': {
      const s = detail.below || detail.above;
      return `${k(detail.strike)} not listed → only one neighbour within ±${detail.tolerance}: ${k(s.strike)} (${m(s.price)})`;
    }
    default:
      return `${k(detail.strike)} not listed → no strike within ±${detail.tolerance ?? '?'} → price omitted (—)`;
  }
}
// A fallback (not an exact strike) produced the price → flag it with a "≈" marker.
const isApproxIntrinsic = (detail) => !!detail && (detail.mode === 'bracket' || detail.mode === 'single');

// Hedge legs (3rd long) under the spread strikes — only when the Hedge toggle is on. The top 2
// qualifying options by ATM ROI are listed (strikes from one step beyond the short up to width − one step,
// under Max Hedge Price, inside the IV-diff range, 3-leg net within Max Debit); the ✓ one
// (best ATM ROI) is what the row's Net Premium / ATM P&L / Margin / ROI use.
function HedgeLine({ hedge, options }) {
  if (!hedge) return null;
  if (options && options.length > 1) {
    // Only the top 2 by ATM ROI (the ✓ one first) — the rest are left out to keep rows short.
    const top = [...options]
      .sort((a, b) => (b.chosen - a.chosen) || ((b.roi ?? -Infinity) - (a.roi ?? -Infinity)))
      .slice(0, 2);
    return (
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
        {top.map(o => (
          <div key={o.strike} style={o.chosen ? { fontWeight: 700, color: 'var(--text)' } : undefined}
            title={`Hedge long ${Number(o.strike).toLocaleString()} @ ${Number(o.price).toFixed(2)}${o.iv != null ? ` (${Number(o.iv).toFixed(1)}% IV)` : ''} × ${o.qty} · net premium ${Number(o.netPremium ?? 0).toFixed(2)}${o.atAtm != null ? ` · worth ${Number(o.atAtm).toFixed(2)} at ATM` : ''}${o.roi != null ? ` · ATM ROI ${o.roi.toFixed(2)}%` : ''}${o.chosen ? ' — used for this row (best ATM ROI)' : ''}`}>
            H: <span className="scanner-buy">+{Number(o.strike).toLocaleString()}</span> @ ${Number(o.price).toFixed(2)} × {o.qty}
            {o.roi != null && <> · {o.roi >= 0 ? '+' : ''}{o.roi.toFixed(2)}%</>}{o.chosen ? ' ✓' : ''}
          </div>
        ))}
      </div>
    );
  }
  const price = Number(hedge.price);
  return (
    <div
      style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}
      title={`Hedge long ${hedge.strike.toLocaleString()} @ $${price.toFixed(2)}${hedge.iv != null ? ` (${Number(hedge.iv).toFixed(1)}% IV)` : ''} × ${hedge.qty} (scaled short qty × hedge lot %)${hedge.atAtm != null ? ` · worth $${Number(hedge.atAtm).toFixed(2)} at ATM` : ''}`}
    >
      H: <span className="scanner-buy">+{hedge.strike.toLocaleString()}</span> @ ${price.toFixed(2)} × {hedge.qty}
    </div>
  );
}

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
  // Anchored hover tooltip for the ATM intrinsic cells (see renderIntrinsic /
  // renderTipContent). One shared card, position:fixed so the table's overflow
  // scroll container never clips it. { detail, field, x, y, below }.
  const [tip, setTip] = useState(null);
  const showTip = (e, detail, field) => {
    if (!detail) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const below = rect.top < 170; // not enough room above → flip under the cell
    setTip({ detail, field, x: rect.left + rect.width / 2, y: below ? rect.bottom : rect.top, below });
  };
  const hideTip = () => setTip(null);

  const currentSpot = spotPrice || 0;
  const atmStrike = trueAtmStrike || currentSpot;

  /**
   * Find the best price for a given strike + option type.
   * Falls back to the nearest available strike when an exact match is missing,
   * within a tolerance of 10% of spot price (or 5000 absolute, whichever is larger).
   * Returns null when no suitable ticker exists at all.
   */
  // Resolve the price for a strike AND report how it was resolved (for the tooltip).
  // Returns { price, detail } where detail.mode ∈ exact|bracket|single|none.
  const resolveTickerPrice = useCallback((strike, optType, priceField) => {
    const lowerType = optType.toLowerCase();
    const allTickers = Object.values(tickerData || {}).filter(t => t.type === lowerType);
    if (!allTickers.length) return { price: null, detail: { mode: 'none', strike } };

    // Exact match first
    const exact = allTickers.find(t => t.strike === strike);
    if (exact) {
      const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
      const price = (val != null && val > 0) ? val : null;
      return { price, detail: { mode: price != null ? 'exact' : 'none', strike, exactPrice: price } };
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
    const belowInfo = pBelow != null ? { strike: below.strike, price: pBelow } : null;
    const aboveInfo = pAbove != null ? { strike: above.strike, price: pAbove } : null;
    let price = null, mode = 'none';
    if (pBelow != null && pAbove != null) { price = (pBelow + pAbove) / 2; mode = 'bracket'; }
    else if (pBelow != null || pAbove != null) { price = pBelow ?? pAbove; mode = 'single'; }
    return { price, detail: { mode, strike, tolerance: maxTolerance, below: belowInfo, above: aboveInfo } };
  }, [tickerData]);

  // Render an ATM intrinsic cell: the price, a "≈" marker when the value came from the
  // bracket-average / single-neighbour fallback, plus a styled hover card (renderTipContent)
  // breaking down exactly how it was resolved. `aria-label` carries the same info for a11y.
  const renderIntrinsic = (price, detail, field, className) => {
    const approx = isApproxIntrinsic(detail);
    return (
      <div
        className={`rt-intrinsic ${className}${approx ? ' rt-approx' : ''}`}
        aria-label={describeIntrinsic(detail, field)}
        onMouseEnter={detail ? (e) => showTip(e, detail, field) : undefined}
        onMouseLeave={detail ? hideTip : undefined}
      >
        {price != null ? `${approx ? '≈' : ''}$${price.toFixed(2)}` : '—'}
      </div>
    );
  };

  // Structured content for the anchored intrinsic tooltip card.
  const renderTipContent = (detail, field) => {
    const m = (n) => `$${Number(n).toFixed(2)}`;
    const k = (s) => Number(s).toLocaleString();
    const label = { exact: 'Exact strike', bracket: 'Bracket average', single: 'Single side', none: 'Omitted' }[detail.mode] || detail.mode;
    const s1 = detail.below || detail.above;
    return (
      <>
        <div className="rt-tip-head">
          <span className={`rt-tip-badge ${detail.mode}`}>{label}</span>
          <span className="rt-tip-field">{field}</span>
        </div>
        <div className="rt-tip-row"><span className="k">Target strike</span><span className="v">{k(detail.strike)}</span></div>
        {detail.mode === 'exact' && (
          <div className="rt-tip-row"><span className="k">Listed price</span><span className="v">{m(detail.exactPrice)}</span></div>
        )}
        {detail.mode === 'bracket' && (
          <>
            <div className="rt-tip-sep" />
            <div className="rt-tip-row"><span className="k">Below · {k(detail.below.strike)}</span><span className="v">{m(detail.below.price)}</span></div>
            <div className="rt-tip-row"><span className="k">Above · {k(detail.above.strike)}</span><span className="v">{m(detail.above.price)}</span></div>
            <div className="rt-tip-sep" />
            <div className="rt-tip-result"><span className="k">Midpoint</span><span className="v">{m((detail.below.price + detail.above.price) / 2)}</span></div>
            <div className="rt-tip-note">Strike not listed — averaged the nearest strikes within ±{detail.tolerance} pts.</div>
          </>
        )}
        {detail.mode === 'single' && s1 && (
          <>
            <div className="rt-tip-sep" />
            <div className="rt-tip-row"><span className="k">Nearest · {k(s1.strike)}</span><span className="v">{m(s1.price)}</span></div>
            <div className="rt-tip-note">Only one neighbour within ±{detail.tolerance} pts — used it directly.</div>
          </>
        )}
        {detail.mode === 'none' && (
          <div className="rt-tip-note">No listed strike within ±{detail.tolerance ?? '?'} pts of the target — price omitted (shown as —).</div>
        )}
      </>
    );
  };

  const filteredResults = useMemo(() => {
    const processedResults = results.map(r => {
      // Use nearest-available strike when exact ATM is missing. Capture the resolution
      // detail (exact/bracket/single/none) so the cell can show a verification tooltip.
      const buyInfo = resolveTickerPrice(atmStrike, type, 'bid');
      const buyIntrinsic = buyInfo.price;                                   // null if unavailable
      const targetSellStrike = type === 'CALL' ? atmStrike + r.strikeDiff : atmStrike - r.strikeDiff;
      const sellInfo = resolveTickerPrice(targetSellStrike, type, 'ask');
      const sellIntrinsic = sellInfo.price;                                 // null if unavailable
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

      // Per-underlying (ETH 100x / BTC 200x) — derived from the leg symbol, the same source
      // the bracket tolerance above uses. Must match engine/lib/utils.js calcMargin().
      const leverage = leverageFor(r.buyLeg?.symbol);

      // Hedge leg (3rd long): qty = the SCALED short qty (after the $195k / leverage cap)
      // × Hedge Lot %. At ATM it is worth the bid at the ATM-shifted hedge strike (same
      // shift as the long/short); unquoted there = worthless (whole premium lost). Its
      // premium adds to margin. Mirrors the engine's ATM P&L gate.
      // Every qualifying hedge option is priced the same way and the row uses the one with the
      // best ATM ROI (then ATM P&L); unpriceable at ATM → the nearest (first) option.
      const hedgePct = (Number(config?.hedgeLotPct) || 0) / 100;
      const legsPnl = hasAtmData
        ? (buyIntrinsic - r.buyPrice) + (r.sellPrice - sellIntrinsic) * totalSellQty
        : null;
      const baseMargin = (r.buyPrice * adjustedLotSize) + (shortValue / leverage);
      const priceHedge = (h) => {
        const qty = Math.round(adjustedSellQty * hedgePct * 100) / 100;
        const offset = Number(h.strike) - Number(r.buyLeg.strike);
        const atAtm = atmStrike != null
          ? (resolveTickerPrice(atmStrike + offset, type, 'bid').price ?? 0)
          : 0;
        const term = (atAtm - h.price) * totalSellQty * hedgePct;
        const hMargin = h.price * adjustedSellQty * hedgePct;
        const pnl = legsPnl != null ? (legsPnl + term) * adjustedLotSize : null;
        const m = baseMargin + hMargin;
        return { ...h, qty, atAtm, atAtmPnl: pnl, margin: m, roi: (pnl != null && m > 0) ? (pnl / m) * 100 : null };
      };
      const pricedOptions = (r.hedgeOptions?.length ? r.hedgeOptions : (r.hedge ? [r.hedge] : [])).map(priceHedge);
      let hedge = null;
      for (const o of pricedOptions) {
        if (!hedge) { hedge = o; continue; }
        const a = o.roi ?? -Infinity;
        const b = hedge.roi ?? -Infinity;
        if (a > b || (a === b && (o.atAtmPnl ?? -Infinity) > (hedge.atAtmPnl ?? -Infinity))) hedge = o;
      }
      const hedgeOptions = pricedOptions.map(o => ({ ...o, chosen: o === hedge }));

      // Compute P&L scaled to the adjusted lot size
      const atAtmPnl = hedge ? hedge.atAtmPnl : (legsPnl != null ? legsPnl * adjustedLotSize : null);
      const margin = hedge ? hedge.margin : baseMargin;
      const roi = (atAtmPnl != null && margin > 0) ? (atAtmPnl / margin) * 100 : null;

      // Net premium is computed in the scanner from the scaled qty (per chosen hedge option).
      const rawNetPremium = hedge?.netPremium ?? r.netPremium;

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
        buyIntrinsicDetail: buyInfo.detail,
        sellIntrinsicDetail: sellInfo.detail,
        atAtmPnl,
        margin,
        roi,
        roundedAtmRatio,
        hasAtmData,
        hedge,
        hedgeOptions,
        netDelta3: hedge?.netDelta3 ?? r.netDelta3,
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
  }, [results, resolveTickerPrice, atmStrike, type, config, currentSpot]);

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
                              <HedgeLine hedge={bestRow.hedge} options={bestRow.hedgeOptions} />
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
                            {bestRow.ivDiff.toFixed(1)}% IV{bestRow.hedge ? ' · incl. hedge' : ''}
                          </div>
                        </td>
                        <td className="hide-mobile">
                          <div>
                            <span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                            <span className='scanner-sell'>{bestRow.sellLeg.delta?.toFixed(4)}</span>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            N: {bestRow.deltaDiff.toFixed(4)}{bestRow.netDelta3 != null ? ` · 3-leg ${bestRow.netDelta3.toFixed(4)}` : ''}
                          </div>
                        </td>

                        <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.02)' }}>
                          <div>
                            {renderIntrinsic(bestRow.buyIntrinsic, bestRow.buyIntrinsicDetail, 'bid', 'scanner-buy')}
                            {renderIntrinsic(bestRow.sellIntrinsic, bestRow.sellIntrinsicDetail, 'ask', 'scanner-sell')}
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
                                <HedgeLine hedge={r.hedge} options={r.hedgeOptions} />
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
                                {r.ivDiff.toFixed(1)}% IV{r.hedge ? ' · incl. hedge' : ''}
                              </div>
                            </td>
                            <td className="hide-mobile">
                              <div>
                                <span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                                <span className='scanner-sell'>{r.sellLeg.delta?.toFixed(4)}</span>
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                N: {r.deltaDiff.toFixed(4)}{r.netDelta3 != null ? ` · 3-leg ${r.netDelta3.toFixed(4)}` : ''}
                              </div>
                            </td>

                            <td style={{ borderLeft: '1px solid rgba(0, 217, 163, 0.1)', background: 'rgba(0, 217, 163, 0.01)' }}>
                              <div>
                                {renderIntrinsic(r.buyIntrinsic, r.buyIntrinsicDetail, 'bid', 'scanner-buy')}
                                {renderIntrinsic(r.sellIntrinsic, r.sellIntrinsicDetail, 'ask', 'scanner-sell')}
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

      {tip && (
        <div className={`rt-tip${tip.below ? ' below' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {renderTipContent(tip.detail, tip.field)}
        </div>
      )}
    </div>
  );
}
