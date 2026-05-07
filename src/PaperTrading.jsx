import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];
const SCANNER_TOP_KEY = 'vitti_scanner_top_spreads_v1';

const calculateFee = (price, spot, qty, lotSize) => {
  if (!price || !spot) return 0;
  const feePerUnit = Math.min(0.035 * price, 0.0001 * spot);
  return feePerUnit * qty * lotSize;
};

const safeParseLeg = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  return null;
};

export default function PaperTrading({ onNavigate, theme, toggleTheme }) {
  // config state unified with underlying and expiry
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('vitti_algo_config');
    let base = {
      underlying: 'BTC',
      expiry: '',
      minStrikeDiff: 800,
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
    };
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { ...base, ...parsed };
      } catch (e) { }
    }
    return base;
  });

  // Use getters for convenience
  const underlying = config.underlying;
  const selExpiry = config.expiry;

  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [trading, setTrading] = useState(true);

  const [includeFees, setIncludeFees] = useState(false);

  const [positions, setPositions] = useState([]); // Active positions
  const [tradeHistory, setTradeHistory] = useState([]); // Closed trades
  const [aiReviews, setAiReviews] = useState({}); // { tradeId: { claude: string, groq: string } }
  const [selectedTradeId, setSelectedTradeId] = useState(null); // For AI review modal

  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);

  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const cooldownRef = useRef({});
  const lastEvaluatedRef = useRef(0);
  const lastDbWriteRef = useRef(0); // Timestamp of last local Supabase write

  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const scannerTopRef = useRef(null);
  const [scannerSyncVersion, setScannerSyncVersion] = useState(0);
  const lastProcessedScannerVersionRef = useRef(0);



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

  const positionsRef = useRef([]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SCANNER_TOP_KEY);
      scannerTopRef.current = raw ? JSON.parse(raw) : null;
    } catch (e) {
      scannerTopRef.current = null;
    }
  }, []);

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
    setExpiries([]);
    setTickerData({});
    setExpectedTickerCount(0);
    loadProducts(underlying)
      .then(prods => {
        setProducts(prods);
        const exps = getExpiries(prods);
        setExpiries(exps);
        if (exps.length && !config.expiry) {
          updateConfig('expiry', exps[0]);
        }
      })
      .catch(e => console.error('Failed to load products:', e));
  }, [underlying]);

  const saveSupabaseConfig = useCallback(async (newCfg) => {
    try {
      await supabase.from('paper_trading_config').upsert({
        id: 'global',
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        updated_at: new Date().toISOString()
      });
    } catch (e) { }
  }, []);

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      localStorage.setItem('vitti_algo_config', JSON.stringify(newConfig));
      tabBroadcast('CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  const fetchSupabaseActivePositions = useCallback(async () => {
    try {
      if (Date.now() - lastDbWriteRef.current < 10000) return;
      const { data, error } = await supabase
        .from('active_positions')
        .select('*')
        .order('entry_time', { ascending: true });

      if (error) { console.error('Error fetching active positions:', error); return; }

      if (data && data.length > 0) {
        const mapped = data.map(p => ({
          id: p.id, underlying: p.underlying, expiry: p.expiry, type: p.type,
          buyLeg: safeParseLeg(p.buy_leg), sellLeg: safeParseLeg(p.sell_leg),
          sellQty: p.sell_qty, strikeDiff: p.strike_diff, entryTime: new Date(p.entry_time),
          entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
          margin: p.margin || 0, entryFee: p.entry_fee || 0, accumulatedSellPnl: p.accumulated_sell_pnl || 0,
          currentBuyPrice: null, currentSellPrice: null,
          unrealizedGrossPnl: 0, unrealizedNetPnl: -(p.entry_fee || 0), currentExitFee: 0, currentTotalFees: p.entry_fee || 0,
        }));
        const sorted = mapped.filter(p => p.buyLeg && p.sellLeg).sort((a, b) => {
          if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
          if (a.type === 'call') return a.buyLeg.strike - b.buyLeg.strike;
          return b.buyLeg.strike - a.buyLeg.strike;
        });
        setPositions(sorted);
      } else if (data) {
        setPositions([]);
      }
    } catch (e) { console.error('Fetch Active Error:', e); }
  }, [underlying, selExpiry]);

  const fetchSupabaseConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('paper_trading_config').select('*').eq('id', 'global').single();
      if (data && !error) {
        setConfig({
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium
        });
      }
    } catch (e) { }
  }, []);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('trade_history')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(50);

      if (error) return;
      if (data) {
        const mapped = data.map(t => ({
          id: t.trade_id || t.id,
          underlying: t.underlying,
          expiry: t.expiry,
          type: t.type,
          buyLeg: safeParseLeg(t.buy_leg),
          sellLeg: safeParseLeg(t.sell_leg),
          sellQty: t.sell_qty,
          strikeDiff: t.strike_diff,
          entryTime: new Date(t.entry_time),
          exitTime: new Date(t.exit_time),
          entryBuyPrice: t.entry_buy_price,
          entrySellPrice: t.entry_sell_price,
          exitBuyPrice: t.exit_buy_price,
          exitSellPrice: t.exit_sell_price,
          margin: t.margin,
          realizedGrossPnl: t.realized_gross_pnl,
          realizedNetPnl: t.realized_net_pnl,
          exitFee: t.exit_fee,
          totalFees: t.total_fees,
          exitReason: t.exit_reason
        }));
        setTradeHistory(mapped);
      }
    } catch (e) { }
  }, []);

  useEffect(() => {
    fetchSupabaseActivePositions();
    fetchSupabaseTradeHistory();
    fetchSupabaseConfig();
  }, [fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig]);

  // Periodic sync every 30s to stay aligned across devices
  useEffect(() => {
    if (!trading) return;
    const interval = setInterval(() => {
      fetchSupabaseActivePositions();
      fetchSupabaseTradeHistory();
      fetchSupabaseConfig();
    }, 30000);
    return () => clearInterval(interval);
  }, [trading, fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig]);

  // Sync to Supabase handled within updateConfig or manual trigger if needed
  // No longer need global useEffect for underlying/expiry sync as it's handled in updateConfig

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
    setTickerData({});
    latestTickerDataRef.current = {};
    setExpectedTickerCount(0);
    lastEvaluatedRef.current = 0;
    setLastEvaluated(0);
    setTimeRemaining(null);

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
        const markPrice = toFiniteNumber(msg.mark_price ?? msg.last_price ?? msg.close);
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;

        const meta = symbolMeta[sym];
        if (!meta) return;

        const prevBuffered = tickerBufferRef.current[sym] ?? latestTickerDataRef.current[sym];
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

        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
      },
      () => { }
    );
  }, [selExpiry, products, flushTickerBuffer]);

  // ── Auto-start/restart stream when parameters change ──────────────────
  useEffect(() => {
    if (products.length && selExpiry) {
      startTrading();
    }
  }, [products, selExpiry, startTrading]);

  const stopTrading = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(false);
  }, []);

  /**
   * Scans available tickers to find valid Ratio Spread pairs based on config.
   * Returns top-3 unique buy strikes per type.
   */
  const scanTickers = useCallback((tickers) => {
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
        if (!buyDN || !sellDN || !buyLeg.markPrice || !sellLeg.markPrice) continue;

        const ratioDeviation = Math.abs((buyLeg.markPrice / sellLeg.markPrice) - (buyDN / sellDN)) / (buyDN / sellDN);
        if (ratioDeviation > config.maxRatioDeviation) continue;

        const rawQty = buyDN / sellDN;
        const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
        const netPrem = buyLeg.markPrice - sellQty * sellLeg.markPrice;
        const maxNet = Math.abs(config.maxNetPremium);
        if (netPrem < -maxNet || netPrem > maxNet) continue;

        validPairs.push({ buyLeg, sellLeg, strikeDiff, sellQty, netPremium: netPrem });
      }
    }

    validPairs.sort((a, b) => {
      const distA = Math.abs(a.buyLeg.strike - spotPrice);
      const distB = Math.abs(b.buyLeg.strike - spotPrice);
      if (distA !== distB) return distA - distB;
      return a.netPremium - b.netPremium;
    });

    return pickTopUniqueBuyStrikes(validPairs, 3);
  }, [config, spotPrice, pickTopUniqueBuyStrikes]);


  const evaluateStrategy = useCallback((force = false) => {
    if (!trading || !spotPrice) return;

    const allTickers = Object.values(latestTickerDataRef.current);
    if (allTickers.length === 0) return;

    const nowTime = Date.now();
    const currentMinute = Math.floor(nowTime / 60000);
    const lastMinute = Math.floor(lastEvaluatedRef.current / 60000);

    // Only run the complex strategy evaluation once per minute OR when a fresh scanner update arrives OR if forced
    const scannerUpdated = scannerSyncVersion > lastProcessedScannerVersionRef.current;
    const shouldEvaluateAlgo = force || currentMinute > lastMinute || lastEvaluatedRef.current === 0 || scannerUpdated;

    if (scannerUpdated) {
      lastProcessedScannerVersionRef.current = scannerSyncVersion;
    }


    /**
     * PHASE 1: Real-time PnL & Fee Monitoring
     * This section updates current prices and PnL values every 10 seconds.
     */
    if (!shouldEvaluateAlgo) {
      // Throttle PnL updates to every 5 seconds for stability
      if (nowTime - lastEvaluatedRef.current < 5000) return;

      setPositions(prev => {
        if (prev.length === 0) return prev;
        const updated = prev.map(pos => {
          const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice ?? pos.currentBuyPrice ?? pos.buyLeg.markPrice;
          const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice ?? pos.currentSellPrice ?? pos.sellLeg.markPrice;

          const buyPnl = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
          const sellPnl = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) * pos.sellQty : 0;
          const grossPnl = (buyPnl - sellPnl) * pos.buyLeg.lotSize + (pos.accumulatedSellPnl || 0);

          const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) +
            calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
          const totalFees = (pos.entryFee || 0) + exitFee;

          return {
            ...pos,
            currentBuyPrice: latestBuy,
            currentSellPrice: latestSell,
            unrealizedGrossPnl: grossPnl,
            unrealizedNetPnl: grossPnl - totalFees,
            currentExitFee: exitFee,
            currentTotalFees: totalFees
          };
        });
        return updated;
      });
      return;
    }

    /**
     * PHASE 2: Algorithm Strategy Evaluation (Minute Cycle)
     * This handles scanning, rotation, rolls, and trade execution.
     */
    const alignedNow = currentMinute * 60000;
    lastEvaluatedRef.current = alignedNow;
    setLastEvaluated(alignedNow);

    // Identify current ATM strike for directional filtering
    let atmStrike = null;
    let minDiff = Infinity;
    for (const t of allTickers) {
      const diff = Math.abs(t.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = t.strike;
      }
    }

    // A. Local Scan: Find current Top 3 unique buy strikes per type
    const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
    const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));

    const localTopCalls = scanTickers(callTickers);
    const localTopPuts = scanTickers(putTickers);
    const localTopSpreads = [...localTopCalls, ...localTopPuts];

    // B. Scanner Sync: Merge with external RatioSpreadScanner data if available
    let topSpreads = localTopSpreads;
    const snapshot = scannerTopRef.current;
    if (snapshot && snapshot.underlying === underlying && snapshot.expiry === selExpiry) {
      const localById = new Map(localTopSpreads.map(s => [`${s.buyLeg.symbol}_${s.sellLeg.symbol}`, s]));
      const synced = [];
      const scannerIds = [...(snapshot.callTop3 || []), ...(snapshot.putTop3 || [])];

      for (const item of scannerIds) {
        const spread = localById.get(item.id);
        if (spread) {
          if (item.sellQty !== undefined) spread.sellQty = item.sellQty;
          synced.push(spread);
        }
      }

      if (scannerIds.length > 0) {
        const seen = new Set(synced.map(s => `${s.buyLeg.symbol}_${s.sellLeg.symbol}`));
        const backfilled = [...synced];
        for (const spread of localTopSpreads) {
          const id = `${spread.buyLeg.symbol}_${spread.sellLeg.symbol}`;
          if (seen.has(id)) continue;
          backfilled.push(spread);
          if (backfilled.length >= 6) break;
        }
        const byTypeCall = backfilled.filter(s => s.buyLeg.type === 'call');
        const byTypePut = backfilled.filter(s => s.buyLeg.type === 'put');
        topSpreads = [...pickTopUniqueBuyStrikes(byTypeCall, 3), ...pickTopUniqueBuyStrikes(byTypePut, 3)];
      }
    }

    // Guard: Prevent accidental exits during data gaps
    // Use Ref to avoid stale closures and unnecessary dependencies
    const prevPositions = positionsRef.current;
    const remaining = [];
    const exited = [];
    const activeBuySymbols = new Set();

    // 1. Maintain existing positions & detect exits
    for (const pos of prevPositions) {
      let shouldExit = false;
      let exitReason = '';

      const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice ?? pos.currentBuyPrice ?? pos.buyLeg.markPrice;
      const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice ?? pos.currentSellPrice ?? pos.sellLeg.markPrice;
      const buyPnl = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize : 0;
      const sellPnl = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) * pos.sellLeg.lotSize * pos.sellQty : 0;
      const grossPnl = buyPnl - sellPnl + (pos.accumulatedSellPnl || 0);
      const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) +
        calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
      const totalFees = (pos.entryFee || 0) + exitFee;

      const typeSpreads = topSpreads.filter(s => s.buyLeg.type === pos.type);
      const inTop3 = typeSpreads.some(s => s.buyLeg.strike === pos.buyLeg.strike);

      if (topSpreads.length > 0 && !inTop3) {
        const currentActiveStrikes = prevPositions.map(p => p.buyLeg.strike);
        const newStrikesAvailable = typeSpreads.some(s => !currentActiveStrikes.includes(s.buyLeg.strike));
        if (newStrikesAvailable) {
          const top1Spread = typeSpreads[0];
          if (top1Spread) {
            const top1Strike = top1Spread.buyLeg.strike;
            const currentStrike = pos.buyLeg.strike;
            const isPut = pos.type === 'put';
            if (isPut ? (top1Strike > currentStrike) : (top1Strike < currentStrike)) {
              shouldExit = true; exitReason = `Lost Top 3 and Rank 1 is better (${top1Strike})`;
            }
          }
        }
      }

      if (!shouldExit) {
        const isCall = pos.type === 'call';
        const buyStrike = pos.buyLeg.strike;

        // Expiry Rotation: If the position belongs to a different expiry, rotate to the currently selected one
        if (pos.expiry !== selExpiry) {
          shouldExit = true;
          exitReason = `Rotation: Switched to ${fmtExpiry(selExpiry)}`;
        } else if (pos.strikeDiff < 1000) {
          if (isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike) {
            shouldExit = true; exitReason = 'Reached ATM (<1000 diff)';
          }
        } else if (pos.strikeDiff < 1200 && (isCall ? spotPrice - buyStrike : buyStrike - spotPrice) >= 200) {
          shouldExit = true; exitReason = '200 points ITM (<1200 diff)';
        } else if (pos.strikeDiff < 1400 && (isCall ? spotPrice - buyStrike : buyStrike - spotPrice) >= 300) {
          shouldExit = true; exitReason = '300 points ITM (<1400 diff)';
        }
      }

      if (shouldExit) {
        exited.push({
          ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell,
          realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees,
          exitFee, totalFees, exitReason, _latestBuy: latestBuy, _latestSell: latestSell
        });
      } else {
        remaining.push({
          ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell,
          unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees,
          currentExitFee: exitFee, currentTotalFees: totalFees
        });
        activeBuySymbols.add(pos.buyLeg.symbol);
      }
    }

    // 2. Open New Positions (Entries)
    const newEntries = [];
    for (const spread of topSpreads) {
      if (activeBuySymbols.has(spread.buyLeg.symbol)) continue;
      const count = (remaining.filter(p => p.type === spread.buyLeg.type).length) + (newEntries.filter(p => p.type === spread.buyLeg.type).length);
      if (count >= 3) continue;

      const entryBuyFee = calculateFee(spread.buyLeg.markPrice, spotPrice, 1, spread.buyLeg.lotSize);
      const entrySellFee = calculateFee(spread.sellLeg.markPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
      const entryFee = entryBuyFee + entrySellFee;
      const id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const newPos = {
        id, underlying, expiry: selExpiry, type: spread.buyLeg.type,
        buyLeg: spread.buyLeg, sellLeg: spread.sellLeg, sellQty: spread.sellQty,
        strikeDiff: spread.strikeDiff, entryTime: new Date(), entryBuyPrice: spread.buyLeg.markPrice,
        entrySellPrice: spread.sellLeg.markPrice, currentBuyPrice: spread.buyLeg.markPrice,
        currentSellPrice: spread.sellLeg.markPrice, unrealizedGrossPnl: 0, unrealizedNetPnl: -entryFee,
        entryFee, currentExitFee: entryFee, currentTotalFees: entryFee * 2,
        margin: (spread.buyLeg.markPrice * spread.buyLeg.lotSize) + (spread.sellLeg.markPrice * spread.sellLeg.lotSize * spread.sellQty / 200)
      };
      newEntries.push(newPos);
      activeBuySymbols.add(spread.buyLeg.symbol);
    }

    // 3. side effects (Supabase)
    if (exited.length > 0 || newEntries.length > 0) {
      lastDbWriteRef.current = Date.now();
    }

    if (exited.length > 0) {
      setTradeHistory(th => [...exited, ...th]);
      exited.forEach(async (t) => {
        try {
          // Guard: Check if this trade was already moved to history by another instance
          const { data: alreadyExited } = await supabase.from('trade_history').select('trade_id').eq('trade_id', t.id).limit(1);
          if (alreadyExited && alreadyExited.length > 0) {
            console.log('Sync: Trade already recorded in history by another device.');
          } else {
            // Record to permanent trade_history
            const { error: histError } = await supabase.from('trade_history').insert([{
              trade_id: t.id, underlying, expiry: selExpiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(),
              entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice, margin: t.margin,
              exit_time: t.exitTime.toISOString(), exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell,
              realized_gross_pnl: t.realizedGrossPnl, realized_net_pnl: t.realizedNetPnl,
              exit_fee: t.exitFee, total_fees: t.totalFees, exit_reason: t.exitReason
            }]);
            if (histError) console.error('History Persist Error:', histError);
          }

          // Delete from active_positions
          await supabase.from('active_positions').delete().eq('id', t.id);
        } catch (err) { console.error('Supabase Exit Exception:', err); }
      });
    }

    if (newEntries.length > 0) {
      newEntries.forEach(async (t) => {
        try {
          // Strict Deterministic Guard: Check by attributes
          const { data: existing, error: checkError } = await supabase.from('active_positions').select('id')
            .eq('underlying', underlying).eq('expiry', selExpiry).eq('type', t.type)
            .eq('strike_diff', t.strikeDiff).limit(1);

          if (checkError) return;
          if (existing && existing.length > 0) {
            console.log('Sync Guard: Spread already active in Supabase, skipping duplicate insert.');
            return;
          }

          const { error: insertError } = await supabase.from('active_positions').insert([{
            id: t.id, underlying, expiry: selExpiry, type: t.type,
            buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
            sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(),
            entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
            margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0
          }]);

          if (insertError) {
            if (insertError.code === '23505') {
              console.log('Database Guard: Blocked duplicate strike entry.');
            } else {
              console.error('Supabase Insert Error:', insertError);
            }
          } else {
            console.log('Supabase Insert Success:', t.id);
          }
        } catch (err) { console.error('Supabase Insert Exception:', err); }
      });
    }

    // 4. Update State (Calls before Puts, Call Asc Buy Strike, Put Desc Buy Strike)
    const finalPositions = [...remaining, ...newEntries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
      if (a.type === 'call') return a.buyLeg.strike - b.buyLeg.strike;
      return b.buyLeg.strike - a.buyLeg.strike;
    });
    setPositions(finalPositions);

  }, [trading, spotPrice, tickerData, config, underlying, selExpiry, scannerSyncVersion, pickTopUniqueBuyStrikes, scanTickers]);

  // ── Paper Trading Engine Loop ───────────────────────────────────────────────
  useEffect(() => {
    evaluateStrategy();
  }, [tickerData, trading, spotPrice, evaluateStrategy, scannerSyncVersion]);

  useEffect(() => () => {
    if (wsRef.current) wsRef.current.close();
    if (spotIntervalRef.current) clearInterval(spotIntervalRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  // Countdown timer for next scan
  useEffect(() => {
    if (!trading || lastEvaluated === 0) {
      setTimeRemaining(null);
      return;
    }

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
  }, [lastEvaluated, trading]);

  // ── Cross-tab sync ──────────────────────────────────
  const startTradingRef = useRef(startTrading);
  startTradingRef.current = startTrading;
  const stopTradingRef = useRef(stopTrading);
  stopTradingRef.current = stopTrading;

  const { broadcast: tabBroadcast } = useTabListener({
    TRADING_START: (payload) => {
      const updates = {};
      if (payload.underlying) updates.underlying = payload.underlying;
      if (payload.expiry) updates.expiry = payload.expiry;
      if (Object.keys(updates).length > 0) updateConfig(updates);
      setTimeout(() => startTradingRef.current(), 100);
    },
    TRADING_STOP: () => {
      stopTradingRef.current();
    },
    CONFIG_SYNC: (payload) => {
      if (payload.config) setConfig(payload.config);
    },
    SCANNER_TOP_SPREADS_SYNC: (payload) => {
      scannerTopRef.current = payload;
      setScannerSyncVersion(v => v + 1);
      try {
        localStorage.setItem(SCANNER_TOP_KEY, JSON.stringify(payload));
      } catch (e) { }
    }
  });

  const exportCSV = () => {
    if (!tradeHistory.length) {
      alert('Trade history is empty. Export will be available once trades are closed.');
      return;
    }
    const headers = ['Entry Time', 'Exit Time', 'Expiry', 'Type', 'Ratio', 'Buy Strike', 'Sell Strike', 'Entry Buy Price', 'Entry Sell Price', 'Exit Buy Price', 'Exit Sell Price', 'Gross PnL', 'Total Fees', 'Net PnL', 'Margin', 'Exit Reason'];
    const rows = tradeHistory.map(t => {
      return [
        formatDateTime(t.entryTime),
        formatDateTime(t.exitTime),
        fmtExpiry(t.expiry),
        t.type.toUpperCase(),
        `1:${t.sellQty}`,
        t.buyLeg.strike,
        t.sellLeg.strike,
        t.entryBuyPrice || '',
        t.entrySellPrice || '',
        t.exitBuyPrice || '',
        t.exitSellPrice || '',
        (t.realizedGrossPnl || 0).toFixed(2),
        (t.totalFees || 0).toFixed(2),
        (t.realizedNetPnl || 0).toFixed(2),
        (t.margin || 0).toFixed(2),
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
  const totalUnrealizedPnl = positions.filter(p => p.expiry === selExpiry).reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || p.unrealizedPnl || 0)), 0);
  const totalRealizedPnl = tradeHistory.reduce((s, t) => s + (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || t.realizedPnl || 0)), 0);
  const totalPnl = totalUnrealizedPnl + totalRealizedPnl;
  const wins = tradeHistory.filter(t => (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || t.realizedPnl || 0)) > 0).length;
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
          <div className="pt-control-section" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span className="pt-control-label">Algo</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Underlying:</label>
              <select value={underlying} onChange={e => { updateConfig('underlying', e.target.value); stopTrading(); }} style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => { updateConfig('expiry', e.target.value); stopTrading(); }} disabled={!expiries.length} style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
                {!expiries.length ? <option>Loading...</option> : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
              </select>
            </div>

            <div style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

            <span className="pt-control-label">Filters</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Strike Diff ($):</label>
              <input type="number" value={config.minStrikeDiff} onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min IV Diff (%):</label>
              <input type="number" value={config.minIvDiff} onChange={e => updateConfig('minIvDiff', Number(e.target.value))} style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Ratio Dev:</label>
              <input type="number" step="0.01" value={config.maxRatioDeviation} onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Sell Prem ($):</label>
              <input type="number" value={config.minSellPremium} onChange={e => updateConfig('minSellPremium', Number(e.target.value))} style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Debit ($):</label>
              <input type="number" value={config.maxNetPremium} onChange={e => updateConfig('maxNetPremium', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
          </div>

          {spotPrice && (
            <div className="pt-spot-display">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
            </div>
          )}

          <div className="pt-status-badge live">
            <span className="pt-pulse"></span>
            LIVE ALGO
          </div>

          <div style={{ flex: 1 }} />

          <button className="pt-btn-export" onClick={exportCSV}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export CSV
          </button>
        </div>

        {/* ── KPI Dashboard ───────────────────────────── */}
        <div className="pt-kpi-strip">
          <div className={`pt-kpi-card ${totalPnl >= 0 ? 'accent-green' : 'accent-red'}`}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              Total P&L
            </span>
            <span className={`pt-kpi-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral'}`}>
              {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Realized: {totalRealizedPnl.toFixed(2)} | Unrl: {totalUnrealizedPnl.toFixed(2)}</span>
          </div>

          <div className="pt-kpi-card accent-gold">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 12l3 3 5-5" /></svg>
              Win Rate
            </span>
            <span className="pt-kpi-value neutral">{winRate}{winRate !== '—' ? '%' : ''}</span>
            <span className="pt-kpi-sub">{wins}W / {tradeHistory.length - wins}L of {tradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.filter(p => p.expiry === selExpiry).length}</span>
            <span className="pt-kpi-sub">{positions.filter(p => p.type === 'call' && p.expiry === selExpiry).length} calls / {positions.filter(p => p.type === 'put' && p.expiry === selExpiry).length} puts</span>
          </div>

          <div className="pt-kpi-card accent-purple">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
              Trades
            </span>
            <span className="pt-kpi-value neutral">{tradeHistory.length}</span>
            <span className="pt-kpi-sub">Closed positions</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
              Margin Used
            </span>
            <span className="pt-kpi-value neutral">${positions.filter(p => p.expiry === selExpiry).reduce((s, p) => s + (p.margin || 0), 0).toFixed(0)}</span>
            <span className="pt-kpi-sub">Across {positions.filter(p => p.expiry === selExpiry).length} position{positions.filter(p => p.expiry === selExpiry).length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className={`pt-section ${trading ? 'live' : ''}`}>
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions ({fmtExpiry(selExpiry)})
                <span className="pt-section-count">{positions.filter(p => p.expiry === selExpiry).length}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {lastEvaluated > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', borderRight: '1px solid var(--border)', paddingRight: 16 }}>
                    Updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastEvaluated))}
                  </div>
                )}
                <div className="pt-fee-toggle-container">
                  <span className={`pt-fee-toggle-label ${!includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(false)}>Gross</span>
                  <label className="pt-switch">
                    <input type="checkbox" checked={includeFees} onChange={e => setIncludeFees(e.target.checked)} />
                    <span className="pt-slider"></span>
                  </label>
                  <span className={`pt-fee-toggle-label ${includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(true)}>Net</span>
                </div>
              </div>

              {trading && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    onClick={() => evaluateStrategy(true)}
                    title="Refresh Now"
                    style={{
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      color: 'var(--text)', borderRadius: '6px', padding: '2px 8px',
                      display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                      fontSize: '12px', height: '24px'
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {timeRemaining !== null && timeRemaining <= 60 ? `${timeRemaining}s` : ''}
                  </button>
                  <div className="pt-live-badge">
                    <div className="pt-live-dot" />
                    Monitoring
                  </div>
                </div>
              )}
            </div>
            {positions.length === 0 ? (
              <div className="pt-empty">
                <div className={`pt-empty-icon ${trading ? 'scanning' : 'idle'}`}>
                  {trading ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0ecb81" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" /></path></svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></svg>
                  )}
                </div>
                <span className="pt-empty-title">{trading ? 'Scanning for Opportunities...' : 'Algo Idle'}</span>
                <span className="pt-empty-desc">{trading ? 'The engine is analyzing live option chains for ratio spread entries. Positions will appear here automatically.' : 'Select expiry and click Start Trading to begin automated ratio spread scanning.'}</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type / Ratio</th>
                    <th>Expiry</th>
                    <th>Buy / Sell Strike</th>
                    <th>In (Buy / Sell)</th>
                    <th>Current (Buy / Sell)</th>
                    <th>Unrl P&L</th>
                    <th>Margin</th>
                    <th>Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.filter(p => p.expiry === selExpiry).map(p => {
                      const pnlValue = includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl || p.unrealizedPnl;
                      const pnlClass = (pnlValue || 0) > 0 ? 'positive' : (pnlValue || 0) < 0 ? 'negative' : 'zero';
                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>1:{p.sellQty}</span>
                            </div>
                          </td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(p.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{p.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{p.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
                              <span style={{ color: '#f85149' }}>{p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—'}</span>
                            </div>
                          </td>
                          <td><span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{(pnlValue || 0).toFixed(2)}</span></td>
                          <td>
                            <div className="pt-margin-cell">
                              <span>${(p.margin || 0).toFixed(0)}</span>
                              <div className="pt-margin-bar"><div className="pt-margin-fill" style={{ width: `${Math.min(100, (p.margin / (totalMargin || 1)) * 100)}%` }} /></div>
                            </div>
                          </td>
                          <td><span className="pt-duration">{fmtDuration(new Date() - p.entryTime)}</span></td>
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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                Trade History
                <span className="pt-section-count">{tradeHistory.length}</span>
              </div>
              {tradeHistory.length > 0 && (
                <div className="pt-history-stats">
                  <span className="pt-history-stat">Net: <span className={`value ${totalRealizedPnl >= 0 ? 'green' : 'red'}`}>{totalRealizedPnl > 0 ? '+' : ''}{totalRealizedPnl.toFixed(2)}</span></span>
                  <span className="pt-history-stat">W/L: <span className="value green">{wins}</span>/<span className="value red">{tradeHistory.length - wins}</span></span>
                  <button
                    className="pt-export-btn"
                    onClick={() => {
                      const data = tradeHistory.map(t => ({
                        ...t,
                        ai_reviews: aiReviews[t.id] || null
                      }));
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `vitti_ai_training_data_${new Date().toISOString().split('T')[0]}.json`;
                      a.click();
                    }}
                    title="Download Dataset for AI Fine-Tuning"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    Export for AI
                  </button>
                </div>
              )}
            </div>
            {tradeHistory.length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon idle">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                </div>
                <span className="pt-empty-title">No Closed Trades</span>
                <span className="pt-empty-desc">Trades will appear here once positions are exited — either automatically by the algo or manually by you.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Entry Time</th>
                    <th>Exit Time</th>
                    <th>Duration</th>
                    <th>Expiry</th>
                    <th>Type / Ratio</th>
                    <th>Buy / Sell Strike</th>
                    <th>In (Buy / Sell)</th>
                    <th>Out (Buy / Sell)</th>
                    <th>Realized P&L</th>
                    <th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {tradeHistory.map((t, i) => {
                      const pnlValue = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || t.realizedPnl || 0);
                      const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;
                      return (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.entryTime)}</td>
                          <td style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.exitTime)}</td>
                          <td><span className="pt-duration" style={{ fontSize: '11px' }}>{fmtDuration(durationMs)}</span></td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(t.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${t.type}`}>{t.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>1:{t.sellQty}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{t.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{t.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.exitBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{t.exitSellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                              <span className={`pt-pnl ${pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero'}`}>
                                {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${t.margin?.toFixed(0)}</span>
                            </div>
                          </td>
                          <td><span className={`pt-exit-badge ${exitBadgeClass(t.exitReason)}`}>{t.exitReason}</span></td>
                        </tr>
                      )
                    })}
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
