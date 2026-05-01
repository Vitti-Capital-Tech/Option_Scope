import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime } from './scannerUtils';

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
        <div style={{ display: 'flex', gap: 32, padding: '16px 24px', backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)' }}>ALGO CONFIG</span>
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
            <button className={`btn-start ${trading ? 'btn-stop' : ''}`} onClick={trading ? stopTrading : startTrading} disabled={!selExpiry} style={{ padding: '6px 16px', fontWeight: 600, marginLeft: 8 }}>
              {trading ? '■ STOP TRADING' : '▶ START TRADING'}
            </button>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={exportCSV}
            style={{
              background: 'transparent',
              color: '#3fb950',
              border: '1px solid #3fb950',
              padding: '4px 12px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s'
            }}
            onMouseOver={e => { e.target.style.background = 'rgba(63, 185, 80, 0.1)' }}
            onMouseOut={e => { e.target.style.background = 'transparent' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export CSV
          </button>
        </div>

        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Active Positions Table */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Active Positions ({positions.length})</span>
              {trading && <span style={{ fontSize: 10, color: '#3fb950', display: 'flex', alignItems: 'center', gap: 4 }}>
                <div className="ws-dot live" style={{ width: 6, height: 6 }} /> Monitoring Live
              </span>}
            </div>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Buy Strike</th>
                  <th>Sell Strike</th>
                  <th>Sell Qty</th>
                  <th>Entry Net</th>
                  <th>Current Net</th>
                  <th>Unrl PnL</th>
                  <th>Margin Req</th>
                  <th>Duration</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr><td colSpan="10" style={{ textAlign: 'center', padding: 24, color: 'var(--text-dim)' }}>No active positions. Algo will enter automatically.</td></tr>
                ) : positions.map(p => {
                  const entryNet = p.entryBuyPrice - (p.sellQty * p.entrySellPrice);
                  const currentNet = p.currentBuyPrice - (p.sellQty * p.currentSellPrice);
                  const pnlColor = p.unrealizedPnl >= 0 ? '#3fb950' : '#f85149';
                  const duration = Math.floor((new Date() - p.entryTime) / 1000);
                  return (
                    <tr key={p.id}>
                      <td style={{ color: p.type === 'call' ? '#00d9a3' : '#ff2ebd', fontWeight: 600 }}>{p.type.toUpperCase()}</td>
                      <td>{p.buyLeg.strike}</td>
                      <td>{p.sellLeg.strike}</td>
                      <td>{p.sellQty}x</td>
                      <td>{entryNet.toFixed(2)}</td>
                      <td>{currentNet.toFixed(2)}</td>
                      <td style={{ color: pnlColor, fontWeight: 600 }}>{p.unrealizedPnl > 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)}</td>
                      <td>{p.margin.toFixed(2)}</td>
                      <td>{duration}s</td>
                      <td>
                        <button
                          onClick={() => closePosition(p.id)}
                          style={{
                            background: 'rgba(248, 81, 73, 0.1)',
                            color: '#f85149',
                            border: '1px solid rgba(248, 81, 73, 0.2)',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '10px',
                            cursor: 'pointer'
                          }}
                        >
                          CLOSE
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Trade History Table */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Trade History ({tradeHistory.length})</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>Auto-updates on exit</span>
            </div>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Buy / Sell Strike</th>
                  <th>Realized PnL</th>
                  <th>Margin Req</th>
                  <th>Exit Reason</th>
                </tr>
              </thead>
              <tbody>
                {tradeHistory.length === 0 ? (
                  <tr><td colSpan="6" style={{ textAlign: 'center', padding: 24, color: 'var(--text-dim)' }}>No closed trades yet.</td></tr>
                ) : tradeHistory.map((t, i) => {
                  const pnlColor = t.realizedPnl >= 0 ? '#3fb950' : '#f85149';
                  return (
                    <tr key={i}>
                      <td>{formatTime(t.exitTime)}</td>
                      <td style={{ color: t.type === 'call' ? '#00d9a3' : '#ff2ebd', fontWeight: 600 }}>{t.type.toUpperCase()}</td>
                      <td>{t.buyLeg.strike} / {t.sellLeg.strike}</td>
                      <td style={{ color: pnlColor, fontWeight: 600 }}>{t.realizedPnl > 0 ? '+' : ''}{t.realizedPnl.toFixed(2)}</td>
                      <td>{t.margin.toFixed(2)}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t.exitReason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
