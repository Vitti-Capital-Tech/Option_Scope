import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];

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

const calcMargin = (buyPrice, buyLot, spot, sellQty, sellLot = 1) => {
  const longMargin = (buyPrice || 0) * (buyLot || 1);
  const shortValue = (spot || 0) * (sellQty || 0) * sellLot;
  let leverage = 200;
  if (shortValue <= 200000) leverage = 200;
  else if (shortValue <= 450000) leverage = 100;
  else if (shortValue <= 950000) leverage = 50;
  else leverage = 25;
  return longMargin + (shortValue / leverage);
};

const getQtyTable = (sellQty) => {
  if (sellQty <= 2.5) return 'atm_exit_qty_0_2_5';
  if (sellQty <= 5) return 'atm_exit_qty_2_5_5';
  if (sellQty <= 7.5) return 'atm_exit_qty_5_7_5';
  return 'atm_exit_qty_7_5_10';
};

const upsertAnalytics = async (trade) => {
  try {
    const tableName = getQtyTable(trade.sellQty);
    const netPremium = (trade.entryBuyPrice || 0) - (trade.sellQty || 0) * (trade.entrySellPrice || 0);
    const strikeDiff = Math.round((trade.strikeDiff || 0) / 100) * 100;

    const { data: existing } = await supabase
      .from(tableName)
      .select('*')
      .eq('strike_diff', strikeDiff)
      .eq('underlying', trade.underlying)
      .eq('type', trade.type)
      .maybeSingle();

    if (existing) {
      const n = existing.trade_count + 1;
      const avg = (v, nv) => ((v * (n - 1)) + nv) / n;
      await supabase.from(tableName).update({
        trade_count: n,
        avg_margin: avg(existing.avg_margin || 0, trade.margin || 0),
        avg_pnl: avg(existing.avg_pnl || 0, trade.realizedNetPnl || 0),
        avg_net_premium: avg(existing.avg_net_premium || 0, netPremium),
        avg_fees: avg(existing.avg_fees || 0, trade.totalFees || 0),
        updated_at: new Date().toISOString(),
      })
        .eq('strike_diff', strikeDiff)
        .eq('underlying', trade.underlying)
        .eq('type', trade.type);
    } else {
      await supabase.from(tableName).insert([{
        strike_diff: strikeDiff,
        underlying: trade.underlying,
        type: trade.type,
        trade_count: 1,
        avg_margin: trade.margin || 0,
        median_margin: trade.margin || 0,
        avg_pnl: trade.realizedNetPnl || 0,
        avg_net_premium: netPremium,
        avg_fees: trade.totalFees || 0,
        updated_at: new Date().toISOString(),
      }]);
    }
  } catch (e) { console.error('Analytics upsert error:', e); }
};

