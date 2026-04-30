import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';

const UNDERLYINGS = ['BTC', 'ETH'];

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatTime(d) {
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function normalizeIv(iv) {
  if (!Number.isFinite(iv)) return null;
  return iv <= 1 ? iv * 100 : iv;
}

function toFiniteNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function matchesOptionType(product, optionType) {
  const wanted = optionType === 'call' ? 'call_options' : 'put_options';
  return product?.contract_type === wanted
    || product?.contract_types === wanted
    || (optionType === 'call' ? /^C-/.test(product?.symbol || '') : /^P-/.test(product?.symbol || ''));
}



// ── Main Scanner Component ──────────────────────────────────────────────────
export default function RatioSpreadScanner({ onNavigate }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [optionType, setOptionType] = useState('call'); // 'call' or 'put'
  const [spotPrice, setSpotPrice] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState([]);
  const [tickerData, setTickerData] = useState({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);
  const [expandedStrikes, setExpandedStrikes] = useState({});
  const wsRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);

  // Configurable thresholds
  const [config, setConfig] = useState({
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
  });



  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    setTickerData(prev => ({ ...prev, ...buffered }));
  }, []);

  // ── Load products on underlying change ──────────────────────────────────
  useEffect(() => {
    setExpiries([]); setSelExpiry(''); setResults([]);
    setTickerData({});
    setExpectedTickerCount(0);
    setExpandedStrikes({});
    loadProducts(underlying)
      .then(prods => {
        setProducts(prods);
        const exps = getExpiries(prods);
        setExpiries(exps);
        if (exps.length) setSelExpiry(exps[0]);
      })
      .catch(e => console.error('Failed to load products:', e));
  }, [underlying]);

  // ── Fetch spot price ────────────────────────────────────────────────────
  useEffect(() => {
    const fetchSpot = () => {
      getSpotPrice(underlying)
        .then(sp => { if (sp) setSpotPrice(sp); })
        .catch(() => { });
    };
    fetchSpot();
    spotIntervalRef.current = setInterval(fetchSpot, 10000);
    return () => clearInterval(spotIntervalRef.current);
  }, [underlying]);

  // ── Build strike pairs and subscribe to WS ──────────────────────────────
  const startScan = useCallback(() => {
    if (!selExpiry || !products.length) {
      return;
    }

    // Close any existing WS
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    tickerBufferRef.current = {};

    setScanning(true);
    setResults([]);
    setTickerData({});
    setExpectedTickerCount(0);
    setExpandedStrikes({});

    // Get all strikes for this expiry
    const strikes = getStrikes(products, selExpiry);

    if (strikes.length < 2) {
      setScanning(false);
      return;
    }

    // Build symbols + lot sizes for all strikes
    // contract_size from Delta Exchange = how many units of underlying per contract
    // e.g. BTC options = 0.001 BTC/contract, ETH = 0.01 ETH/contract
    const strikeSymbols = {};  // strike -> symbol
    const strikeLotSizes = {}; // strike -> contract_size (lot size)
    const symbolMeta = {};     // symbol -> { strike, lotSize }
    for (const strike of strikes) {
      const optionProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, optionType)
      );
      if (optionProd) {
        const sym = optionProd.symbol;
        const lotSize = parseFloat(optionProd.contract_size ?? optionProd.quoting_precision ?? 1);
        strikeSymbols[strike] = sym;
        // contract_size tells us how many underlying units one contract controls
        strikeLotSizes[strike] = lotSize;
        symbolMeta[sym] = { strike: parseFloat(strike), lotSize };
      }
    }


    const allSymbols = Object.values(strikeSymbols);
    setExpectedTickerCount(allSymbols.length);


    const stream = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        const markPrice = toFiniteNumber(msg.mark_price ?? msg.close ?? msg.last_price);
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;
        const gamma = msg.greeks ? toFiniteNumber(msg.greeks.gamma) : null;
        const theta = msg.greeks ? toFiniteNumber(msg.greeks.theta) : null;

        const meta = symbolMeta[sym];
        if (!meta) return;

        const { strike, lotSize } = meta;
        const prevBuffered = tickerBufferRef.current[strike] ?? tickerData[strike];
        tickerBufferRef.current[strike] = {
          symbol: sym,
          strike,
          lotSize,
          markPrice: markPrice ?? prevBuffered?.markPrice ?? null,
          iv: iv ?? prevBuffered?.iv ?? null,
          // raw per-unit delta from the exchange
          delta: delta !== null ? delta : prevBuffered?.delta,
          // delta-notional = |delta| × lotSize
          // this is the actual underlying exposure per 1 contract
          deltaNotional: delta !== null
            ? Math.abs(delta) * lotSize
            : prevBuffered?.deltaNotional,
          gamma: gamma ?? prevBuffered?.gamma ?? null,
          theta: theta ?? prevBuffered?.theta ?? null,
          lastUpdate: Date.now(),
        };

        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
        }
      },
      (status) => {
      }
    );
    wsRef.current = stream;
  }, [selExpiry, products, underlying, optionType]);

  // ── Scan for valid ratio spreads whenever ticker data changes ───────────
  useEffect(() => {
    if (!scanning || !spotPrice) return;

    const tickers = Object.values(tickerData);
    if (tickers.length < 2) return;

    // Sort by strike
    const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
    const validPairs = [];

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const buy = sorted[i]; // closer to spot = buy
        const sell = sorted[j]; // farther from spot = sell

        // Determine which is closer to spot
        const buyDistToSpot = Math.abs(buy.strike - spotPrice);
        const sellDistToSpot = Math.abs(sell.strike - spotPrice);

        // Buy should be closer to spot, sell should be farther
        let buyLeg, sellLeg;
        if (buyDistToSpot <= sellDistToSpot) {
          buyLeg = buy;
          sellLeg = sell;
        } else {
          buyLeg = sell;
          sellLeg = buy;
        }

        // ── Filter 1: Strike difference ≥ 800 ──
        const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
        if (strikeDiff < config.minStrikeDiff) continue;

        // ── Filter 2: IV difference > 5% ──
        if (buyLeg.iv == null || sellLeg.iv == null) continue;
        const ivDiff = Math.abs(buyLeg.iv - sellLeg.iv);
        if (ivDiff <= config.minIvDiff) continue;

        // ── Filter 3: Sell premium > $10 ──
        if (!sellLeg.markPrice || sellLeg.markPrice < config.minSellPremium) continue;

        // ── Filter 4: Premium ratio ≈ Delta-notional ratio ──
        // We use delta-notional (|delta| × lotSize) per leg so that
        // lot-size differences between strikes are accounted for.
        // If lot sizes are equal (typical on Delta Exchange for same expiry),
        // deltaNotionalRatio == |deltaCall| / |deltaSell| — same as before.
        // If they differ, the notional weighting corrects the ratio.
        const buyDN = buyLeg.deltaNotional;
        const sellDN = sellLeg.deltaNotional;

        if (buyDN == null || sellDN == null ||
          buyLeg.markPrice == null || sellLeg.markPrice == null ||
          buyLeg.markPrice === 0 || sellLeg.markPrice === 0 ||
          buyDN === 0 || sellDN === 0) continue;

        // Ratio of premiums (per contract, in $)
        const premiumRatio = buyLeg.markPrice / sellLeg.markPrice;

        // Ratio of delta-notionals — what the market's hedge ratio should be
        const deltaNotionalRatio = buyDN / sellDN;

        // Deviation tells us how far the premium ratio drifts from delta-notional ratio
        const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
        if (ratioDeviation > config.maxRatioDeviation) continue;

        // ── Recommended sell qty per 1 buy contract ──
        // To be delta-neutral: sellQty × sellDN = 1 × buyDN
        // => sellQty = buyDN / sellDN  (round to nearest integer ≥ 1)
        const rawQty = buyDN / sellDN;
        const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);

        // ── Filter 5: Buy closer to spot, sell farther — already ensured above ──

        validPairs.push({
          buyLeg,
          sellLeg,
          strikeDiff,
          ivDiff,
          premiumRatio: premiumRatio.toFixed(3),
          deltaNotionalRatio: deltaNotionalRatio.toFixed(3),
          ratioDeviation: (ratioDeviation * 100).toFixed(1),
          sellQty,
          // Cost to enter 1 buy + sellQty sells (net debit/credit in $)
          netPremium: (buyLeg.markPrice - sellQty * sellLeg.markPrice).toFixed(2),
          score: (1 / (ratioDeviation + 0.001)) * ivDiff * (strikeDiff / 1000),
        });
      }
    }

    // Sort by score descending
    validPairs.sort((a, b) => b.score - a.score);

    setResults(prev => {
      return validPairs;
    });
  }, [tickerData, scanning, spotPrice, config]);

  // ── Stop scanning ──────────────────────────────────────────────────────
  const stopScan = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    tickerBufferRef.current = {};
    setScanning(false);
    setExpectedTickerCount(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => {
    if (wsRef.current) wsRef.current.close();
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    if (spotIntervalRef.current) clearInterval(spotIntervalRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  const tickerCount = Object.keys(tickerData).length;
  const hasLiveFeed = scanning && tickerCount > 0;

  return (
    <div className="app">
      {/* Navbar */}
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="#0d1117" />
            <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
            <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
            <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
            <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
            <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
            <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
            <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
            <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
            <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
            <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
          </svg>
          VITTI OPTION<span>SCOPE</span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="nav-tab"
            onClick={() => onNavigate('charts')}
          >
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 20H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="7" y="12" width="3" height="6" rx="0.6" fill="currentColor" />
                <rect x="12" y="9" width="3" height="9" rx="0.6" fill="currentColor" />
                <rect x="17" y="6" width="3" height="12" rx="0.6" fill="currentColor" />
              </svg>
            </span> Charts
          </button>
          <button
            className="nav-tab active"
          >
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> Ratio Spread
          </button>
        </div>

        <div className="ws-badge">
          <div className={`ws-dot ${scanning ? 'live' : ''}`} />
          <span>{scanning ? `Scanning · ${tickerCount} tickers` : 'Idle'}</span>
        </div>
      </nav>

      <div className="body">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="card">
            <div className="card-title">Scanner Configuration</div>

            <div className="form-group">
              <label>Underlying</label>
              <select value={underlying} onChange={e => { setUnderlying(e.target.value); stopScan(); }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label>Expiry Date</label>
              <select value={selExpiry} onChange={e => { setSelExpiry(e.target.value); stopScan(); }} disabled={!expiries.length}>
                {!expiries.length
                  ? <option>Loading...</option>
                  : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)
                }
              </select>
            </div>

            <div className="form-group">
              <label>Option Type</label>
              <select value={optionType} onChange={e => { setOptionType(e.target.value); stopScan(); }}>
                <option value="call">Call Options</option>
                <option value="put">Put Options</option>
              </select>
            </div>

            <button
              className={`btn-start ${scanning ? 'btn-stop' : ''}`}
              onClick={scanning ? stopScan : startScan}
              disabled={!selExpiry}
            >
              {scanning ? '■  STOP SCANNER' : '▶  START SCANNER'}
            </button>
          </div>

          <div className="card">
            <div className="card-title">Filter Thresholds</div>
            <div className="form-group">
              <label>Min Strike Diff ($)</label>
              <input
                type="number"
                value={config.minStrikeDiff}
                onChange={e => setConfig(c => ({ ...c, minStrikeDiff: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group">
              <label>Min IV Diff (%)</label>
              <input
                type="number"
                value={config.minIvDiff}
                onChange={e => setConfig(c => ({ ...c, minIvDiff: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group">
              <label>Max Ratio Deviation</label>
              <input
                type="number"
                step="0.01"
                value={config.maxRatioDeviation}
                onChange={e => setConfig(c => ({ ...c, maxRatioDeviation: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group">
              <label>Min Sell Premium ($)</label>
              <input
                type="number"
                value={config.minSellPremium}
                onChange={e => setConfig(c => ({ ...c, minSellPremium: Number(e.target.value) }))}
              />
            </div>
          </div>

          {spotPrice && (
            <div className="card">
              <div className="card-title">Market Info</div>
              <div className="stat-row">
                <span className="stat-label">SPOT</span>
                <span className="stat-val" style={{ color: 'var(--accent)' }}>
                  ${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">MATCHES</span>
                <span className="stat-val" style={{ color: results.length > 0 ? 'var(--call)' : 'var(--text-dim)' }}>
                  {results.length}
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">TICKERS</span>
                <span className="stat-val" style={{ color: 'var(--text-dim)' }}>
                  {tickerCount}
                </span>
              </div>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="main" style={{ position: 'relative', padding: 12, gap: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Results Table */}
          <div className="scanner-table-wrap">
            <div className="scanner-table-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="scanner-pulse" data-active={scanning} />
                <span className="scanner-table-title">
                  RATIO SPREAD OPPORTUNITIES
                </span>
                <span className="scanner-table-subtitle">
                  {underlying} · {selExpiry ? fmtExpiry(selExpiry) : '—'} · {optionType.toUpperCase()}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {spotPrice && (
                  <span className="scanner-spot" style={{ color: 'var(--accent)' }}>
                    Spot price: {spotPrice.toFixed(4)}
                  </span>
                )}
                {results.length > 0 && (
                  <span className="scanner-match-badge">{results.length} match{results.length !== 1 ? 'es' : ''}</span>
                )}
              </div>
            </div>

            <div className="scanner-table-body">
              {!scanning && results.length === 0 && (
                <div className="scanner-empty">
                  <div className="scanner-empty-icon" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
                    </svg>
                  </div>
                  <div className="scanner-empty-title">RATIO SPREAD SCANNER</div>
                  <div className="scanner-empty-desc">
                    Configure filters and click START SCANNER to find optimal ratio spread opportunities in real-time.
                  </div>
                  <div className="scanner-empty-criteria">
                    <div>▹ Strike difference ≥ {config.minStrikeDiff}</div>
                    <div>▹ IV difference &gt; {config.minIvDiff}%</div>
                    <div>▹ Premium ratio ≈ Delta ratio (±{(config.maxRatioDeviation * 100).toFixed(0)}%)</div>
                    <div>▹ Sell premium &gt; ${config.minSellPremium}</div>
                    <div>▹ Buy leg closer to spot · Sell leg farther</div>
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
                      ? `Live ticker data received for ${tickerCount}${expectedTickerCount ? ` / ${expectedTickerCount}` : ''} instruments. Current filters have not produced a ratio spread match yet.`
                      : `Waiting for live ticker data${expectedTickerCount ? ` from ${expectedTickerCount} instruments` : ''}. Matches will appear here once quotes arrive.`}
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
                      <th>IV Diff</th>
                      <th>Buy Δ / Sell Δ</th>
                      <th>Buy/Sell Qty</th>
                      <th>Net Prem</th>
                      <th>Prem/ΔN Ratio</th>
                      <th>Dev %</th>
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
                        return groups[b][0].score - groups[a][0].score;
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
                              <td className="scanner-highlight">{bestRow.ivDiff.toFixed(1)}%</td>
                              <td style={{ fontWeight: 700 }}>
                                <div><span className='scanner-buy'>{bestRow.buyLeg.delta?.toFixed(4)}</span>/
                                  <span className='scanner-sell'>{bestRow.sellLeg.delta?.toFixed(4)}</span></div>
                              </td>
                              <td style={{ fontWeight: 700 }}>
                                <div><span className='scanner-buy'>{bestRow.buyLeg.lotSize}</span>/
                                  <span className='scanner-sell'>{bestRow.sellQty}</span></div>
                              </td>
                              <td className={parseFloat(bestRow.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                                ${Math.abs(parseFloat(bestRow.netPremium))}
                              </td>
                              <td>{bestRow.premiumRatio} / {bestRow.deltaNotionalRatio}</td>
                              <td className={parseFloat(bestRow.ratioDeviation) < 10 ? 'scanner-good' : 'scanner-warn'}>
                                {bestRow.ratioDeviation}%
                              </td>
                            </tr>

                            {/* Other rows for this strike */}
                            {isExpanded && others.map((r, subIdx) => (
                              <tr key={`${r.buyLeg.strike}-${r.sellLeg.strike}`} className="scanner-row-sub">
                                <td></td>
                                <td><div><span className="scanner-buy">{r.buyLeg.strike.toLocaleString()}</span>/<span className="scanner-sell">{r.sellLeg.strike.toLocaleString()}</span></div></td>
                                <td>{r.strikeDiff.toLocaleString()}</td>
                                <td><div><div className="scanner-buy">${r.buyLeg.markPrice?.toFixed(2)}</div><div>{r.buyLeg.iv?.toFixed(1)}%</div></div></td>
                                <td><div><div className="scanner-sell">${r.sellLeg.markPrice?.toFixed(2)}</div><div>{r.sellLeg.iv?.toFixed(1)}%</div></div></td>
                                <td className="scanner-highlight">{r.ivDiff.toFixed(1)}%</td>
                                <td style={{ fontWeight: 700 }}>
                                  <div><span className='scanner-buy'>{r.buyLeg.delta?.toFixed(4)}</span>/
                                    <span className='scanner-sell'>{r.sellLeg.delta?.toFixed(4)}</span></div>
                                </td>
                                <td style={{ fontWeight: 700 }}>
                                  <div><span className='scanner-buy'>{r.buyLeg.lotSize}</span>/
                                    <span className='scanner-sell'>{r.sellQty}</span></div>
                                </td>
                                <td className={parseFloat(r.netPremium) < 0 ? 'scanner-buy' : 'scanner-sell'}>
                                  ${Math.abs(parseFloat(r.netPremium))}
                                </td>
                                <td>{r.premiumRatio} / {r.deltaNotionalRatio}</td>
                                <td className={parseFloat(r.ratioDeviation) < 10 ? 'scanner-good' : 'scanner-warn'}>
                                  {r.ratioDeviation}%
                                </td>
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


        </main>
      </div>
    </div>
  );
}
