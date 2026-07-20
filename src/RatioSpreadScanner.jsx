import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, getTickers
} from './api';

const UNDERLYINGS = ['BTC', 'ETH'];
const SCANNER_TOP_KEY = 'vitti_scanner_top_spreads_v1';

import ResultTable from './ResultTable';
import { normalizeIv, toFiniteNumber, matchesOptionType } from './scannerUtils';
import Navbar from './components/PaperTrading/Navbar';
import CustomSelect from './components/common/CustomSelect';
import CustomInput from './components/common/CustomInput';
import { ChevronDown } from 'lucide-react';

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

  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(0);

  const [activeTableTab, setActiveTableTab] = useState('call');
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);

  const wsRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastScanTimeRef = useRef(0);

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
      // ATM Edge (P&L) column floors — keep only spreads whose at-ATM P&L and ROI clear
      // these minimums. Applied live in ResultTable against the ATM-priced P&L/ROI.
      minAtmPnl: 0,
      minAtmRoi: 0,
      atmRatioScaling: false,
      atmRatioPctCall: 50,
      atmRatioPctPut: 50
    };

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const migrated = { ...base, ...parsed };
        if (parsed.atmRatioDistanceCall !== undefined && parsed.atmRatioPctCall === undefined) {
          migrated.atmRatioPctCall = parsed.atmRatioDistanceCall > 5 ? parsed.atmRatioDistanceCall : 50;
        }
        if (parsed.atmRatioDistancePut !== undefined && parsed.atmRatioPctPut === undefined) {
          migrated.atmRatioPctPut = parsed.atmRatioDistancePut > 5 ? parsed.atmRatioDistancePut : 50;
        }
        return migrated;
      } catch (err) {
        console.error('Failed to parse saved scanner config:', err);
      }
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
    lastScanTimeRef.current = 0;

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
            bidUpdatedAt: bid != null ? Date.now() : 0,
            askUpdatedAt: ask != null ? Date.now() : 0,
          };
        }
        setTickerData({ ...latestTickerDataRef.current });
        lastScanTimeRef.current = 0; // Trigger scan immediately on backfill load
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

    const scanTickers = (tickers, atmStrike, getTickerPrice) => {
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

          if (buyLeg.expiry !== sellLeg.expiry) continue;

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

          // ── Dynamic ATM scaling (applied BEFORE the max-debit check) ──
          // Mirror the engine: derive the ATM ratio from intrinsic prices at the
          // ATM strike, then scale the sell qty up toward it by the configured %.
          const buyIntrinsic = getTickerPrice(atmStrike, buyLeg.type, 'bid');
          const targetSellStrike = buyLeg.type === 'call'
            ? atmStrike + strikeDiff
            : atmStrike - strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, buyLeg.type, 'ask');
          const atmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
            ? (buyIntrinsic / sellIntrinsic)
            : null;

          let scaledSellQty = sellQty;
          if (config.atmRatioScaling && atmRatio != null) {
            const pct = buyLeg.type === 'call' ? config.atmRatioPctCall : config.atmRatioPctPut;
            const atmRatioVal = Math.round(atmRatio / 0.25) * 0.25;
            const diff = Math.max(0, atmRatioVal - sellQty);
            scaledSellQty = Math.max(sellQty, Math.round((sellQty + (pct / 100) * diff) / 0.25) * 0.25);
          }

          // Max-debit (maxNetPremium) check on the post-scaling net premium.
          const netPrem = scaledSellQty * sellPrice - buyPrice;

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
            scaledSellQty,
            atmRatio,
            buyIntrinsic,
            sellIntrinsic,
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

    // Find the best price for a given strike + option type, falling back to the
    // nearest available strike within a tight tolerance (used for ATM scaling).
    const getTickerPrice = (strike, optType, priceField) => {
      const lowerType = optType.toLowerCase();
      const ofType = allTickers.filter(t => t.type === lowerType);
      if (!ofType.length) return null;

      const exact = ofType.find(t => t.strike === strike);
      if (exact) {
        const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
        return (val != null && val > 0) ? val : null;
      }

      // The requested strike isn't listed — e.g. an ATM ± "weird" 1100 diff that falls
      // between the 1000- and 1200-diff grid strikes. Instead of snapping to a single
      // neighbour (which biased the ATM ratio toward whichever side we picked — usually the
      // 1200 one), BRACKET it: take the nearest listed strike BELOW and the nearest ABOVE
      // (within tolerance) and AVERAGE their prices as a midpoint estimate for the missing
      // strike. If only one side exists, fall back to it (the old nearest behaviour). This
      // mainly moves the ATM ratio, since sellIntrinsic is priced at this target strike.
      const maxTolerance = underlying === 'ETH' ? 50 : 1000;
      const priceOf = (t) => {
        if (!t) return null;
        const v = t[priceField] ?? t.lastPrice ?? t.markPrice;
        return (v != null && v > 0) ? v : null;
      };
      let below = null, belowDist = Infinity;
      let above = null, aboveDist = Infinity;
      for (const t of ofType) {
        const d = t.strike - strike;
        if (d < 0 && -d <= maxTolerance && -d < belowDist) { belowDist = -d; below = t; }
        if (d > 0 && d <= maxTolerance && d < aboveDist) { aboveDist = d; above = t; }
      }
      const pBelow = priceOf(below);
      const pAbove = priceOf(above);
      if (pBelow != null && pAbove != null) return (pBelow + pAbove) / 2;
      return pBelow ?? pAbove;
    };

    const nextCalls = scanTickers(callTickers, atmStrike, getTickerPrice);
    const nextPuts = scanTickers(putTickers, atmStrike, getTickerPrice);
    setResultsCall(nextCalls);
    setResultsPut(nextPuts);
    setGlobalAtmStrike(atmStrike);
    publishTopSpreads(nextCalls, nextPuts);

    setLastRefreshed(Date.now());

  }, [scanning, spotPrice, config, publishTopSpreads, underlying]);

  // Periodic and conditional scanning with 2-second throttling
  useEffect(() => {
    if (!scanning || !spotPrice) return;

    const nowTime = Date.now();
    // Scan if:
    // 1. We haven't scanned yet (lastRefreshed === 0)
    // 2. Or it has been at least 2 seconds (2000ms) since the last scan
    if (lastRefreshed === 0 || (nowTime - lastScanTimeRef.current >= 2000)) {
      lastScanTimeRef.current = nowTime;
      computeSpreads();
    }
  }, [tickerData, scanning, spotPrice, config, lastRefreshed, computeSpreads]);



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

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      try {
        localStorage.setItem('vitti_algo_config', JSON.stringify(newConfig));
      } catch (err) {
        console.error('Failed to save config to localStorage:', err);
      }
      return newConfig;
    });
    lastScanTimeRef.current = 0; // Trigger scan immediately on config change
  };

  // Start/stop scanner locally
  const handleStartScan = useCallback(() => {
    startScan();
  }, [startScan]);

  const handleStopScan = useCallback(() => {
    stopScan();
  }, [stopScan]);

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
      <Navbar
        activeTab="scanner"
        onNavigate={onNavigate}
        theme={theme}
        toggleTheme={toggleTheme}
        badgeLabel={scanning ? `Scanning · ${tickerCount} tickers` : 'Idle'}
        badgeDotClassName={scanning ? 'live' : ''}
      />

      <div className="body scanner-body" style={{ flexDirection: 'column' }}>


        {/* Topbar Configuration */}
        <div className="scanner-config-bar">
          <div className="scanner-config-main">
            <span className="scanner-config-title">SCANNER CONFIG</span>
            <div className="form-group row-inline">
              <label>Underlying:</label>
              <CustomSelect
                value={underlying}
                onChange={val => { setUnderlying(val); stopScan(); }}
                options={UNDERLYINGS.map(u => ({ label: u, value: u }))}
                style={{ width: '100px' }}
              />
            </div>
            <div className="form-group row-inline">
              <label>Expiry:</label>
              <CustomSelect
                value={selExpiry}
                onChange={val => { setSelExpiry(val); stopScan(); }}
                disabled={!expiries.length}
                options={!expiries.length ? [{ label: 'Loading...', value: selExpiry }] : expiries.map(e => ({ label: fmtExpiry(e), value: e }))}
                style={{ width: '160px' }}
              />
            </div>
            <button
              className="scanner-filters-toggle-btn"
              onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
            >
              <span>{isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}</span>
              <ChevronDown
                size={12}
                strokeWidth={2.5}
                style={{
                  transition: 'transform 0.25s ease',
                  transform: isFiltersCollapsed ? 'rotate(0deg)' : 'rotate(180deg)'
                }}
              />

            </button>
          </div>

          <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

          <div className={`scanner-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
            <span className="scanner-config-title filter-title">FILTERS</span>
            <div className="form-group row-inline">
              <label>Min Spread Width</label>
              <CustomInput
                type="number" prefix="$" showStepper width={110}
                step='50'
                value={config.minStrikeDiff}
                onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min IV Edge</label>
              <CustomInput
                type="number" suffix="%" showStepper width={100}
                step='0.25'
                value={config.minIvDiff}
                onChange={e => updateConfig('minIvDiff', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Max Delta Deviation</label>
              <CustomInput
                type="number"
                step="0.01" showStepper width={110}
                value={config.maxRatioDeviation}
                onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min Short Premium</label>
              <CustomInput
                type="number" prefix="$" showStepper width={110}
                value={config.minSellPremium}
                onChange={e => updateConfig('minSellPremium', Number(e.target.value))}
              />
            </div>

            <div className="form-group row-inline">
              <label>Max Net Debit</label>
              <CustomInput
                type="number" prefix="$" showStepper width={110}
                value={config.maxNetPremium}
                onChange={e => updateConfig('maxNetPremium', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Min Spot Distance</label>
              <CustomInput
                type="number" prefix="$" showStepper width={110}
                step='50'
                value={config.minLongDist}
                onChange={e => updateConfig('minLongDist', Number(e.target.value))}
              />
            </div>
            <div className="form-group row-inline">
              <label>Max Short Ratio</label>
              <CustomInput
                type="number"
                step="0.25" prefix="1:" showStepper width={110}
                value={config.maxSellQty}
                onChange={e => updateConfig('maxSellQty', Number(e.target.value))}
              />
            </div>
            <div key="minAtmPnl" className="form-group row-inline">
              <label>Min ATM P&amp;L</label>
              <CustomInput type="number" prefix="$" step="10" showStepper width={110} value={config.minAtmPnl ?? 0}
                onChange={e => updateConfig('minAtmPnl', Number(e.target.value))}
              />
            </div>
            <div key="minAtmRoi" className="form-group row-inline">
              <label>Min ATM ROI</label>
              <CustomInput type="number" suffix="%" step="1" showStepper width={110} value={config.minAtmRoi ?? 0}
                onChange={e => updateConfig('minAtmRoi', Number(e.target.value))}
              />
            </div>
            <div key="atmRatioScaling" className="form-group row-inline" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" id="atmRatioScaling" checked={config.atmRatioScaling ?? false}
                onChange={e => updateConfig('atmRatioScaling', e.target.checked)} />
              <label htmlFor="atmRatioScaling" style={{ cursor: 'pointer', userSelect: 'none' }}>Dynamic ATM Scaling</label>
            </div>
            {config.atmRatioScaling && (
              <>
                <div key="atmRatioPctCall" className="form-group row-inline">
                  <label>Call Scaling</label>
                  <CustomInput type="number" step="5" suffix="%" showStepper width={100} value={config.atmRatioPctCall ?? 50}
                    onChange={e => updateConfig('atmRatioPctCall', Number(e.target.value))}
                  />
                </div>
                <div key="atmRatioPctPut" className="form-group row-inline">
                  <label>Put Scaling</label>
                  <CustomInput type="number" step="5" suffix="%" showStepper width={100} value={config.atmRatioPctPut ?? 50}
                    onChange={e => updateConfig('atmRatioPctPut', Number(e.target.value))}
                  />
                </div>
              </>
            )}
          </div>
          {/* Actions for Start/Stop Scan button */}
          <div>
            <button
              className={`btn-start ${scanning ? 'btn-stop' : ''}`}
              onClick={scanning ? handleStopScan : handleStartScan}
              disabled={!selExpiry}
            >
              {scanning ? '■ STOP SCAN' : '▶ START SCAN'}
            </button>
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
            onRefresh={() => { flushTickerBuffer(); computeSpreads(true); }}
            spotPrice={spotPrice}
            lastRefreshed={lastRefreshed}
            trueAtmStrike={globalAtmStrike}
            tickerData={tickerData}
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
            onRefresh={() => { flushTickerBuffer(); computeSpreads(true); }}
            spotPrice={spotPrice}
            lastRefreshed={lastRefreshed}
            trueAtmStrike={globalAtmStrike}
            tickerData={tickerData}
          />
        </main>
      </div>
    </div>
  );
}
