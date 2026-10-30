import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  loadProducts, getExpiries, getSpotPrice,
  fmtExpiry, createTickerStream, getTickers
} from './api';

// Calendar Spread scanner: the Ratio Spread scanner's filters (no hedge leg), with the SHORT
// leg on one expiry and the LONG leg on a later one. Strikes follow the ratio-spread rule
// (long nearer ATM, short farther OTM, at least Min Spread Width apart; 0 allows the same
// strike). ATM ratio / P&L price the long at the long expiry and the short at the short
// expiry, from current market prices (same proxy as the Ratio Spread scanner). Its config,
// saved settings and last market are kept apart from the Ratio Spread scanner's.
const UNDERLYINGS = ['BTC', 'ETH'];
// Call / Put Scaling as applied: up to 100 as entered; above 100 the entered value minus 100
// (350 → 250%). The input keeps showing what was entered.
const appliedScalingPct = (p) => { const n = Number(p) || 0; return n > 100 ? n - 100 : n; };
// Last underlying + expiry, so a page refresh reopens the market the filters were set for.
const SCANNER_MARKET_KEY = 'vitti_calendar_scanner_market_v1';
const CAL_CONFIG_KEY = 'vitti_calendar_scanner_config_v1';
const CAL_SAVED_KEY = 'vitti_calendar_scanner_saved_v1';
// A saved setting's expiry is "short|long".
const fmtCalExpiry = (v) => String(v || '').split('|').filter(Boolean).map(e => fmtExpiry(e)).join(' → ');
const loadMarket = () => {
  try {
    const m = JSON.parse(localStorage.getItem(SCANNER_MARKET_KEY) || 'null');
    return m && UNDERLYINGS.includes(m.underlying) ? m : null;
  } catch { return null; }
};

import ResultTable from './ResultTable';
import { normalizeIv, toFiniteNumber, matchesOptionType, defaultOiCapM, effectiveOiCapM, isOiBlocked } from './scannerUtils';
import Navbar from './components/PaperTrading/Navbar';
import CustomSelect from './components/common/CustomSelect';
import CustomInput from './components/common/CustomInput';
import { ScannerFilterToolbar } from './components/scanner/ScannerFilters';
import { SCANNER_DEFAULTS } from './components/scanner/scannerDefaults';
import { ChevronDown } from 'lucide-react';