export default function ATMExitTrading({ onNavigate, theme, toggleTheme }) {
  const [config, setConfig] = useState(() => ({
    underlying: 'BTC',
    expiry: '',
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
    maxNetPremium: 20,
    minLongDist: 500,
    maxSellQty: 10,
  }));

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [trading, setTrading] = useState(false);

  const [includeFees, setIncludeFees] = useState(true);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  
  // Analytics State
  const [analyticsData, setAnalyticsData] = useState({}); // { '0_2_5': [], ... }
  const [showTotalMode, setShowTotalMode] = useState(false); // Toggle for avg vs total

  // Core entry tracking
  const lastEntrySpotRef = useRef({ call: null, put: null });

  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });

  const adjustFilterDay = (offset) => {
    if (!historyFilterDate) return;
    const [y, m, d] = historyFilterDate.split('-').map(Number);
    const current = new Date(Date.UTC(y, m - 1, d));
    current.setUTCDate(current.getUTCDate() + offset);
    setHistoryFilterDate(current.toISOString().split('T')[0]);
  };

  const resetToToday = () => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    setHistoryFilterDate(d.toISOString().split('T')[0]);
  };

  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});

  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastEvaluatedRef = useRef(0);
  const lastDbWriteRef = useRef(0);
  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);
  
  const positionsRef = useRef([]);
  const isEvaluatingRef = useRef(false);
  const lastWsSymbolsRef = useRef('');
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData({ ...latestTickerDataRef.current });
  }, []);

  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        updateConfig('expiry', exps[0]);
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry]);

  useEffect(() => {
    setExpiries([]);
    setTickerData({});
    refreshProducts();
  }, [underlying]);

  // ── Periodically refresh products to catch expiries and rollover ────────
  useEffect(() => {
    const interval = setInterval(() => {
      refreshProducts();
    }, 5 * 60 * 1000); // 5 minutes
    return () => clearInterval(interval);
  }, [refreshProducts]);

  const saveSupabaseConfig = useCallback(async (newCfg) => {
    try {
      await supabase.from('atm_exit_config').upsert({
        id: 'global',
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        min_long_dist: newCfg.minLongDist,
        max_sell_qty: newCfg.maxSellQty,
        updated_at: new Date().toISOString()
      });
    } catch (e) { }
  }, []);

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      tabBroadcast('ATM_EXIT_CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  const fetchSupabaseActivePositions = useCallback(async () => {
    try {
      if (Date.now() - lastDbWriteRef.current < 10000) return;
      const { data, error } = await supabase
        .from('atm_exit_active_positions')
        .select('*')
        .order('entry_time', { ascending: true });

      if (error) { console.error('Error fetching active positions:', error); return; }

      if (data && data.length > 0) {
        setPositions(prev => {
          const prevMap = new Map(prev.map(p => [p.id, p]));
          const mapped = data.map(p => {
            const existing = prevMap.get(p.id);
            const buyLeg = safeParseLeg(p.buy_leg);
            const sellLeg = safeParseLeg(p.sell_leg);
            return {
              id: p.id, underlying: p.underlying, expiry: p.expiry, type: p.type,
              buyLeg, sellLeg,
              sellQty: p.sell_qty, strikeDiff: p.strike_diff, entryTime: new Date(p.entry_time),
              entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
              entrySpotPrice: p.entry_spot_price,
              margin: p.margin || 0, entryFee: p.entry_fee || 0, accumulatedSellPnl: p.accumulated_sell_pnl || 0,
              currentBuyPrice: existing?.currentBuyPrice ?? null,
              currentSellPrice: existing?.currentSellPrice ?? null,
              unrealizedGrossPnl: existing?.unrealizedGrossPnl ?? 0,
              unrealizedNetPnl: existing?.unrealizedNetPnl ?? -(p.entry_fee || 0),
              currentExitFee: existing?.currentExitFee ?? 0,
              currentTotalFees: existing?.currentTotalFees ?? (p.entry_fee || 0),
            };
          });

          return mapped.filter(p => p.buyLeg && p.sellLeg).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
            if (a.type === 'call') return a.buyLeg.strike - b.buyLeg.strike;
            return b.buyLeg.strike - a.buyLeg.strike;
          });
        });
      } else if (data) {
        setPositions([]);
      }
    } catch (e) { console.error('Fetch Active Error:', e); }
  }, [underlying, selExpiry]);

  const fetchSupabaseConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('atm_exit_config').select('*').eq('id', 'global').maybeSingle();
      if (data && !error) {
        setConfig({
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10
        });
      }
    } catch (e) { }
  }, []);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('atm_exit_trade_history')
        .select('*')
        .eq('underlying', underlying)
        .order('exit_time', { ascending: false });

      if (error) return;
      if (data) {
        const mapped = data.map(t => ({
          id: t.trade_id || t.id,
          underlying: t.underlying, expiry: t.expiry, type: t.type,
          buyLeg: safeParseLeg(t.buy_leg), sellLeg: safeParseLeg(t.sell_leg),
          sellQty: t.sell_qty, strikeDiff: t.strike_diff,
          entryTime: new Date(t.entry_time), exitTime: new Date(t.exit_time),
          entryBuyPrice: t.entry_buy_price, entrySellPrice: t.entry_sell_price,
          exitBuyPrice: t.exit_buy_price, exitSellPrice: t.exit_sell_price,
          entrySpotPrice: t.entry_spot_price, exitSpotPrice: t.exit_spot_price,
          margin: t.margin, realizedGrossPnl: t.realized_gross_pnl, realizedNetPnl: t.realized_net_pnl,
          exitFee: t.exit_fee, totalFees: t.total_fees, entryFee: (t.total_fees || 0) - (t.exit_fee || 0),
          exitReason: t.exit_reason,
        }));
        setTradeHistory(mapped);
      }
    } catch (e) { }
  }, [underlying]);

  const fetchAnalytics = useCallback(async () => {
    const buckets = ['atm_exit_qty_0_2_5', 'atm_exit_qty_2_5_5', 'atm_exit_qty_5_7_5', 'atm_exit_qty_7_5_10'];
    const results = {};
    for (const b of buckets) {
      const { data } = await supabase.from(b).select('*').eq('underlying', underlying).order('strike_diff');
      results[b] = data || [];
    }
    setAnalyticsData(results);
  }, [underlying]);

  useEffect(() => {
    if (!trading) return;
    fetchSupabaseActivePositions();
    fetchSupabaseTradeHistory();
    fetchSupabaseConfig();
    fetchAnalytics();
    const interval = setInterval(() => {
      fetchSupabaseActivePositions();
      fetchSupabaseTradeHistory();
      fetchAnalytics();
    }, 10000);
    return () => clearInterval(interval);
  }, [trading, fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig, fetchAnalytics]);

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

  const getSymbolMeta = useCallback(() => {
    if (!selExpiry || !products.length) return {};
    const strikes = getStrikes(products, selExpiry);
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
    positionsRef.current.forEach(pos => {
      if (pos.underlying === underlying) {
        if (pos.buyLeg && !symbolMeta[pos.buyLeg.symbol]) symbolMeta[pos.buyLeg.symbol] = { strike: pos.buyLeg.strike, lotSize: pos.buyLeg.lotSize, type: pos.type, symbol: pos.buyLeg.symbol };
        if (pos.sellLeg && !symbolMeta[pos.sellLeg.symbol]) symbolMeta[pos.sellLeg.symbol] = { strike: pos.sellLeg.strike, lotSize: pos.sellLeg.lotSize, type: pos.type, symbol: pos.sellLeg.symbol };
      }
    });
    return symbolMeta;
  }, [selExpiry, products, underlying]);

  const refreshAllTickers = useCallback(async () => {
    const symbolMeta = getSymbolMeta();
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.length) return false;
    try {
      const res = await getTickers(underlying, allSymbols);
      if (res) {
        const backfill = {};
        res.forEach(t => {
          const meta = symbolMeta[t.symbol];
          if (meta) {
            const prev = latestTickerDataRef.current[t.symbol];
            const markPrice = toFiniteNumber(t.mark_price ?? t.last_price ?? t.close);
            const iv = normalizeIv(toFiniteNumber(t.mark_vol ?? t.quotes?.mark_iv ?? t.greeks?.iv));
            const bid = toFiniteNumber(t.quotes?.best_bid);
            const ask = toFiniteNumber(t.quotes?.best_ask);
            const bidIv = normalizeIv(toFiniteNumber(t.quotes?.bid_iv));
            const askIv = normalizeIv(toFiniteNumber(t.quotes?.ask_iv));
            backfill[t.symbol] = {
              symbol: t.symbol, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
              markPrice: (markPrice && markPrice > 0) ? markPrice : (prev?.markPrice ?? null),
              bid: bid ?? (prev?.bid ?? null), ask: ask ?? (prev?.ask ?? null),
              bidIv: bidIv ?? (prev?.bidIv ?? null), askIv: askIv ?? (prev?.askIv ?? null),
              iv: iv ?? (prev?.iv ?? null),
              delta: t.greeks ? toFiniteNumber(t.greeks.delta) : (prev?.delta ?? null),
              deltaNotional: t.greeks ? Math.abs(t.greeks.delta) * meta.lotSize : (prev?.deltaNotional ?? null),
            };
          }
        });
        latestTickerDataRef.current = { ...latestTickerDataRef.current, ...backfill };
        setTickerData(prev => ({ ...prev, ...backfill }));
        return true;
      }
    } catch (e) {}
    return false;
  }, [underlying, getSymbolMeta]);

  const startTrading = useCallback(() => {
    if (!selExpiry || !products.length) return;
    const configSymbols = [...new Set(products.map(p => p.symbol))];
    const symHash = configSymbols.sort().join(',');
    if (wsRef.current && lastWsSymbolsRef.current === symHash) return;
    if (wsRef.current) { try { wsRef.current.close(); } catch (e) {} wsRef.current = null; }
    lastWsSymbolsRef.current = symHash;
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(true);
    setTickerData({});
    latestTickerDataRef.current = {};
    lastEvaluatedRef.current = 0;
    setLastEvaluated(0);
    setTimeRemaining(null);

    const symbolMeta = getSymbolMeta();
    const allSymbols = Object.keys(symbolMeta);
    if (allSymbols.length < 2) { setTrading(false); return; }

    refreshAllTickers().then(success => {
      if (success) setTimeout(() => evaluateStrategy(true), 100);
    });

    wsRef.current = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        const meta = symbolMeta[sym];
        if (!meta) return;
        const markPrice = toFiniteNumber(msg.mark_price ?? msg.last_price ?? msg.close);
        const bid = toFiniteNumber(msg.quotes?.best_bid);
        const ask = toFiniteNumber(msg.quotes?.best_ask);
        const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.bid_iv));
        const askIv = normalizeIv(toFiniteNumber(msg.quotes?.ask_iv));
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;
        const prevBuffered = tickerBufferRef.current[sym] ?? latestTickerDataRef.current[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
          markPrice: markPrice ?? prevBuffered?.markPrice ?? null,
          bid: bid ?? prevBuffered?.bid ?? null, ask: ask ?? prevBuffered?.ask ?? null,
          bidIv: bidIv ?? prevBuffered?.bidIv ?? null, askIv: askIv ?? prevBuffered?.askIv ?? null,
          iv: iv ?? prevBuffered?.iv ?? null, delta: delta !== null ? delta : prevBuffered?.delta,
          deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prevBuffered?.deltaNotional,
        };
        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
      },
      () => {}
    );
  }, [selExpiry, products, flushTickerBuffer, getSymbolMeta, refreshAllTickers]);

  useEffect(() => { if (products.length && selExpiry) startTrading(); }, [products, selExpiry, startTrading]);

  const stopTrading = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(false);
  }, []);

  const scanTickers = useCallback((tickers) => {
    const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
    const validPairs = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const buy = sorted[i], sell = sorted[j];
        let buyLeg, sellLeg;
        if (buy.type === 'call') { buyLeg = buy; sellLeg = sell; } 
        else { buyLeg = sell; sellLeg = buy; }

        const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
        if (strikeDiff < config.minStrikeDiff) continue;
        
        const buyPrice = buyLeg.ask ?? buyLeg.markPrice;
        const sellPrice = sellLeg.bid ?? sellLeg.markPrice;
        const buyIv = buyLeg.askIv ?? buyLeg.iv;
        const sellIv = sellLeg.bidIv ?? sellLeg.iv;
        if (buyIv == null || sellIv == null) continue;
        
        const ivDiff = Math.abs(buyIv - sellIv);
        if (ivDiff <= config.minIvDiff) continue;
        const spotDist = Math.abs(buyLeg.strike - spotPrice);
        if (spotDist < (config.minLongDist || 0)) continue;
        if (!sellPrice || sellPrice < config.minSellPremium) continue;

        const buyDN = buyLeg.deltaNotional, sellDN = sellLeg.deltaNotional;
        if (!buyDN || !sellDN || !buyPrice || !sellPrice) continue;
        
        const premiumRatio = buyPrice / sellPrice, deltaNotionalRatio = buyDN / sellDN;
        const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
        if (ratioDeviation > config.maxRatioDeviation) continue;
        
        const rawQty = buyDN / sellDN;
        const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
        if (sellQty > (config.maxSellQty || 10)) continue;
        
        const netPrem = buyPrice - sellQty * sellPrice;
        const maxNet = Math.abs(config.maxNetPremium);
        if (netPrem < -maxNet || netPrem > maxNet) continue;

        validPairs.push({ buyLeg, sellLeg, strikeDiff, sellQty, netPremium: netPrem, buyPrice, sellPrice, buyIv, sellIv });
      }
    }
    validPairs.sort((a, b) => {
      const distA = Math.abs(a.buyLeg.strike - spotPrice);
      const distB = Math.abs(b.buyLeg.strike - spotPrice);
      if (distA !== distB) return distA - distB;
      return a.netPremium - b.netPremium;
    });
    return validPairs.slice(0, 50);
  }, [config, spotPrice]);

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

  const evaluateStrategy = useCallback(async (force = false) => {
    if (!trading || !spotPrice || isEvaluatingRef.current) return;
    isEvaluatingRef.current = true;
    try {
      const allTickers = Object.values(latestTickerDataRef.current);
      if (allTickers.length === 0) return;

      const nowTime = Date.now();
      const currentMinute = Math.floor(nowTime / 60000);
      const lastMinute = Math.floor(lastEvaluatedRef.current / 60000);

      const shouldEvaluateAlgo = force || currentMinute > lastMinute || lastEvaluatedRef.current === 0;

      if (!shouldEvaluateAlgo) {
        if (nowTime - lastEvaluatedRef.current < 1000) return;
        setPositions(prev => {
          if (prev.length === 0) return prev;
          const live = latestTickerDataRef.current;
          return prev.map(pos => {
            const tickerBuy = live[pos.buyLeg.symbol];
            const latestBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice ?? pos.buyLeg.markPrice;
            const tickerSell = live[pos.sellLeg.symbol];
            const latestSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice ?? pos.sellLeg.markPrice;

            const buyPnl = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
            const sellPnl = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) * pos.sellQty : 0;
            const grossPnl = (buyPnl * pos.buyLeg.lotSize) - (sellPnl * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);

            const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
            const totalFees = (pos.entryFee || 0) + exitFee;
            return { ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees };
          });
        });
        lastEvaluatedRef.current = nowTime;
        return;
      }

      const nowAtEval = Date.now();
      lastEvaluatedRef.current = nowAtEval;
      setLastEvaluated(nowAtEval);

      if (currentMinute % 5 === 0) refreshProducts();

      let atmStrike = null;
      let minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));

      const topSpreads = [...scanTickers(callTickers), ...scanTickers(putTickers)];
      const uniqueTopSpreads = [...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'call'), 10), ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'put'), 10)];

      const prevPositions = positionsRef.current;
      const activeCallsCount = prevPositions.filter(p => p.type === 'call' && p.underlying === underlying).length;
      const activePutsCount = prevPositions.filter(p => p.type === 'put' && p.underlying === underlying).length;
      let callRotationsApproved = 0, putRotationsApproved = 0;
      const MAX_ROTATIONS = 3;

      const remaining = [], exited = [];
      const sortedPositions = [...prevPositions].sort((a, b) => Math.abs(b.buyLeg.strike - spotPrice) - Math.abs(a.buyLeg.strike - spotPrice));
      
      for (const pos of sortedPositions) {
        if (pos.underlying !== underlying) { remaining.push(pos); continue; }

        const live = latestTickerDataRef.current;
        const tickerBuy = live[pos.buyLeg.symbol], tickerSell = live[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice;

        if (liveExitBuy == null || liveExitSell == null) { remaining.push(pos); continue; }

        const latestBuy = liveExitBuy, latestSell = liveExitSell;
        let shouldExit = false, exitReason = '', zombieExitTime = null;

        const expiryTs = new Date(pos.expiry).getTime();
        if (Date.now() >= expiryTs - 120000) {
          shouldExit = true; exitReason = 'Expiry Reached';
          if (Date.now() > expiryTs + 600000) zombieExitTime = new Date(expiryTs).toISOString();
        }

        const buyPriceDiff = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
        const sellPriceDiff = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) : 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) - (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);
        const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        const inTop3 = uniqueTopSpreads.some(s => s.buyLeg.type === pos.type && Number(s.buyLeg.strike) === Number(pos.buyLeg.strike));

        if (!shouldExit && pos.expiry === selExpiry && uniqueTopSpreads.length > 0 && !inTop3) {
          shouldExit = true; exitReason = `Lost Top 3`;
        }

        if (!shouldExit) {
          // Exit 100% ATM ONLY
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          const isAtmMET = isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike;
          if (isAtmMET) {
            shouldExit = true; exitReason = 'Full Exit @ ATM';
          }
        }

        const canRotate = pos.type === 'call' ? (activeCallsCount >= 3 && callRotationsApproved < MAX_ROTATIONS) : (activePutsCount >= 3 && putRotationsApproved < MAX_ROTATIONS);
        let rotationApproved = false;
        if (!canRotate && exitReason.includes('Lost Top 3')) {
          if (shouldExit) shouldExit = false;
        } else if (canRotate && exitReason.includes('Lost Top 3')) {
          if (shouldExit) {
            rotationApproved = true;
            if (pos.type === 'call') callRotationsApproved++; else putRotationsApproved++;
          }
        }

        if (shouldExit) {
          if (exitReason.includes('Lost Top 3') && !rotationApproved) {
            shouldExit = false;
            remaining.push({ ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees });
            continue;
          }
          const tradeRecord = {
            ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell, exitSpotPrice: spotPrice,
            realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, entryFee: pos.entryFee || 0, exitFee, totalFees, exitReason,
            _latestBuy: latestBuy, _latestSell: latestSell, zombieExitTime
          };
          exited.push(tradeRecord);
        } else {
          remaining.push({ ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees, margin: calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, Math.max(pos.entrySpotPrice || spotPrice, spotPrice), pos.sellQty, pos.sellLeg.lotSize) });
        }
      }

      const newEntries = [];
      const callsRef = lastEntrySpotRef.current.call;
      const putsRef = lastEntrySpotRef.current.put;

      for (const spread of topSpreads) {
        const spreadType = spread.buyLeg.type;
        const count = remaining.filter(p => p.underlying === underlying && p.type === spreadType).length + newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
        if (count >= 3) continue;

        const minutesToExpiry = (new Date(spread.expiry).getTime() - Date.now()) / 60000;
        if (minutesToExpiry < 5) continue;


        const existingOfType = remaining.filter(p => p.underlying === underlying && p.type === spreadType);
        const candidateLongStrike = Number(spread.buyLeg.strike);
        
        // 1. 0.5% Directional Spot price movement guard relative to entrySpotPrice of existing active positions
        let validSpotMove = true;
        for (const p of existingOfType) {
          const entrySpot = p.entrySpotPrice;
          if (entrySpot) {
            const thresh = Math.round((entrySpot * 0.005) / 100) * 100;
            const spotValid = spreadType === 'call'
              ? spotPrice <= entrySpot - thresh
              : spotPrice >= entrySpot + thresh;
            if (!spotValid) {
              validSpotMove = false;
              break;
            }
          }
        }
        if (!validSpotMove) continue;

        // 2. 400 point strike separation guard
        let validStrikeDiff = true;
        for (const p of existingOfType) {
          if (Math.abs(candidateLongStrike - Number(p.buyLeg.strike)) < 400) { validStrikeDiff = false; break; }
        }
        if (!validStrikeDiff) continue;
        
        const buyConflict = remaining.some(p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === candidateLongStrike) || newEntries.some(p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === candidateLongStrike);
        const sellConflict = remaining.some(p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === Number(spread.sellLeg.strike)) || newEntries.some(p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === Number(spread.sellLeg.strike));
        if (buyConflict || sellConflict) continue;

        const entryFee = calculateFee(spread.buyPrice, spotPrice, 1, spread.buyLeg.lotSize) + calculateFee(spread.sellPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
        const id = `ATM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        newEntries.push({
          id, underlying, expiry: selExpiry, type: spreadType, buyLeg: spread.buyLeg, sellLeg: spread.sellLeg,
          sellQty: spread.sellQty, strikeDiff: spread.strikeDiff, entryTime: new Date(), entryBuyPrice: spread.buyPrice,
          entrySellPrice: spread.sellPrice, entrySpotPrice: spotPrice, currentBuyPrice: spread.buyPrice, currentSellPrice: spread.sellPrice,
          unrealizedGrossPnl: 0, unrealizedNetPnl: -entryFee, entryFee, currentExitFee: entryFee, currentTotalFees: entryFee * 2,
          margin: calcMargin(spread.buyPrice, spread.buyLeg.lotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize)
        });

        if (spreadType === 'call') lastEntrySpotRef.current.call = spotPrice;
        else lastEntrySpotRef.current.put = spotPrice;
      }

      if (exited.length > 0 || newEntries.length > 0) lastDbWriteRef.current = Date.now();

      if (exited.length > 0) {
        setTradeHistory(th => [...exited, ...th]);
        for (const t of exited) {
          try {
            await upsertAnalytics(t);
            const { data: existingDbTrade } = await supabase.from('atm_exit_trade_history').select('trade_id').eq('trade_id', t.id).maybeSingle();
            if (!existingDbTrade) {
              await supabase.from('atm_exit_trade_history').insert([{
                trade_id: t.id, underlying, expiry: t.expiry, type: t.type, buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
                sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
                entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice, margin: t.margin, exit_time: t.zombieExitTime || new Date().toISOString(),
                exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell, exit_spot_price: t.exitSpotPrice, realized_gross_pnl: t.realizedGrossPnl,
                realized_net_pnl: t.realizedNetPnl, exit_fee: t.exitFee, total_fees: t.totalFees, exit_reason: t.exitReason
              }]);
            }
            await supabase.from('atm_exit_active_positions').delete().eq('id', t.id);
          } catch (e) {}
        }
      }
      
      if (newEntries.length > 0) {
        for (const t of newEntries) {
          try {
            const { data } = await supabase.from('atm_exit_active_positions').select('id').eq('underlying', underlying).eq('type', t.type);
            if (data?.length >= 3) continue;
            await supabase.from('atm_exit_active_positions').insert([{
              id: t.id, underlying, expiry: selExpiry, type: t.type, buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
              entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice, margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
              buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
            }]);
          } catch (e) {}
        }
      }
      
      const finalPositions = [...remaining, ...newEntries].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
        return a.type === 'call' ? (a.buyLeg?.strike ?? 0) - (b.buyLeg?.strike ?? 0) : (b.buyLeg?.strike ?? 0) - (a.buyLeg?.strike ?? 0);
      });
      positionsRef.current = finalPositions;
      if (exited.length > 0 || newEntries.length > 0) setPositions(finalPositions);
      else setPositions(prev => { if (prev.length === 0) return prev; const byId = new Map(finalPositions.map(p => [p.id, p])); return prev.map(p => byId.get(p.id) ?? p); });
    } finally { isEvaluatingRef.current = false; }
  }, [trading, underlying, selExpiry, spotPrice, pickTopUniqueStrikes, scanTickers]);

  useEffect(() => {
    let interval = null;
    if (trading) {
      interval = setInterval(() => { evaluateStrategy(); }, 1000);
      const updateTime = () => {
        const nextMin = (Math.floor(Date.now() / 60000) + 1) * 60000;
        setTimeRemaining(Math.max(0, Math.ceil((nextMin - Date.now()) / 1000)));
      };
      updateTime();
      const timerInt = setInterval(updateTime, 1000);
      return () => { clearInterval(interval); clearInterval(timerInt); };
    }
  }, [trading, evaluateStrategy]);

  const { broadcast } = useTabListener((type, data) => {
    if (type === 'ATM_EXIT_CONFIG_SYNC') {
      setConfig(prev => ({ ...prev, ...data.config }));
    }
  });
  const tabBroadcast = (type, data) => { if (broadcast) broadcast({ type, data }); };

  const closeTrade = async (pos) => {
    const live = latestTickerDataRef.current;
    const tickerBuy = live[pos.buyLeg.symbol], tickerSell = live[pos.sellLeg.symbol];
    const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
    const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice;
    if (liveExitBuy == null || liveExitSell == null) return;
    const grossPnl = (liveExitBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize - (liveExitSell - pos.entrySellPrice) * pos.sellQty * pos.sellLeg.lotSize + (pos.accumulatedSellPnl || 0);
    const exitFee = calculateFee(liveExitBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(liveExitSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
    const totalFees = (pos.entryFee || 0) + exitFee;
    const tradeRecord = {
      ...pos, exitTime: new Date(), exitBuyPrice: liveExitBuy, exitSellPrice: liveExitSell, exitSpotPrice: spotPrice,
      realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, entryFee: pos.entryFee || 0, exitFee, totalFees, exitReason: 'Manual Exit',
    };
    try {
      await supabase.from('atm_exit_active_positions').delete().eq('id', pos.id);
      await upsertAnalytics(tradeRecord);
      const { data: existingDbTrade } = await supabase.from('atm_exit_trade_history').select('trade_id').eq('trade_id', pos.id).maybeSingle();
      if (!existingDbTrade) {
        await supabase.from('atm_exit_trade_history').insert([{
          trade_id: pos.id, underlying, expiry: pos.expiry, type: pos.type, buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          sell_qty: pos.sellQty, strike_diff: pos.strikeDiff, entry_time: pos.entryTime.toISOString(), entry_buy_price: pos.entryBuyPrice,
          entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice, margin: pos.margin, exit_time: tradeRecord.exitTime.toISOString(),
          exit_buy_price: liveExitBuy, exit_sell_price: liveExitSell, exit_spot_price: spotPrice, realized_gross_pnl: grossPnl, realized_net_pnl: grossPnl - totalFees,
          exit_fee: exitFee, total_fees: totalFees, exit_reason: 'Manual Exit'
        }]);
      }
      setPositions(prev => prev.filter(p => p.id !== pos.id));
      setTradeHistory(th => [tradeRecord, ...th]);
    } catch (e) {}
  };

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const totalUnrealizedPnl = positions.filter(p => p.underlying === underlying).reduce((s, p) => s + ((includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) || 0), 0);
  const uniqueTradeHistory = React.useMemo(() => {
    const seenIds = new Set();
    return tradeHistory.filter(t => {
      const id = t.id || t.trade_id;
      if (!id) return true;
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
  }, [tradeHistory]);

  const filteredTradeHistory = React.useMemo(() => {
    if (!historyFilterDate) return uniqueTradeHistory;
    return uniqueTradeHistory.filter(t => {
      if (!t.exitTime) return false;
      const d = new Date(t.exitTime);
      if (isNaN(d.getTime())) return false; // Prevent Invalid Date crash
      d.setUTCHours(d.getUTCHours() + 12);
      const exitUtcDate = d.toISOString().split('T')[0];
      return exitUtcDate === historyFilterDate;
    });
  }, [uniqueTradeHistory, historyFilterDate]);

  const todayRealizedPnl = React.useMemo(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    const todayUtc = d.toISOString().split('T')[0];
    return uniqueTradeHistory.reduce((s, t) => {
      if (!t.exitTime) return s;
      const dTrade = new Date(t.exitTime);
      if (isNaN(dTrade.getTime())) return s; // Prevent Invalid Date crash
      dTrade.setUTCHours(dTrade.getUTCHours() + 12);
      if (dTrade.toISOString().split('T')[0] === todayUtc) {
        return s + ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0);
      }
      return s;
    }, 0);
  }, [uniqueTradeHistory, includeFees]);

  const totalRealizedPnl = uniqueTradeHistory.reduce((s, t) => s + ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0), 0);
  const todayPnl = todayRealizedPnl + totalUnrealizedPnl;
  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;
  const wins = uniqueTradeHistory.filter(t => (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)) > 0).length;
  const winRate = uniqueTradeHistory.length > 0 ? ((wins / uniqueTradeHistory.length) * 100).toFixed(1) : '—';
  const totalMargin = positions.filter(p => p.underlying === underlying).reduce((s, p) => s + (p.margin || 0), 0);
  const calculatedAnalyticsData = React.useMemo(() => {
    const buckets = {
      'atm_exit_qty_0_2_5': [],
      'atm_exit_qty_2_5_5': [],
      'atm_exit_qty_5_7_5': [],
      'atm_exit_qty_7_5_10': [],
    };

    const groups = {};

    uniqueTradeHistory.forEach(t => {
      if (t.underlying !== underlying) return;

      const qty = t.sellQty || 0;
      let bucketName = 'atm_exit_qty_7_5_10';
      if (qty <= 2.5) bucketName = 'atm_exit_qty_0_2_5';
      else if (qty <= 5) bucketName = 'atm_exit_qty_2_5_5';
      else if (qty <= 7.5) bucketName = 'atm_exit_qty_5_7_5';

      const strikeDiff = Math.round((t.strikeDiff || 0) / 100) * 100;
      const key = `${bucketName}_${t.type}_${strikeDiff}`;

      if (!groups[key]) {
        groups[key] = {
          bucketName,
          type: t.type,
          strike_diff: strikeDiff,
          trades: []
        };
      }
      groups[key].trades.push(t);
    });

    Object.values(groups).forEach(g => {
      const n = g.trades.length;
      const sumMargin = g.trades.reduce((sum, t) => sum + (t.margin || 0), 0);
      const sumFees = g.trades.reduce((sum, t) => sum + (t.totalFees || 0), 0);
      const sumPnl = g.trades.reduce((sum, t) => sum + (t.realizedNetPnl || 0), 0);
      
      const sumNetPremium = g.trades.reduce((sum, t) => {
        const netPrem = (t.entryBuyPrice || 0) - (t.sellQty || 0) * (t.entrySellPrice || 0);
        return sum + netPrem;
      }, 0);

      buckets[g.bucketName].push({
        type: g.type,
        strike_diff: g.strike_diff,
        trade_count: n,
        avg_margin: sumMargin / n,
        avg_fees: sumFees / n,
        avg_pnl: sumPnl / n,
        avg_net_premium: sumNetPremium / n
      });
    });

    Object.keys(buckets).forEach(b => {
      buckets[b].sort((a, b) => a.strike_diff - b.strike_diff);
    });

    return buckets;
  }, [uniqueTradeHistory, underlying]);

  const getAnalyticsValue = (val, isTotal, count) => {
    if (!isTotal) return Number(val || 0).toFixed(2);
    return Number((val || 0) * (count || 1)).toFixed(2);
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
          <button className="nav-tab" onClick={() => onNavigate('charts')}>
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
          <button className="nav-tab" onClick={() => onNavigate('scanner')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> Ratio Spread
          </button>
          <button className="nav-tab" onClick={() => onNavigate('trading')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> Paper Trading
          </button>
          <button className="nav-tab active">
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </span> ATM Exit
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
              <input type="number" value={config.minStrikeDiff ?? ''} onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min IV Diff (%):</label>
              <input type="number" value={config.minIvDiff ?? ''} onChange={e => updateConfig('minIvDiff', Number(e.target.value))} style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Ratio Dev:</label>
              <input type="number" step="0.01" value={config.maxRatioDeviation ?? ''} onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Sell Prem ($):</label>
              <input type="number" value={config.minSellPremium ?? ''} onChange={e => updateConfig('minSellPremium', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>

            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Debit ($):</label>
              <input type="number" value={config.maxNetPremium ?? ''} onChange={e => updateConfig('maxNetPremium', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Min Long Dist:</label>
              <input type="number" value={config.minLongDist ?? ''} onChange={e => updateConfig('minLongDist', Number(e.target.value))} style={{ width: 60, padding: '4px 8px', fontSize: '13px' }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Max Ratio (1:X):</label>
              <input type="number" step="0.25" value={config.maxSellQty ?? ''} onChange={e => updateConfig('maxSellQty', Number(e.target.value))} style={{ width: 65, padding: '4px 8px', fontSize: '13px' }} />
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
        </div>

        {/* ── KPI Dashboard ───────────────────────────── */}
        <div className="pt-kpi-strip">
          <div className={`pt-kpi-card ${todayPnl >= 0 ? 'accent-green' : 'accent-red'}`}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              Today's P&L
            </span>
            <span className={`pt-kpi-value ${todayPnl > 0 ? 'positive' : todayPnl < 0 ? 'negative' : 'neutral'}`}>
              {todayPnl > 0 ? '+' : ''}{todayPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Realized: {todayRealizedPnl.toFixed(2)} | Unrl: {totalUnrealizedPnl.toFixed(2)}</span>
          </div>

          <div className={`pt-kpi-card ${totalPnl >= 0 ? 'accent-blue' : 'accent-red'}`} style={{ borderLeft: '4px solid var(--accent)' }}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              All-Time P&L
            </span>
            <span className={`pt-kpi-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral'}`}>
              {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Total Realized: {totalRealizedPnl.toFixed(2)}</span>
          </div>

          <div className="pt-kpi-card accent-gold">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 12l3 3 5-5" /></svg>
              Win Rate
            </span>
            <span className="pt-kpi-value neutral">{winRate}{winRate !== '—' ? '%' : ''}</span>
            <span className="pt-kpi-sub">{wins}W / {uniqueTradeHistory.length - wins}L of {uniqueTradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.filter(p => p.underlying === underlying).length}</span>
            <span className="pt-kpi-sub">{positions.filter(p => p.type === 'call' && p.underlying === underlying).length} calls / {positions.filter(p => p.type === 'put' && p.underlying === underlying).length} puts</span>
          </div>

          <div className="pt-kpi-card accent-purple">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
              Trades
            </span>
            <span className="pt-kpi-value neutral">{uniqueTradeHistory.length}</span>
            <span className="pt-kpi-sub">Closed positions</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
              Margin Used
            </span>
            <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
            <span className="pt-kpi-sub">Across {positions.filter(p => p.underlying === underlying).length} position{positions.filter(p => p.underlying === underlying).length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className={`pt-section ${trading ? 'live' : ''}`}>
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions ({underlying})
                <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8, fontVariantNumeric: 'tabular-nums', minWidth: '160px' }}>
                    Updated: {lastEvaluated > 0 ? new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastEvaluated)) : '---'}
                  </div>

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
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ fontSize: 14, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', minWidth: '140px' }}>
                      Spot Price: {spotPrice || '---'}
                    </div>
                    <button
                      onClick={async () => {
                        await refreshAllTickers();
                        evaluateStrategy(true);
                      }}
                      disabled={!trading}
                      title="Refresh now"
                      style={{
                        padding: '4px 8px', fontSize: 12, background: 'var(--bg-card)',
                        border: '1px solid var(--border)', color: 'var(--text)',
                        borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                        minWidth: '60px', justifyContent: 'center', fontVariantNumeric: 'tabular-nums'
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {trading && timeRemaining !== null && timeRemaining <= 60 ? `${timeRemaining}s` : ''}
                    </button>

                    <div className="pt-live-badge">
                      <div className="pt-live-dot" />
                      Monitoring
                    </div>
                  </div>
                )}
              </div>
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
                <span className="pt-empty-desc">{trading ? 'The engine is analyzing live option chains for ATM exit entries.' : 'Select expiry and click Start Trading to begin automated scanning.'}</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type / Ratio</th>
                    <th>Expiry</th>
                    <th>Buy / Sell Strike</th>
                    <th>Entry Spot</th>
                    <th>In (Buy / Sell)</th>
                    <th>Current (Buy / Sell)</th>
                    <th>Unrl P&L</th>
                    <th>Margin</th>
                    <th>Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.filter(p => p.underlying === underlying).map(p => {
                      const pnlValue = includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl || 0;
                      const pnlClass = (pnlValue || 0) > 0 ? 'positive' : (pnlValue || 0) < 0 ? 'negative' : 'zero';
                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {p.buyLeg.lotSize.toFixed(2)}:{p.sellQty.toFixed(2)}
                              </span>
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
                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>
                              {p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}
                            </span>
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
                          <td>
                            <span className={`pt-pnl ${pnlClass}`}>
                              {pnlValue > 0 ? '+' : ''}
                              {pnlValue.toFixed(2)}
                            </span>
                          </td>
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
            <div className="pt-section-header" style={{
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: '16px',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)'
            }}>
              {/* Row 1: Title and Centered Filter */}
              <div style={{ display: 'flex', alignItems: 'center', width: '100%', position: 'relative', minHeight: '36px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: '32px', height: '32px', borderRadius: '8px',
                    background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)'
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Trade History</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
                  </div>
                  <span style={{
                    background: 'var(--bg3)',
                    color: 'var(--accent)',
                    padding: '2px 10px',
                    borderRadius: '20px',
                    fontSize: '11px',
                    fontWeight: 700,
                    border: '1px solid rgba(240, 185, 11, 0.2)'
                  }}>
                    {filteredTradeHistory.length}
                  </span>
                </div>

                {/* Centered Filter Bar */}
                <div style={{
                  position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                  display: 'flex', alignItems: 'center', gap: '4px',
                  background: 'var(--bg3)', padding: '4px 8px', borderRadius: '12px',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                }}>
                  <button
                    onClick={() => adjustFilterDay(-1)}
                    title="Previous Day"
                    style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px', transition: 'all 0.2s' }}
                    className="nav-btn-hover"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px' }}>
                    <input
                      type="date"
                      value={historyFilterDate}
                      onChange={(e) => setHistoryFilterDate(e.target.value)}
                      style={{
                        background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '125px', outline: 'none', cursor: 'pointer'
                      }}
                    />
                  </div>

                  <button
                    onClick={() => adjustFilterDay(1)}
                    title="Next Day"
                    style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px', transition: 'all 0.2s' }}
                    className="nav-btn-hover"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </button>

                  <button
                    onClick={resetToToday}
                    style={{
                      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px',
                      padding: '4px 12px', fontSize: '11px', color: 'var(--text)', fontWeight: 700,
                      cursor: 'pointer', transition: 'all 0.2s', marginLeft: '4px'
                    }}
                    className="today-btn-hover"
                  >
                    TODAY
                  </button>
                </div>
              </div>
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
                <table className="pt-table">
                  <thead><tr>
                    <th>Entry Time</th>
                    <th>Exit Time</th>
                    <th>Duration</th>
                    <th>Expiry</th>
                    <th>Type / Ratio</th>
                    <th>Buy / Sell Strike</th>
                    <th>Spot (In / Out)</th>
                    <th>In (Buy / Sell)</th>
                    <th>Out (Buy / Sell)</th>
                    <th>Realized P&L</th>
                    <th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {filteredTradeHistory.map((t, i) => {
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
                              <span className={`pt-type-badge ${t.type}`}>
                                {t.type.toUpperCase()}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {t.buyLeg.lotSize.toFixed(2)}:{t.sellQty.toFixed(2)}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{t.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                              <span style={{ color: 'var(--text-dim)' }}>{t.entrySpotPrice ? t.entrySpotPrice.toLocaleString() : '—'}</span>
                              <span style={{ color: 'var(--text-dim)', opacity: 0.8 }}>{t.exitSpotPrice ? t.exitSpotPrice.toLocaleString() : '—'}</span>
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
                                {pnlValue > 0 ? '+' : ''}
                                {pnlValue.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${t.margin?.toFixed(0)}</span>
                            </div>
                          </td>
                          <td><span className={`pt-exit-badge position`}>{t.exitReason}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Analytics Panel ────────────────────────── */}
          <div className="pt-section">
            <div className="pt-section-header" style={{ borderBottom: '1px solid var(--border)', padding: '16px 20px', background: 'var(--bg2)' }}>
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></svg>
                Analytics Engine
              </div>
              <div className="pt-fee-toggle-container">
                <span className={`pt-fee-toggle-label ${!showTotalMode ? 'active' : ''}`} onClick={() => setShowTotalMode(false)}>Average</span>
                <label className="pt-switch">
                  <input type="checkbox" checked={showTotalMode} onChange={() => setShowTotalMode(!showTotalMode)} />
                  <span className="pt-slider"></span>
                </label>
                <span className={`pt-fee-toggle-label ${showTotalMode ? 'active' : ''}`} onClick={() => setShowTotalMode(true)}>Total</span>
              </div>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px', padding: '20px' }}>
              {Object.entries({
                'atm_exit_qty_0_2_5': '<= 2.5',
                'atm_exit_qty_2_5_5': '2.5 to 5',
                'atm_exit_qty_5_7_5': '5 to 7.5',
                'atm_exit_qty_7_5_10': '7.5 to 10',
              }).map(([tableName, label]) => (
                <div key={tableName} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ background: 'var(--bg3)', padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                    Sell Qty: {label}
                  </div>
                  <div className="pt-table-scroll" style={{ maxHeight: '400px' }}>
                    <table className="pt-table">
                      <thead>
                        <tr>
                          <th>Strike Diff</th>
                          <th>Trades</th>
                          <th>Avg Margin</th>
                          <th>{showTotalMode ? 'Total' : 'Avg'} Prem</th>
                          <th>{showTotalMode ? 'Total' : 'Avg'} Fees</th>
                          <th>{showTotalMode ? 'Total' : 'Avg'} PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(calculatedAnalyticsData[tableName] || []).map(row => {
                           const np = row.avg_net_premium || 0;
                           const isCredit = np < 0;
                           const pnlModeValue = getAnalyticsValue(row.avg_pnl, showTotalMode, row.trade_count);
                           const feesModeValue = getAnalyticsValue(row.avg_fees, showTotalMode, row.trade_count);
                           const npModeValue = getAnalyticsValue(Math.abs(np), showTotalMode, row.trade_count);
                           return (
                             <tr key={`${row.type}-${row.strike_diff}`}>
                               <td><span className={`pt-type-badge ${row.type}`} style={{ padding: '2px 6px', fontSize: '9px' }}>{row.type.toUpperCase()}</span> {row.strike_diff}</td>
                               <td style={{ fontWeight: 600 }}>{row.trade_count}</td>
                               <td>${Number(row.avg_margin || 0).toFixed(0)}</td>
                               <td><span className={`pt-pnl ${isCredit ? 'positive' : 'negative'}`}>${npModeValue} {isCredit ? 'Credit' : 'Debit'}</span></td>
                               <td style={{ color: '#f85149' }}>${feesModeValue}</td>
                               <td><span className={`pt-pnl ${Number(pnlModeValue) >= 0 ? 'positive' : 'negative'}`}>${pnlModeValue}</span></td>
                             </tr>
                           );
                        })}
                        {!(calculatedAnalyticsData[tableName]?.length) && (
                          <tr><td colSpan="6" style={{textAlign: 'center', padding: '20px', color: 'var(--text-dim)'}}>No data available</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

