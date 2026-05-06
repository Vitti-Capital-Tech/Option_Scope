import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';
import { useTabListener } from './useTabSync';

const UNDERLYINGS = ['BTC', 'ETH'];
const SCANNER_TOP_KEY = 'vitti_scanner_top_spreads_v1';

import ResultTable from './ResultTable';
import { normalizeIv, toFiniteNumber, matchesOptionType } from './scannerUtils';


// ── Main Scanner Component ──────────────────────────────────────────────────
export default function RatioSpreadScanner({ onNavigate, theme, toggleTheme }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [spotPrice, setSpotPrice] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [resultsCall, setResultsCall] = useState([]);
  const [resultsPut, setResultsPut] = useState([]);
  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);

  const wsRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);

  // Configurable thresholds initialized from localStorage
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('vitti_algo_config');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { }
    }
    return {
      minStrikeDiff: 800,
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
    };
  });

  const pickTopUniqueBuyStrikes = useCallback((spreads, limit = 3) => {
    const out = [];
    const seenBuyStrikes = new Set();
    for (const s of spreads) {
      const buyStrike = s?.buyLeg?.strike;
      if (buyStrike == null) continue;
      if (seenBuyStrikes.has(buyStrike)) continue;
      seenBuyStrikes.add(buyStrike);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }, []);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData(latestTickerDataRef.current);
  }, []);

  const broadcastScannerTopSpreads = useCallback((payload) => {
    try {
      const ch = new BroadcastChannel('option-scope-sync');
      ch.postMessage({ type: 'SCANNER_TOP_SPREADS_SYNC', payload, senderId: 'scanner', timestamp: Date.now() });
      ch.close();
    } catch (e) { }
  }, []);

  const publishTopSpreads = useCallback((calls, puts) => {
    const topCalls = pickTopUniqueBuyStrikes(calls, 3);
    const topPuts = pickTopUniqueBuyStrikes(puts, 3);
    const payload = {
      underlying,
      expiry: selExpiry,
      timestamp: Date.now(),
      callTop3: topCalls.map(s => ({
        id: `${s.buyLeg.symbol}_${s.sellLeg.symbol}`,
        buySymbol: s.buyLeg.symbol,
        sellSymbol: s.sellLeg.symbol,
        buyStrike: s.buyLeg.strike,
        sellQty: s.sellQty
      })),
      putTop3: topPuts.map(s => ({
        id: `${s.buyLeg.symbol}_${s.sellLeg.symbol}`,
        buySymbol: s.buyLeg.symbol,
        sellSymbol: s.sellLeg.symbol,
        buyStrike: s.buyLeg.strike,
        sellQty: s.sellQty
      }))
    };
    localStorage.setItem(SCANNER_TOP_KEY, JSON.stringify(payload));
    broadcastScannerTopSpreads(payload);
  }, [underlying, selExpiry, broadcastScannerTopSpreads, pickTopUniqueBuyStrikes]);

  // ── Load products on underlying change ──────────────────────────────────
  useEffect(() => {
    setExpiries([]); setSelExpiry(''); setResultsCall([]); setResultsPut([]);
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
    setResultsCall([]);
    setResultsPut([]);
    setTickerData({});
    latestTickerDataRef.current = {};
    setExpectedTickerCount(0);
    setLastRefreshed(0);

    // Get all strikes for this expiry
    const strikes = getStrikes(products, selExpiry);

    if (strikes.length < 2) {
      setScanning(false);
      return;
    }

    const symbolMeta = {};     // symbol -> { strike, lotSize, type }
    for (const strike of strikes) {
      // Find Call
      const callProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'call')
      );
      if (callProd) {
        const sym = callProd.symbol;
        const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
        symbolMeta[sym] = { strike: parseFloat(strike), lotSize, type: 'call' };
      }

      // Find Put
      const putProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'put')
      );
      if (putProd) {
        const sym = putProd.symbol;
        const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
        symbolMeta[sym] = { strike: parseFloat(strike), lotSize, type: 'put' };
      }
    }

    const allSymbols = Object.keys(symbolMeta);
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

        const { strike, lotSize, type } = meta;
        const prevBuffered = tickerBufferRef.current[sym] ?? tickerData[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym,
          strike,
          lotSize,
          type,
          markPrice: markPrice ?? prevBuffered?.markPrice ?? null,
          iv: iv ?? prevBuffered?.iv ?? null,
          delta: delta !== null ? delta : prevBuffered?.delta,
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
  }, [selExpiry, products, underlying]);

  // ── Compute Spreads Logic ───────────
  const computeSpreads = useCallback((force = false) => {
    if (!scanning || !spotPrice) return;

    const scanTickers = (tickers) => {
      if (tickers.length < 2) return [];

      const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
      const validPairs = [];

      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const buy = sorted[i];
          const sell = sorted[j];

          let buyLeg, sellLeg;
          if (buy.type === 'call') {
            buyLeg = buy; sellLeg = sell; // Call: buy lower, sell higher
          } else {
            buyLeg = sell; sellLeg = buy; // Put: buy higher, sell lower
          }

          const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
          if (strikeDiff < config.minStrikeDiff) continue;

          if (buyLeg.iv == null || sellLeg.iv == null) continue;
          const ivDiff = Math.abs(buyLeg.iv - sellLeg.iv);
          if (ivDiff <= config.minIvDiff) continue;

          if (!sellLeg.markPrice || sellLeg.markPrice < config.minSellPremium) continue;

          const buyDN = buyLeg.deltaNotional;
          const sellDN = sellLeg.deltaNotional;

          if (buyDN == null || sellDN == null ||
            buyLeg.markPrice == null || sellLeg.markPrice == null ||
            buyLeg.markPrice === 0 || sellLeg.markPrice === 0 ||
            buyDN === 0 || sellDN === 0) continue;

          const premiumRatio = buyLeg.markPrice / sellLeg.markPrice;
          const deltaNotionalRatio = buyDN / sellDN;

          const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
          if (ratioDeviation > config.maxRatioDeviation) continue;

          const rawQty = buyDN / sellDN;
          const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
          const deltaDiff = buyDN - sellQty * sellDN;

          const netPrem = buyLeg.markPrice - sellQty * sellLeg.markPrice;

          // Filter by Net Premium: Enforce a symmetric band [-max, +max]
          // If maxNetPremium is 20, we allow netPremium from -20 (max credit) to +20 (max debit).
          const maxNet = Math.abs(config.maxNetPremium);
          if (netPrem < -maxNet || netPrem > maxNet) continue;

          validPairs.push({
            buyLeg,
            sellLeg,
            strikeDiff,
            ivDiff,
            premiumRatio: premiumRatio.toFixed(3),
            deltaNotionalRatio: deltaNotionalRatio.toFixed(3),
            ratioDeviation: (ratioDeviation * 100).toFixed(1),
            sellQty,
            netPremium: netPrem.toFixed(2),
            deltaDiff,
            thetaDiff: (buyLeg.theta || 0) - (sellQty * (sellLeg.theta || 0)),
            gammaDiff: (buyLeg.gamma || 0) - (sellQty * (sellLeg.gamma || 0)),
            vegaDiff: (buyLeg.vega || 0) - (sellQty * (sellLeg.vega || 0)),
            rhoDiff: (buyLeg.rho || 0) - (sellQty * (sellLeg.rho || 0)),
          });
        }
      }

      // Sort: closest to ATM first, then by net premium ascending
      validPairs.sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        if (distA !== distB) return distA - distB;
        return a.netPremium - b.netPremium;
      });
      return validPairs;
    };

    const allTickers = Object.values(latestTickerDataRef.current);

    // Find ATM strike (closest to spotPrice)
    let atmStrike = null;
    let minDiff = Infinity;
    for (const t of allTickers) {
      const diff = Math.abs(t.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = t.strike;
      }
    }

    // For Call: ATM or OTM means strike >= atmStrike
    const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
    // For Put: ATM or OTM means strike <= atmStrike
    const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));

    const nextCalls = scanTickers(callTickers);
    const nextPuts = scanTickers(putTickers);
    setResultsCall(nextCalls);
    setResultsPut(nextPuts);
    publishTopSpreads(nextCalls, nextPuts);
    setLastRefreshed(Date.now());

  }, [scanning, spotPrice, config, publishTopSpreads]);

  // Periodic and conditional scanning
  useEffect(() => {
    if (!scanning || !spotPrice) return;

    const nowTime = Date.now();
    const currentMinute = Math.floor(nowTime / 60000);
    const lastMinute = Math.floor(lastRefreshed / 60000);

    // Initial scan or new minute
    if (lastRefreshed === 0 || currentMinute > lastMinute) {
      computeSpreads();
      return;
    }

    // Fast-track initial results if we have enough data but no results yet
    const allTickers = Object.values(tickerData);
    if (resultsCall.length === 0 && resultsPut.length === 0 && allTickers.length > expectedTickerCount * 0.1) {
      const elapsedSinceLast = nowTime - lastRefreshed;
      if (elapsedSinceLast > 2000) {
        computeSpreads();
      }
    }
  }, [tickerData, scanning, spotPrice, expectedTickerCount, lastRefreshed, computeSpreads, resultsCall.length, resultsPut.length]);

  // Countdown timer for Refresh button
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const nextMinute = (Math.floor(now / 60000) + 1) * 60000;
      const left = Math.ceil((nextMinute - now) / 1000);
      setTimeRemaining(left > 0 ? (left > 60 ? 60 : left) : 0);
    }, 1000);

    const now = Date.now();
    const nextMinute = (Math.floor(now / 60000) + 1) * 60000;
    const left = Math.ceil((nextMinute - now) / 1000);
    setTimeRemaining(left > 0 ? (left > 60 ? 60 : left) : 0);

    return () => clearInterval(timer);
  }, [lastRefreshed, scanning]);

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
    const payload = { underlying, expiry: selExpiry, timestamp: Date.now(), callTop3: [], putTop3: [] };
    localStorage.setItem(SCANNER_TOP_KEY, JSON.stringify(payload));
    broadcastScannerTopSpreads(payload);
  }, [underlying, selExpiry, broadcastScannerTopSpreads]);

  // ── Cross-tab sync ─────────────────────────────────────────────────────
  const startScanRef = useRef(startScan);
  startScanRef.current = startScan;
  const stopScanRef = useRef(stopScan);
  stopScanRef.current = stopScan;

  const { broadcast: tabBroadcast } = useTabListener({
    SCANNER_START: (payload) => {
      // Sync underlying + expiry first, then start
      if (payload.underlying) setUnderlying(payload.underlying);
      if (payload.expiry) setSelExpiry(payload.expiry);
      // Delay start to let state settle
      setTimeout(() => startScanRef.current(), 100);
    },
    SCANNER_STOP: () => {
      stopScanRef.current();
    },
    CONFIG_SYNC: (payload) => {
      if (payload.config) setConfig(payload.config);
    }
  });

  const updateConfig = (key, value) => {
    setConfig(c => {
      const newConfig = { ...c, [key]: value };
      localStorage.setItem('vitti_algo_config', JSON.stringify(newConfig));
      tabBroadcast('CONFIG_SYNC', { config: newConfig });
      return newConfig;
    });
  };

  // Wrapped start/stop that also broadcasts to other tabs
  const handleStartScan = useCallback(() => {
    startScan();
    tabBroadcast('SCANNER_START', { underlying, expiry: selExpiry });
  }, [startScan, tabBroadcast, underlying, selExpiry]);

  const handleStopScan = useCallback(() => {
    stopScan();
    tabBroadcast('SCANNER_STOP', {});
  }, [stopScan, tabBroadcast]);

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
          <button
            className="nav-tab"
            onClick={() => onNavigate('trading')}
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
            <div className={`ws-dot ${scanning ? 'live' : ''}`} />
            <span>{scanning ? `Scanning · ${tickerCount} tickers` : 'Idle'}</span>
          </div>
        </div>
      </nav>

      <div className="body" style={{ flexDirection: 'column' }}>
        {/* Topbar Configuration */}
        <div style={{
          display: 'flex', gap: 32, padding: '16px 24px',
          backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
          alignItems: 'center', flexWrap: 'wrap'
        }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.5px' }}>SCANNER CONFIG</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Underlying:</label>
              <select value={underlying} onChange={e => { setUnderlying(e.target.value); stopScan(); }} style={{ padding: '4px 8px', width: 'auto' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => { setSelExpiry(e.target.value); stopScan(); }} disabled={!expiries.length} style={{ padding: '4px 8px', width: 'auto' }}>
                {!expiries.length
                  ? <option>Loading...</option>
                  : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)
                }
              </select>
            </div>
            <button
              className={`btn-start ${scanning ? 'btn-stop' : ''}`}
              onClick={scanning ? handleStopScan : handleStartScan}
              disabled={!selExpiry}
              style={{ padding: '6px 16px', fontSize: 13, fontWeight: 600, marginLeft: 8 }}
            >
              {scanning ? '■ STOP SCAN' : '▶ START SCAN'}
            </button>
          </div>

          <div style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.5px' }}>FILTERS</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Strike Diff ($):</label>
              <input
                type="number"
                value={config.minStrikeDiff}
                onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))}
                style={{ width: 60, padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min IV Diff (%):</label>
              <input
                type="number"
                value={config.minIvDiff}
                onChange={e => updateConfig('minIvDiff', Number(e.target.value))}
                style={{ width: 50, padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Ratio Dev:</label>
              <input
                type="number"
                step="0.01"
                value={config.maxRatioDeviation}
                onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))}
                style={{ width: 60, padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Sell Prem ($):</label>
              <input
                type="number"
                value={config.minSellPremium}
                onChange={e => updateConfig('minSellPremium', Number(e.target.value))}
                style={{ width: 50, padding: '4px 8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Debit ($):</label>
              <input
                type="number"
                value={config.maxNetPremium}
                onChange={e => updateConfig('maxNetPremium', Number(e.target.value))}
                style={{ width: 60, padding: '4px 8px' }}
              />
            </div>
          </div>

          <div style={{ flex: 1 }}></div>
        </div>

        <main className="main" style={{ position: 'relative', padding: 12, gap: 12, display: 'flex', flexDirection: 'row', overflow: 'hidden', flex: 1 }}>
          <ResultTable
            title="CALL SPREAD"
            type="CALL"
            results={resultsCall}
            scanning={scanning}
            hasLiveFeed={hasLiveFeed}
            tickerCount={tickerCount}
            expectedTickerCount={expectedTickerCount}
            config={config}
            onRefresh={() => computeSpreads(true)}
            timeRemaining={timeRemaining}
            spotPrice={spotPrice}
            lastRefreshed={lastRefreshed}
          />
          <ResultTable
            title="PUT SPREAD"
            type="PUT"
            results={resultsPut}
            scanning={scanning}
            hasLiveFeed={hasLiveFeed}
            tickerCount={tickerCount}
            expectedTickerCount={expectedTickerCount}
            config={config}
            onRefresh={() => computeSpreads(true)}
            timeRemaining={timeRemaining}
            spotPrice={spotPrice}
            lastRefreshed={lastRefreshed}
          />
        </main>
      </div>
    </div>
  );
}