// ── Main Scanner Component ──────────────────────────────────────────────────
export default function CalendarSpreadScanner({ onNavigate, theme, toggleTheme }) {
  const [underlying, setUnderlying] = useState(() => loadMarket()?.underlying ?? 'BTC');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');      // SHORT leg expiry
  const [longExpiry, setLongExpiry] = useState('');    // LONG leg expiry (after the short one)
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
  // Filters panel: always shown on desktop (the toggle is hidden there by CSS); on phones
  // it starts closed, since the stacked filters would push the tables far down.
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);


  const wsRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastScanTimeRef = useRef(0);

  // Configurable thresholds initialized from localStorage
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem(CAL_CONFIG_KEY);
    const base = { ...SCANNER_DEFAULTS };

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

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData(latestTickerDataRef.current);
  }, []);

  // The paper dashboard's highlighted "top spreads" come from the Ratio Spread scanner only.
  const publishTopSpreads = useCallback(() => {}, []);

  // Underlying the latest product load is for — a slow response for the previous underlying
  // must not overwrite the new one's expiries.
  const underlyingRef = useRef(underlying);
  // Declared before the product-load effect below, so it runs first on an underlying change.
  useEffect(() => { underlyingRef.current = underlying; }, [underlying]);
  // Expiry to select once that underlying's expiries are loaded: a saved setting's, or on
  // first load the one this browser last used.
  const pendingExpiryRef = useRef(loadMarket()?.expiry ?? null);
  const pendingLongExpiryRef = useRef(loadMarket()?.longExpiry ?? null);
  useEffect(() => {
    if (!selExpiry) return;
    try { localStorage.setItem(SCANNER_MARKET_KEY, JSON.stringify({ underlying, expiry: selExpiry, longExpiry })); } catch { /* storage unavailable */ }
  }, [underlying, selExpiry, longExpiry]);
  // Long expiry: always one AFTER the short expiry — keep the chosen one while valid, else
  // the requested one (saved setting / last session), else the next expiry.
  const longExpiryOptions = expiries.filter(e => selExpiry && e > selExpiry);
  useEffect(() => {
    if (!selExpiry) return;
    const opts = expiries.filter(e => e > selExpiry);
    const wanted = pendingLongExpiryRef.current;
    if (wanted && opts.includes(wanted)) pendingLongExpiryRef.current = null;
    setLongExpiry(cur => (wanted && opts.includes(wanted)) ? wanted
      : (cur && opts.includes(cur)) ? cur
      : (opts[0] ?? ''));
  }, [expiries, selExpiry]);

  const refreshProducts = useCallback(async () => {
    const forUnderlying = underlying;
    try {
      const prods = await loadProducts(forUnderlying);
      if (underlyingRef.current !== forUnderlying) return;
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (!exps.length) return;
      // Functional update: read the CURRENT selection. The closure's value was stale right
      // after an underlying switch (it still held the old underlying's expiry, which is
      // usually also listed for the new one — same daily dates — so nothing got selected).
      const wanted = pendingExpiryRef.current;
      pendingExpiryRef.current = null;
      setSelExpiry(cur => (wanted && exps.includes(wanted)) ? wanted
        : (cur && exps.includes(cur)) ? cur
        : exps[0]);
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying]);

  // ── Load products on underlying change ──────────────────────────────────
  useEffect(() => {
    setExpiries([]); setSelExpiry(''); setLongExpiry(''); setResultsCall([]); setResultsPut([]);
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
    if (!selExpiry || !longExpiry || !products.length) {
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

    // Every option of BOTH expiries: the short expiry's (short legs) and the long expiry's
    // (long legs). Symbols differ by expiry, so one map holds both; each carries its expiry.
    const symbolMeta = {};     // symbol -> { strike, lotSize, type, expiry }
    for (const exp of [selExpiry, longExpiry]) {
      for (const p of products) {
        if (p.settlement_time !== exp) continue;
        const type = matchesOptionType(p, 'call') ? 'call' : matchesOptionType(p, 'put') ? 'put' : null;
        if (!type) continue;
        const lotSize = parseFloat(p.contract_size ?? p.quoting_precision ?? 1);
        symbolMeta[p.symbol] = { strike: parseFloat(p.strike_price), lotSize, type, expiry: exp };
      }
    }
    if (Object.keys(symbolMeta).length < 2) {
      setScanning(false);
      return;
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

          const { strike, lotSize, type, expiry } = meta;
          const markPrice = toFiniteNumber(t.mark_price ?? t.last_price);
          const bid = toFiniteNumber(t.quotes?.best_bid);
          const ask = toFiniteNumber(t.quotes?.best_ask);
          const bidIv = normalizeIv(toFiniteNumber(t.quotes?.bid_iv));
          const askIv = normalizeIv(toFiniteNumber(t.quotes?.ask_iv));
          const iv = normalizeIv(toFiniteNumber(t.mark_vol ?? t.quotes?.mark_iv ?? t.greeks?.iv));
          const delta = t.greeks ? toFiniteNumber(t.greeks.delta) : null;
          const gamma = t.greeks ? toFiniteNumber(t.greeks.gamma) : null;
          const theta = t.greeks ? toFiniteNumber(t.greeks.theta) : null;
          // Strike OI (USD / contracts) + Delta's OI-limit lock (reduce-only).
          const oiUsd = toFiniteNumber(t.oi_value_usd);
          const oiContracts = toFiniteNumber(t.oi_contracts);
          const oiLocked = t.oi_reduce_only_mode == null ? null : (t.oi_reduce_only_mode === true || t.oi_reduce_only_mode === 'true');

          latestTickerDataRef.current[sym] = {
            symbol: sym,
            strike,
            lotSize,
            type,
            expiry,
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
            oiUsd,
            oiContracts,
            oiLocked,
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
        const oiUsd = toFiniteNumber(msg.oi_value_usd);
        const oiContracts = toFiniteNumber(msg.oi_contracts);
        const oiLocked = msg.oi_reduce_only_mode == null ? null : (msg.oi_reduce_only_mode === true || msg.oi_reduce_only_mode === 'true');

        const meta = symbolMeta[sym];
        if (!meta) return;

        const { strike, lotSize, type, expiry } = meta;
        const prevBuffered = tickerBufferRef.current[sym] ?? tickerData[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym,
          strike,
          lotSize,
          type,
          expiry,
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
          oiUsd: oiUsd ?? prevBuffered?.oiUsd ?? null,
          oiContracts: oiContracts ?? prevBuffered?.oiContracts ?? null,
          oiLocked: oiLocked ?? prevBuffered?.oiLocked ?? null,
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
  }, [selExpiry, longExpiry, products, underlying]);

  // ── Compute Spreads Logic ───────────
  const computeSpreads = useCallback((force = false) => {
    if (!scanning || !spotPrice) return;

    const scanTickers = (tickers, atmStrike, getTickerPrice) => {
      if (tickers.length < 2) return [];

      // Longs from the LONG expiry, shorts from the SHORT expiry.
      const longs = tickers.filter(t => t.expiry === longExpiry);
      const shorts = tickers.filter(t => t.expiry === selExpiry);
      const validPairs = [];

      for (const buyLeg of longs) {
        for (const sellLeg of shorts) {
          if (sellLeg.type !== buyLeg.type) continue;
          // Ratio-spread strike rule: call short at/above the long, put short at/below it.
          if (buyLeg.type === 'call' ? sellLeg.strike < buyLeg.strike : sellLeg.strike > buyLeg.strike) continue;

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

          // ── Dynamic ATM scaling (applied BEFORE the max-debit check) ──
          // Mirror the engine: derive the ATM ratio from intrinsic prices at the
          // ATM strike, then scale the sell qty up toward it by the configured %.
          const buyIntrinsic = getTickerPrice(atmStrike, buyLeg.type, 'bid', longExpiry);
          const targetSellStrike = buyLeg.type === 'call'
            ? atmStrike + strikeDiff
            : atmStrike - strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, buyLeg.type, 'ask', selExpiry);
          const atmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
            ? (buyIntrinsic / sellIntrinsic)
            : null;

          let scaledSellQty = sellQty;
          if (config.atmRatioScaling && atmRatio != null) {
            const pct = appliedScalingPct(buyLeg.type === 'call' ? config.atmRatioPctCall : config.atmRatioPctPut);
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
            deltaDiff,
            netDelta3: null,
            hedge: null,
            hedgeOptions: []
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
      if (t.expiry !== selExpiry) continue; // ATM from the short expiry's strikes
      const diff = Math.abs(t.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = t.strike;
      }
    }

    // Delta OI limit (toggle): drop strikes Delta has locked (reduce-only) or whose OI (USD)
    // is at/over the cap — no new leg can open there. Covers the long, the short and the
    // legs of both expiries. Pricing lookups still see the full chain.
    const oiCapM = effectiveOiCapM(config.oiMaxCapM, underlying);
    const oiOk = (t) => !config.oiFilterEnabled || !isOiBlocked(t, oiCapM);
    // For Call: ATM or OTM means strike >= atmStrike
    const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike) && oiOk(t));
    // For Put: ATM or OTM means strike <= atmStrike
    const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike) && oiOk(t));

    // Find the best price for a given strike + option type, falling back to the
    // nearest available strike within a tight tolerance (used for ATM scaling).
    const getTickerPrice = (strike, optType, priceField, expiry) => {
      const lowerType = optType.toLowerCase();
      const ofType = allTickers.filter(t => t.type === lowerType && t.expiry === expiry);
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

  }, [scanning, spotPrice, config, publishTopSpreads, underlying, selExpiry, longExpiry]);

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
  }, []);

  // A saved setting carries the underlying + expiry it was saved on: open that market.
  // A different underlying reloads its expiries and picks `exp` once they arrive (else
  // the nearest); the same underlying switches the expiry now if it is still listed.
  const applyMarket = (u, value) => {
    const [exp, longExp] = String(value || '').split('|');
    pendingLongExpiryRef.current = longExp || null;
    if (u && UNDERLYINGS.includes(u) && u !== underlying) {
      pendingExpiryRef.current = exp || null;
      setUnderlying(u);
      stopScan();
      return;
    }
    if (exp && exp !== selExpiry && expiries.includes(exp)) setSelExpiry(exp);
    else if (longExp && longExp !== longExpiry && expiries.includes(longExp)) setLongExpiry(longExp);
    stopScan();
  };

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      try {
        localStorage.setItem(CAL_CONFIG_KEY, JSON.stringify(newConfig));
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
  // ResultTable prices the long at the long expiry and the short at the short expiry.
  const priceSources = useMemo(() => {
    const buy = {}; const sell = {};
    for (const [k, t] of Object.entries(tickerData)) {
      if (t.expiry === longExpiry) buy[k] = t;
      else if (t.expiry === selExpiry) sell[k] = t;
    }
    return { buy, sell };
  }, [tickerData, selExpiry, longExpiry]);
  const hasLiveFeed = scanning && tickerCount > 0;

  return (
    <div className="app">
      {/* Navbar */}
      <Navbar
        activeTab="calendar"
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
              <label title="Expiry of the SHORT leg">Short Expiry:</label>
              <CustomSelect
                value={selExpiry}
                onChange={val => { setSelExpiry(val); stopScan(); }}
                disabled={!expiries.length}
                options={!expiries.length ? [{ label: 'Loading...', value: selExpiry }] : expiries.slice(0, -1).map(e => ({ label: fmtExpiry(e), value: e }))}
                style={{ width: '160px' }}
              />
            </div>
            <div className="form-group row-inline">
              <label title="Expiry of the LONG leg — always after the short expiry">Long Expiry:</label>
              <CustomSelect
                value={longExpiry}
                onChange={val => { setLongExpiry(val); stopScan(); }}
                disabled={!longExpiryOptions.length}
                options={!longExpiryOptions.length ? [{ label: 'Loading...', value: longExpiry }] : longExpiryOptions.map(e => ({ label: fmtExpiry(e), value: e }))}
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

          {/* Saved settings · + Save · Send to window · Reset */}
          <ScannerFilterToolbar config={config} updateConfig={updateConfig}
            underlying={underlying} expiry={selExpiry && longExpiry ? `${selExpiry}|${longExpiry}` : ''} onApplyMarket={applyMarket}
            savedKey={CAL_SAVED_KEY} fmtExpiry={fmtCalExpiry} />

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
            {/* Dynamic ATM Scaling + its call / put scaling */}
            <div className="scanner-filter-group">
              <div key="atmRatioScaling" className="form-group row-inline scanner-switch-field">
                <label htmlFor="atmRatioScaling" style={{ cursor: 'pointer', userSelect: 'none' }}>Dynamic ATM Scaling</label>
                <label className="pt-switch" title="Scale the short qty toward the ATM ratio">
                  <input type="checkbox" id="atmRatioScaling" checked={config.atmRatioScaling ?? false}
                    onChange={e => updateConfig('atmRatioScaling', e.target.checked)} />
                  <span className="pt-slider"></span>
                </label>
              </div>
              {config.atmRatioScaling && (
                <>
                  <div key="atmRatioPctCall" className="form-group row-inline">
                    <label>Call Scaling</label>
                    <CustomInput type="number" step="5" suffix="%" showStepper width={100} value={config.atmRatioPctCall ?? 50}
                      onChange={e => updateConfig('atmRatioPctCall', Number(e.target.value))}
                      title={`Applied: ${appliedScalingPct(config.atmRatioPctCall ?? 50)}%`}
                    />
                  </div>
                  <div key="atmRatioPctPut" className="form-group row-inline">
                    <label>Put Scaling</label>
                    <CustomInput type="number" step="5" suffix="%" showStepper width={100} value={config.atmRatioPctPut ?? 50}
                      onChange={e => updateConfig('atmRatioPctPut', Number(e.target.value))}
                      title={`Applied: ${appliedScalingPct(config.atmRatioPctPut ?? 50)}%`}
                    />
                  </div>
                </>
              )}
            </div>
            {/* Open Interest (Delta OI limit) + its cap */}
            <div className="scanner-filter-group">
              <div key="oiFilterEnabled" className="form-group row-inline scanner-switch-field">
                <label htmlFor="oiFilterEnabled" style={{ cursor: 'pointer', userSelect: 'none' }}
                  title="Delta's contract-level OI limit: a strike whose open interest reaches the cap goes reduce-only (no new positions). On: hide spreads with a leg on a strike that is locked or whose OI (USD) is at/over the cap.">
                  Open Interest
                </label>
                <label className="pt-switch" title="Hide spreads on strikes at/over the OI cap or locked by Delta">
                  <input type="checkbox" id="oiFilterEnabled" checked={config.oiFilterEnabled ?? false}
                    onChange={e => updateConfig('oiFilterEnabled', e.target.checked)} />
                  <span className="pt-slider"></span>
                </label>
              </div>
              {config.oiFilterEnabled && (
                <div key="oiMaxCapM" className="form-group row-inline">
                  <label>Max OI</label>
                  <CustomInput type="number" step="1" min="1" prefix="$" suffix="M" showStepper width={100}
                    value={config.oiMaxCapM ?? defaultOiCapM(underlying)}
                    onChange={e => {
                      const n = Number(e.target.value);
                      updateConfig('oiMaxCapM', e.target.value === '' || !(n > 0) ? null : n);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
          {/* Actions for Start/Stop Scan button */}
          <div>
            <button
              className={`btn-start ${scanning ? 'btn-stop' : ''}`}
              onClick={scanning ? handleStopScan : handleStartScan}
              disabled={!selExpiry || !longExpiry}
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
            priceSources={priceSources}
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
            priceSources={priceSources}
          />
        </main>
      </div>
    </div>
  );
}
