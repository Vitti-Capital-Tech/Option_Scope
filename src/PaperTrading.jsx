import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime } from './scannerUtils';
import { useTabListener } from './useTabSync';

const UNDERLYINGS = ['BTC', 'ETH'];

export default function PaperTrading({ onNavigate, theme, toggleTheme }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [spotPrice, setSpotPrice] = useState(null);
  const [trading, setTrading] = useState(false);

  const [positions, setPositions] = useState([]); // Active positions
  const [tradeHistory, setTradeHistory] = useState([]); // Closed trades

  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);

  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);

  const [config, setConfig] = useState({
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
  });

  const positionsRef = useRef([]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData({ ...latestTickerDataRef.current });
  }, []);

  // ── Load products ──────────────────────────────────
  useEffect(() => {
    setExpiries([]); setSelExpiry('');
    setTickerData({});
    setExpectedTickerCount(0);
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

  const startTrading = useCallback(() => {
    if (!selExpiry || !products.length) return;

    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};

    setTrading(true);
    setPositions([]);
    setTradeHistory([]);
    setTickerData({});
    latestTickerDataRef.current = {};
    setExpectedTickerCount(0);

    const strikes = getStrikes(products, selExpiry);
    if (strikes.length < 2) {
      setTrading(false);
      return;
    }

    const symbolMeta = {};
    for (const strike of strikes) {
      const callProd = products.find(p => p.settlement_time === selExpiry && parseFloat(p.strike_price) === parseFloat(strike) && matchesOptionType(p, 'call'));
      if (callProd) {
        const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
        symbolMeta[callProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'call', symbol: callProd.symbol };
      }
      const putProd = products.find(p => p.settlement_time === selExpiry && parseFloat(p.strike_price) === parseFloat(strike) && matchesOptionType(p, 'put'));
      if (putProd) {
        const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
        symbolMeta[putProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'put', symbol: putProd.symbol };
      }
    }

    const allSymbols = Object.keys(symbolMeta);
    setExpectedTickerCount(allSymbols.length);

    wsRef.current = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        const markPrice = toFiniteNumber(msg.mark_price ?? msg.close ?? msg.last_price);
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;

        const meta = symbolMeta[sym];
        if (!meta) return;

        const prevBuffered = tickerBufferRef.current[sym] ?? tickerData[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym,
          strike: meta.strike,
          lotSize: meta.lotSize,
          type: meta.type,
          markPrice: markPrice ?? prevBuffered?.markPrice ?? null,
          iv: iv ?? prevBuffered?.iv ?? null,
          delta: delta !== null ? delta : prevBuffered?.delta,
          deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prevBuffered?.deltaNotional,
        };

        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTickerBuffer, 200);
      },
      () => { }
    );
  }, [selExpiry, products, underlying, tickerData, flushTickerBuffer]);

  const stopTrading = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(false);
  }, []);

  // Paper Trading Engine
  useEffect(() => {
    if (!trading || !spotPrice) return;

    const allTickers = Object.values(tickerData);
    if (allTickers.length < expectedTickerCount * 0.1) return; // Wait for enough data

    let atmStrike = null;
    let minDiff = Infinity;
    for (const t of allTickers) {
      const diff = Math.abs(t.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = t.strike;
      }
    }

    const scanTickers = (tickers) => {
      const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
      const validPairs = [];
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const buy = sorted[i];
          const sell = sorted[j];
          const buyDist = Math.abs(buy.strike - spotPrice);
          const sellDist = Math.abs(sell.strike - spotPrice);
          let buyLeg, sellLeg;
          if (buyDist <= sellDist) { buyLeg = buy; sellLeg = sell; }
          else { buyLeg = sell; sellLeg = buy; }

          const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
          if (strikeDiff < config.minStrikeDiff) continue;
          if (buyLeg.iv == null || sellLeg.iv == null) continue;
          const ivDiff = Math.abs(buyLeg.iv - sellLeg.iv);
          if (ivDiff <= config.minIvDiff) continue;
          if (!sellLeg.markPrice || sellLeg.markPrice < config.minSellPremium) continue;

          const buyDN = buyLeg.deltaNotional;
          const sellDN = sellLeg.deltaNotional;
          if (!buyDN || !sellDN || !buyLeg.markPrice || !sellLeg.markPrice) continue;

          const ratioDeviation = Math.abs((buyLeg.markPrice / sellLeg.markPrice) - (buyDN / sellDN)) / (buyDN / sellDN);
          if (ratioDeviation > config.maxRatioDeviation) continue;

          const sellQty = Math.max(1, Math.round((buyDN / sellDN) / 0.25) * 0.25);
          validPairs.push({ buyLeg, sellLeg, strikeDiff, sellQty, netPremium: buyLeg.markPrice - sellQty * sellLeg.markPrice });
        }
      }
      validPairs.sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        if (distA !== distB) return distB - distA;
        return a.netPremium - b.netPremium;
      });
      return validPairs.slice(0, 3); // TOP 3
    };

    const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
    const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));

    const topCalls = scanTickers(callTickers);
    const topPuts = scanTickers(putTickers);
    const topSpreads = [...topCalls, ...topPuts];

    const currentTopIds = new Set(topSpreads.map(s => `${s.buyLeg.symbol}_${s.sellLeg.symbol}`));

    // Update active positions
    setPositions(prev => {
      const remaining = [];
      const exited = [];

      for (const pos of prev) {
        let shouldExit = false;
        let exitReason = '';

        // 1. If strike changes (loses its top 3 position)
        if (!currentTopIds.has(pos.id)) {
          shouldExit = true;
          exitReason = 'Lost Top 3 Position';
        } else {
          // 2. If strike doesnt change, check exit conditions based on diff
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;

          if (pos.strikeDiff < 1000) {
            // Exit when buying strike reaches ATM or ITM
            const isAtOrItm = isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike;
            if (isAtOrItm) {
              shouldExit = true;
              exitReason = 'Buy Strike reached ATM/ITM (<1000 diff)';
            }
          } else if (pos.strikeDiff < 1200) {
            // Exit at 200 points ITM
            const itmPoints = isCall ? spotPrice - buyStrike : buyStrike - spotPrice;
            if (itmPoints >= 200) {
              shouldExit = true;
              exitReason = '200 points ITM (<1200 diff)';
            }
          } else if (pos.strikeDiff < 1400) {
            // Exit at 300 points ITM
            const itmPoints = isCall ? spotPrice - buyStrike : buyStrike - spotPrice;
            if (itmPoints >= 300) {
              shouldExit = true;
              exitReason = '300 points ITM (<1400 diff)';
            }
          }
        }

        // Get latest prices for PnL
        const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice || pos.buyLeg.markPrice;
        const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice || pos.sellLeg.markPrice;

        // Include lotSize in PnL calculation
        const buyPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
        const sellPnl = (latestSell - pos.entrySellPrice) * pos.sellLeg.lotSize * pos.sellQty;
        const currentPnl = buyPnl - sellPnl;

        if (shouldExit) {
          exited.push({
            ...pos,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            realizedPnl: currentPnl,
            exitReason
          });
        } else {
          remaining.push({
            ...pos,
            currentBuyPrice: latestBuy,
            currentSellPrice: latestSell,
            unrealizedPnl: currentPnl
          });
        }
      }

      // Record exited trades
      if (exited.length > 0) {
        setTradeHistory(th => [...exited, ...th]);
      }

      // Open new positions from top 3 that are not active
      for (const spread of topSpreads) {
        const id = `${spread.buyLeg.symbol}_${spread.sellLeg.symbol}`;
        const exists = remaining.find(p => p.id === id);
        if (!exists) {
          // Margin: 100% for long (1x), 200x leverage for short leg (Value / 200)
          const longMargin = spread.buyLeg.markPrice * spread.buyLeg.lotSize * 1;
          const shortMargin = (spread.sellLeg.markPrice * spread.sellLeg.lotSize * spread.sellQty) / 200;
          const margin = longMargin + shortMargin;
          remaining.push({
            id,
            type: spread.buyLeg.type,
            buyLeg: spread.buyLeg,
            sellLeg: spread.sellLeg,
            sellQty: spread.sellQty,
            strikeDiff: spread.strikeDiff,
            entryTime: new Date(),
            entryBuyPrice: spread.buyLeg.markPrice,
            entrySellPrice: spread.sellLeg.markPrice,
            currentBuyPrice: spread.buyLeg.markPrice,
            currentSellPrice: spread.sellLeg.markPrice,
            margin: margin,
            unrealizedPnl: 0,
          });
        }
      }

      return remaining;
    });

  }, [tickerData, trading, spotPrice, config, expectedTickerCount]);

  const closePosition = (posId, reason = 'Manual Exit') => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === posId);
      if (!pos) return prev;

      const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice || pos.buyLeg.markPrice;
      const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice || pos.sellLeg.markPrice;
      const buyPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
      const sellPnl = (latestSell - pos.entrySellPrice) * pos.sellLeg.lotSize * pos.sellQty;
      const realizedPnl = buyPnl - sellPnl;

      const exitedTrade = {
        ...pos,
        exitTime: new Date(),
        exitBuyPrice: latestBuy,
        exitSellPrice: latestSell,
        realizedPnl,
        exitReason: reason
      };

      setTradeHistory(th => [exitedTrade, ...th]);
      return prev.filter(p => p.id !== posId);
    });
  };

  useEffect(() => () => {
    if (wsRef.current) wsRef.current.close();
    if (spotIntervalRef.current) clearInterval(spotIntervalRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  // ── Cross-tab sync ──────────────────────────────────
  const startTradingRef = useRef(startTrading);
  startTradingRef.current = startTrading;
  const stopTradingRef = useRef(stopTrading);
  stopTradingRef.current = stopTrading;

  const { broadcast: tabBroadcast } = useTabListener({
    TRADING_START: (payload) => {
      if (payload.underlying) setUnderlying(payload.underlying);
      if (payload.expiry) setSelExpiry(payload.expiry);
      setTimeout(() => startTradingRef.current(), 100);
    },
    TRADING_STOP: () => {
      stopTradingRef.current();
    },
  });

  const handleStartTrading = useCallback(() => {
    startTrading();
    tabBroadcast('TRADING_START', { underlying, expiry: selExpiry });
  }, [startTrading, tabBroadcast, underlying, selExpiry]);

  const handleStopTrading = useCallback(() => {
    stopTrading();
    tabBroadcast('TRADING_STOP', {});
  }, [stopTrading, tabBroadcast]);

  const exportCSV = () => {
    if (!tradeHistory.length) {
      alert('Trade history is empty. Export will be available once trades are closed.');
      return;
    }
    const headers = ['Entry Time', 'Exit Time', 'Type', 'Buy Strike', 'Sell Strike', 'Sell Qty', 'Entry Net Premium', 'Exit Net Premium', 'Realized PnL', 'Margin', 'Exit Reason'];
    const rows = tradeHistory.map(t => {
      const entryNet = t.entryBuyPrice - (t.sellQty * t.entrySellPrice);
      const exitNet = t.exitBuyPrice - (t.sellQty * t.exitSellPrice);
      return [
        formatTime(t.entryTime),
        formatTime(t.exitTime),
        t.type.toUpperCase(),
        t.buyLeg.strike,
        t.sellLeg.strike,
        t.sellQty,
        entryNet.toFixed(2),
        exitNet.toFixed(2),
        t.realizedPnl.toFixed(2),
        t.margin.toFixed(2),
        t.exitReason
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paper_trades_${new Date().getTime()}.csv`;
    a.click();
  };

  // ── KPI Computations ──────────────────────────────────
  const totalUnrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const totalRealizedPnl = tradeHistory.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const totalPnl = totalUnrealizedPnl + totalRealizedPnl;
  const wins = tradeHistory.filter(t => t.realizedPnl > 0).length;
  const winRate = tradeHistory.length > 0 ? ((wins / tradeHistory.length) * 100).toFixed(1) : '—';
  const totalMargin = positions.reduce((s, p) => s + (p.margin || 0), 0);

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const exitBadgeClass = (reason) => {
    if (reason.includes('Manual')) return 'manual';
    if (reason.includes('Top 3')) return 'position';
    if (reason.includes('ITM')) return 'itm';
    if (reason.includes('ATM')) return 'atm';
    return 'position';
  };

  return (
    <div className="app">
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
            className="nav-tab"
            onClick={() => onNavigate('scanner')}
          >
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> Ratio Spread
          </button>
          <button
            className="nav-tab active"
          >
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> Paper Trading
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
          <div className="ws-badge">
            <div className={`ws-dot ${trading ? 'live' : ''}`} />
            <span>{trading ? 'Trading Live' : 'Idle'}</span>
          </div>
        </div>
      </nav>

      <div className="body" style={{ flexDirection: 'column', overflowY: 'auto' }}>
        {/* ── Control Panel ───────────────────────────── */}
        <div className="pt-control-panel">
          <div className="pt-control-section">
            <span className="pt-control-label">Algo</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Underlying:</label>
              <select value={underlying} onChange={e => { setUnderlying(e.target.value); stopTrading(); }} style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => { setSelExpiry(e.target.value); stopTrading(); }} disabled={!expiries.length} style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
                {!expiries.length ? <option>Loading...</option> : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
              </select>
            </div>
          </div>

          {spotPrice && (
            <div className="pt-spot-display">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
            </div>
          )}

          <button className={`pt-btn-trade ${trading ? 'stop' : 'start'}`} onClick={trading ? handleStopTrading : handleStartTrading} disabled={!selExpiry}>
            {trading ? (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> STOP TRADING</>
            ) : (
              <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> START TRADING</>
            )}
          </button>

          <div style={{ flex: 1 }} />

          <button className="pt-btn-export" onClick={exportCSV}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export CSV
          </button>
        </div>

        {/* ── KPI Dashboard ───────────────────────────── */}
        <div className="pt-kpi-strip">
          <div className={`pt-kpi-card ${totalPnl >= 0 ? 'accent-green' : 'accent-red'}`}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5"/></svg>
              Total P&L
            </span>
            <span className={`pt-kpi-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral'}`}>
              {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Realized: {totalRealizedPnl.toFixed(2)} | Unrl: {totalUnrealizedPnl.toFixed(2)}</span>
          </div>

          <div className="pt-kpi-card accent-gold">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>
              Win Rate
            </span>
            <span className="pt-kpi-value neutral">{winRate}{winRate !== '—' ? '%' : ''}</span>
            <span className="pt-kpi-sub">{wins}W / {tradeHistory.length - wins}L of {tradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.length}</span>
            <span className="pt-kpi-sub">{positions.filter(p => p.type === 'call').length} calls / {positions.filter(p => p.type === 'put').length} puts</span>
          </div>

          <div className="pt-kpi-card accent-purple">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
              Trades
            </span>
            <span className="pt-kpi-value neutral">{tradeHistory.length}</span>
            <span className="pt-kpi-sub">Closed positions</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>
              Margin Used
            </span>
            <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
            <span className="pt-kpi-sub">Across {positions.length} position{positions.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className={`pt-section ${trading ? 'live' : ''}`}>
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                Active Positions
                <span className="pt-section-count">{positions.length}</span>
              </div>
              {trading && (
                <div className="pt-live-badge">
                  <div className="pt-live-dot" />
                  Monitoring
                </div>
              )}
            </div>
            {positions.length === 0 ? (
              <div className="pt-empty">
                <div className={`pt-empty-icon ${trading ? 'scanning' : 'idle'}`}>
                  {trading ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0ecb81" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite"/></path></svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                  )}
                </div>
                <span className="pt-empty-title">{trading ? 'Scanning for Opportunities...' : 'Algo Idle'}</span>
                <span className="pt-empty-desc">{trading ? 'The engine is analyzing live option chains for ratio spread entries. Positions will appear here automatically.' : 'Select expiry and click Start Trading to begin automated ratio spread scanning.'}</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type</th><th>Buy Strike</th><th>Sell Strike</th><th>Sell Qty</th>
                    <th>Entry Net</th><th>Current Net</th><th>Unrl P&L</th>
                    <th>Margin</th><th>Duration</th><th>Action</th>
                  </tr></thead>
                  <tbody>
                    {positions.map(p => {
                      const entryNet = p.entryBuyPrice - (p.sellQty * p.entrySellPrice);
                      const currentNet = p.currentBuyPrice - (p.sellQty * p.currentSellPrice);
                      const pnlClass = p.unrealizedPnl > 0 ? 'positive' : p.unrealizedPnl < 0 ? 'negative' : 'zero';
                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td><span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span></td>
                          <td className="pt-strike pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</td>
                          <td className="pt-strike pt-strike-sell">{p.sellLeg.strike.toLocaleString()}</td>
                          <td>{p.sellQty}x</td>
                          <td>{entryNet.toFixed(2)}</td>
                          <td>{currentNet.toFixed(2)}</td>
                          <td><span className={`pt-pnl ${pnlClass}`}>{p.unrealizedPnl > 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)}</span></td>
                          <td>
                            <div className="pt-margin-cell">
                              <span>${p.margin.toFixed(0)}</span>
                              <div className="pt-margin-bar"><div className="pt-margin-fill" style={{ width: `${Math.min(100, (p.margin / (totalMargin || 1)) * 100)}%` }} /></div>
                            </div>
                          </td>
                          <td><span className="pt-duration">{fmtDuration(new Date() - p.entryTime)}</span></td>
                          <td><button className="pt-btn-close" onClick={() => closePosition(p.id)}>✕ Close</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Trade History ────────────────────────── */}
          <div className="pt-section">
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                Trade History
                <span className="pt-section-count">{tradeHistory.length}</span>
              </div>
              {tradeHistory.length > 0 && (
                <div className="pt-history-stats">
                  <span className="pt-history-stat">Net: <span className={`value ${totalRealizedPnl >= 0 ? 'green' : 'red'}`}>{totalRealizedPnl > 0 ? '+' : ''}{totalRealizedPnl.toFixed(2)}</span></span>
                  <span className="pt-history-stat">W/L: <span className="value green">{wins}</span>/<span className="value red">{tradeHistory.length - wins}</span></span>
                </div>
              )}
            </div>
            {tradeHistory.length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon idle">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                </div>
                <span className="pt-empty-title">No Closed Trades</span>
                <span className="pt-empty-desc">Trades will appear here once positions are exited — either automatically by the algo or manually by you.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Exit Time</th><th>Type</th><th>Buy / Sell Strike</th>
                    <th>Realized P&L</th><th>Margin</th><th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {tradeHistory.map((t, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--text-dim)' }}>{formatTime(t.exitTime)}</td>
                        <td><span className={`pt-type-badge ${t.type}`}>{t.type.toUpperCase()}</span></td>
                        <td>
                          <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                          <span className="pt-strike-separator"> / </span>
                          <span className="pt-strike-sell">{t.sellLeg.strike.toLocaleString()}</span>
                        </td>
                        <td><span className={`pt-pnl ${t.realizedPnl > 0 ? 'positive' : t.realizedPnl < 0 ? 'negative' : 'zero'}`}>{t.realizedPnl > 0 ? '+' : ''}{t.realizedPnl.toFixed(2)}</span></td>
                        <td>${t.margin.toFixed(0)}</td>
                        <td><span className={`pt-exit-badge ${exitBadgeClass(t.exitReason)}`}>{t.exitReason}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
