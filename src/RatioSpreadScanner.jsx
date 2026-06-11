import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, getTickers
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
  const [globalAtmStrike, setGlobalAtmStrike] = useState(null);
  const [tickerData, setTickerData] = useState({});
  const [extraCreditMode, setExtraCreditMode] = useState(false);
  const [extraCreditAmountCall, setExtraCreditAmountCall] = useState(15);
  const [extraCreditAmountPut, setExtraCreditAmountPut] = useState(10);
  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const [activeTableTab, setActiveTableTab] = useState('call');
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);

  const wsRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);

  // Configurable thresholds initialized from localStorage
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('vitti_algo_config');
    const base = {
      minStrikeDiff: 800,
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
      minLongDist: 500,
      maxSellQty: 10,
      atmRatioScaling: false,
      atmRatioDistanceCall: 1,
      atmRatioDistancePut: 1
    };

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...base, ...parsed };
      } catch (e) { }
    }
    return base;
  });

  const pickTopUniqueStrikes = useCallback((spreads, limit = 3) => {
    const out = [];
    const seenBuy = new Set();
    for (const s of spreads) {
      const bStrike = s?.buyLeg?.strike != null ? Number(s.buyLeg.strike) : null;
      if (bStrike == null) continue;
      if (seenBuy.has(bStrike)) continue;
      seenBuy.add(bStrike);
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
    const topCalls = pickTopUniqueStrikes(calls, 3);
    const topPuts = pickTopUniqueStrikes(puts, 3);
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
  }, [underlying, selExpiry, broadcastScannerTopSpreads, pickTopUniqueStrikes]);


  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        setSelExpiry(exps[0]);
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry]);

  // ── Load products on underlying change ──────────────────────────────────
  useEffect(() => {
    setExpiries([]); setSelExpiry(''); setResultsCall([]); setResultsPut([]);
    setTickerData({});
    setExpectedTickerCount(0);
    refreshProducts();
  }, [underlying]);

  // ── Periodically refresh products to catch expiries and rollover ────────
  useEffect(() => {
    const interval = setInterval(() => {
      refreshProducts();
    }, 5 * 60 * 1000); // 5 minutes
    return () => clearInterval(interval);
  }, [refreshProducts]);

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
  const startScan = useCallback(async () => {
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

    const perpSymbol = `${underlying}USD`;
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.includes(perpSymbol)) {
      allSymbols.push(perpSymbol);
    }
    setExpectedTickerCount(allSymbols.length);

    // REST Backfill
    try {
      const restTickers = await getTickers(underlying, allSymbols);
      if (restTickers && Array.isArray(restTickers)) {
        for (const t of restTickers) {
          const sym = t.symbol;
          const meta = symbolMeta[sym];
          if (!meta) continue;

          const { strike, lotSize, type } = meta;
          const markPrice = toFiniteNumber(t.mark_price ?? t.last_price);
          const bid = toFiniteNumber(t.quotes?.best_bid);
          const ask = toFiniteNumber(t.quotes?.best_ask);
          const bidIv = normalizeIv(toFiniteNumber(t.quotes?.bid_iv));
          const askIv = normalizeIv(toFiniteNumber(t.quotes?.ask_iv));
          const iv = normalizeIv(toFiniteNumber(t.mark_vol ?? t.quotes?.mark_iv ?? t.greeks?.iv));
          const delta = t.greeks ? toFiniteNumber(t.greeks.delta) : null;
          const gamma = t.greeks ? toFiniteNumber(t.greeks.gamma) : null;
          const theta = t.greeks ? toFiniteNumber(t.greeks.theta) : null;

          latestTickerDataRef.current[sym] = {
            symbol: sym,
            strike,
            lotSize,
            type,
            markPrice,
            bid,
            ask,
            bidIv,
            askIv,
            iv,
            delta,
            deltaNotional: delta !== null ? Math.abs(delta) * lotSize : null,
            gamma,
            theta,
            lastUpdate: Date.now(),
          };
        }
        setTickerData({ ...latestTickerDataRef.current });
      }
    } catch (e) {
      console.error('REST backfill error in scanner:', e);
    }

    const stream = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        const perpSymbol = `${underlying}USD`;
        if (sym === perpSymbol) {
          const sp = toFiniteNumber(msg.spot_price ?? msg.mark_price ?? msg.close ?? msg.last_price);
          if (sp && !isNaN(sp)) {
            setSpotPrice(sp);
          }
          return;
        }

        const markPrice = toFiniteNumber(msg.mark_price);
        const lastPrice = toFiniteNumber(msg.last_price ?? msg.close);
        const bid = toFiniteNumber(msg.quotes?.best_bid);
        const ask = toFiniteNumber(msg.quotes?.best_ask);
        const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.bid_iv));
        const askIv = normalizeIv(toFiniteNumber(msg.quotes?.ask_iv));
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
          lastPrice: lastPrice ?? prevBuffered?.lastPrice ?? null,
          bid: bid ?? prevBuffered?.bid ?? null,
          ask: ask ?? prevBuffered?.ask ?? null,
          bidUpdatedAt: bid != null ? Date.now() : (prevBuffered?.bidUpdatedAt ?? 0),
          askUpdatedAt: ask != null ? Date.now() : (prevBuffered?.askUpdatedAt ?? 0),
          bidIv: bidIv ?? prevBuffered?.bidIv ?? null,
          askIv: askIv ?? prevBuffered?.askIv ?? null,
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

          // For Buy Leg (Long): use Ask price and Ask IV
          // For Sell Leg (Short): use Bid price and Bid IV
          const buyPrice = buyLeg.ask;
          const sellPrice = sellLeg.bid;

          if (buyPrice == null || sellPrice == null || buyPrice <= 0 || sellPrice <= 0) continue;

          // Require WS-confirmed quotes (reject stale REST backfill data)
          const now = Date.now();
          const FRESHNESS_MS = 120000; // 120 seconds
          const buyAskFresh = (buyLeg.askUpdatedAt || 0) > 0 && (now - buyLeg.askUpdatedAt) < FRESHNESS_MS;
          const sellBidFresh = (sellLeg.bidUpdatedAt || 0) > 0 && (now - sellLeg.bidUpdatedAt) < FRESHNESS_MS;
          if (!buyAskFresh || !sellBidFresh) continue;
          const buyIv = buyLeg.askIv ?? buyLeg.iv;
          const sellIv = sellLeg.bidIv ?? sellLeg.iv;

          if (buyIv == null || sellIv == null) continue;
          const ivDiff = Math.abs(buyIv - sellIv);
          if (ivDiff < config.minIvDiff) continue;

          const spotDist = Math.abs(buyLeg.strike - spotPrice);
          if (spotDist < (config.minLongDist || 0)) continue;

          if (!sellPrice || sellPrice < config.minSellPremium) continue;

          const buyDN = buyLeg.deltaNotional;
          const sellDN = sellLeg.deltaNotional;

          if (buyDN == null || sellDN == null ||
            buyPrice == null || sellPrice == null ||
            buyPrice === 0 || sellPrice === 0 ||
            buyDN === 0 || sellDN === 0) continue;

          const premiumRatio = buyPrice / sellPrice;
          const deltaNotionalRatio = buyDN / sellDN;

          const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
          if (ratioDeviation > config.maxRatioDeviation) continue;

          const rawQty = buyDN / sellDN;
          const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
          if (sellQty > (config.maxSellQty || 10)) continue;

          const deltaDiff = buyDN - sellQty * sellDN;

          const netPrem = sellQty * sellPrice - buyPrice;

          if (netPrem < -config.maxNetPremium) continue;

          validPairs.push({
            buyLeg,
            sellLeg,
            strikeDiff,
            ivDiff,
            premiumRatio: premiumRatio.toFixed(3),
            deltaNotionalRatio: deltaNotionalRatio.toFixed(3),
            ratioDeviation: (ratioDeviation * 100).toFixed(1),
            sellQty,
            buyPrice,
            sellPrice,
            buyIv,
            sellIv,
            netPremium: netPrem.toFixed(2),
            deltaDiff
          });
        }
      }

      // Sort: closest to ATM first, then by net premium descending (highest credit/lowest debit first)
      validPairs.sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        if (distA !== distB) return distA - distB;
        return b.netPremium - a.netPremium;
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
    setGlobalAtmStrike(atmStrike);
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
      if (payload.config) {
        const updates = {};
        const keys = [
          'underlying', 'expiry', 'minStrikeDiff', 'minIvDiff', 'maxRatioDeviation',
          'minSellPremium', 'maxNetPremium', 'minLongDist', 'maxSellQty',
          'atmRatioScaling', 'atmRatioDistanceCall', 'atmRatioDistancePut'
        ];
        keys.forEach(k => {
          if (payload.config[k] !== undefined) updates[k] = payload.config[k];
        });
        if (Object.keys(updates).length > 0) {
          setConfig(prev => {
            const newCfg = { ...prev, ...updates };
            try { localStorage.setItem('vitti_algo_config', JSON.stringify(newCfg)); } catch (e) {}
            saveSupabaseConfig(newCfg);
            return newCfg;
          });
        }
        if (payload.config.underlying) setUnderlying(payload.config.underlying);
        if (payload.config.expiry) setSelExpiry(payload.config.expiry);
      }
    }
  });

  const fetchSupabaseConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('paper_trading_config').select('*').eq('id', 'scanner').single();
      if (data && !error) {
        const newCfg = {
          minStrikeDiff: data.min_strike_diff ?? config.minStrikeDiff,
          minIvDiff: data.min_iv_diff ?? config.minIvDiff,
          maxRatioDeviation: data.max_ratio_deviation ?? config.maxRatioDeviation,
          minSellPremium: data.min_sell_premium ?? config.minSellPremium,
          maxNetPremium: data.max_net_premium ?? config.maxNetPremium,
          minLongDist: data.min_long_dist ?? config.minLongDist,
          maxSellQty: data.max_sell_qty ?? config.maxSellQty,
          atmRatioScaling: data.atm_ratio_scaling ?? config.atmRatioScaling,
          atmRatioDistanceCall: data.atm_ratio_distance_call ?? config.atmRatioDistanceCall,
          atmRatioDistancePut: data.atm_ratio_distance_put ?? config.atmRatioDistancePut,
        };
        setConfig(newCfg);
        if (data.underlying && data.underlying !== underlying) setUnderlying(data.underlying);
        if (data.expiry && data.expiry !== selExpiry) setSelExpiry(data.expiry);
      }
    } catch (e) { }
  }, [underlying, selExpiry, config]);

  const saveSupabaseConfig = useCallback(async (newCfg) => {
    try {
      await supabase.from('paper_trading_config').upsert({
        id: 'scanner',
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        min_long_dist: newCfg.minLongDist,
        max_sell_qty: newCfg.maxSellQty,
        atm_ratio_scaling: newCfg.atmRatioScaling,
        atm_ratio_distance_call: newCfg.atmRatioDistanceCall,
        atm_ratio_distance_put: newCfg.atmRatioDistancePut,
        updated_at: new Date().toISOString()
      });
    } catch (e) { }
  }, []);

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      try {
        localStorage.setItem('vitti_algo_config', JSON.stringify(newConfig));
      } catch (e) { }
      tabBroadcast('CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  useEffect(() => {
    fetchSupabaseConfig();
  }, []);


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
            </span> <span className="nav-tab-text">Charts</span>
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
            </span> <span className="nav-tab-text">Ratio Spread</span>
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
            </span> <span className="nav-tab-text">Paper Trading</span>
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
        <div className="scanner-config-bar">
          <div className="scanner-config-main">
            <span className="scanner-config-title">SCANNER CONFIG</span>
            <div className="form-group row-inline">
              <label>Underlying:</label>
              <select value={underlying} onChange={e => { setUnderlying(e.target.value); stopScan(); }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group row-inline">
              <label>Expiry:</label>
              <select value={selExpiry} onChange={e => { setSelExpiry(e.target.value); stopScan(); }} disabled={!expiries.length}>
                {!expiries.length
                  ? <option>Loading...</option>
                  : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)
                }
              </select>
            </div>
            <div className='form-group row-inline'>
              <button
                className={`btn-start ${scanning ? 'btn-stop' : ''}`}
                onClick={scanning ? handleStopScan : handleStartScan}
                disabled={!selExpiry}
                style={{ padding: '6px 16px', fontSize: 13, fontWeight: 600, marginLeft: 8 }}
              >
                {scanning ? '■ STOP SCAN' : '▶ START SCAN'}
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '1px solid var(--border)', paddingLeft: '12px', marginLeft: '8px' }}>
              <div className="pt-fee-toggle-container">
                <span className={`pt-fee-toggle-label ${!extraCreditMode ? 'active' : ''}`} onClick={() => setExtraCreditMode(false)}>Base</span>
                <label className="pt-switch">
                  <input type="checkbox" checked={extraCreditMode} onChange={(e) => setExtraCreditMode(e.target.checked)} />
                  <span className="pt-slider round"></span>
                </label>
                <span className={`pt-fee-toggle-label ${extraCreditMode ? 'active' : ''}`} onClick={() => setExtraCreditMode(true)}>Extra</span>
              </div>
              {extraCreditMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--call)', fontWeight: 'bold', marginRight: '4px' }}>C:$</span>
                    <input type="number" value={extraCreditAmountCall}
                      onChange={(e) => setExtraCreditAmountCall(Number(e.target.value))}
                      style={{ width: '40px', background: 'transparent', border: 'none', color: 'var(--call)', fontSize: '12px', fontWeight: 'bold', outline: 'none', padding: 0 }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--put)', fontWeight: 'bold', marginRight: '4px' }}>P:$</span>
                    <input type="number" value={extraCreditAmountPut}
                      onChange={(e) => setExtraCreditAmountPut(Number(e.target.value))}
                      style={{ width: '40px', background: 'transparent', border: 'none', color: 'var(--put)', fontSize: '12px', fontWeight: 'bold', outline: 'none', padding: 0 }} />
                  </div>
                </div>
              )}
            </div>
            <button
              className="scanner-filters-toggle-btn"
              onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
            >
              {isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}
            </button>
          </div>

          <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

          <div className={`scanner-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
            <span className="scanner-config-title filter-title">FILTERS</span>
            <div className="form-group row-inline">
              <label>Min Strike Diff ($):</label>
              <input
                type="number"
                value={config.minStrikeDiff}
                onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min IV Diff (%):</label>
              <input
                type="number"
                value={config.minIvDiff}
                onChange={e => updateConfig('minIvDiff', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Max Ratio Dev:</label>
              <input
                type="number"
                step="0.01"
                value={config.maxRatioDeviation}
                onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min Sell Prem ($):</label>
              <input
                type="number"
                value={config.minSellPremium}
                onChange={e => updateConfig('minSellPremium', Number(e.target.value))}
              />
            </div>

            <div className="form-group row-inline">
              <label>Max Debit ($):</label>
              <input
                type="number"
                value={config.maxNetPremium}
                onChange={e => updateConfig('maxNetPremium', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min Long Dist:</label>
              <input
                type="number"
                value={config.minLongDist}
                onChange={e => updateConfig('minLongDist', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Max Ratio (1:X):</label>
              <input
                type="number"
                step="0.25"
                value={config.maxSellQty}
                onChange={e => updateConfig('maxSellQty', Number(e.target.value))}
              />
            </div>
            <div key="atmRatioScaling" className="form-group row-inline" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" id="atmRatioScaling" checked={config.atmRatioScaling ?? false}
                onChange={e => updateConfig('atmRatioScaling', e.target.checked)} />
              <label htmlFor="atmRatioScaling" style={{ cursor: 'pointer', userSelect: 'none' }}>ATM Ratio Entry</label>
            </div>
            {config.atmRatioScaling && (
              <>
                <div key="atmRatioDistanceCall" className="form-group row-inline">
                  <label>Call ATM Dist (pt):</label>
                  <input type="number" step="0.25" value={config.atmRatioDistanceCall ?? 1}
                    onChange={e => updateConfig('atmRatioDistanceCall', Number(e.target.value))}
                  />
                </div>
                <div key="atmRatioDistancePut" className="form-group row-inline">
                  <label>Put ATM Dist (pt):</label>
                  <input type="number" step="0.25" value={config.atmRatioDistancePut ?? 1}
                    onChange={e => updateConfig('atmRatioDistancePut', Number(e.target.value))}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="scanner-mobile-tabs">
          <div className={`scanner-mobile-tab ${activeTableTab === 'call' ? 'active' : ''}`} onClick={() => setActiveTableTab('call')}>Call Spreads</div>
          <div className={`scanner-mobile-tab ${activeTableTab === 'put' ? 'active' : ''}`} onClick={() => setActiveTableTab('put')}>Put Spreads</div>
        </div>

        <main className={`main scanner-main show-${activeTableTab}`} style={{ position: 'relative', padding: 12, gap: 12, display: 'flex', flexDirection: 'row', overflow: 'hidden', flex: 1 }}>
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
            trueAtmStrike={globalAtmStrike}
            tickerData={tickerData}
            extraCreditMode={extraCreditMode}
            extraCreditAmountCall={extraCreditAmountCall}
            extraCreditAmountPut={extraCreditAmountPut}
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
            trueAtmStrike={globalAtmStrike}
            tickerData={tickerData}
            extraCreditMode={extraCreditMode}
            extraCreditAmountCall={extraCreditAmountCall}
            extraCreditAmountPut={extraCreditAmountPut}
          />
        </main>
      </div>
    </div>
  );
}
