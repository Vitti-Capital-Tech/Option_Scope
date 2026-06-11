import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];
const HEARTBEAT_ONLINE_THRESHOLD = 60000;
const HEARTBEAT_STALE_THRESHOLD = 120000;

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
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [engineStatus, setEngineStatus] = useState({ status: 'offline', lastHeartbeat: null, data: null });

  const [includeFees, setIncludeFees] = useState(true);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);

  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });
  const [extraCreditMode, setExtraCreditMode] = useState(false);
  const [extraCreditAmountCall, setExtraCreditAmountCall] = useState(15);
  const [extraCreditAmountPut, setExtraCreditAmountPut] = useState(10);
  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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


  // ── Ticker data (read-only, for live PnL display) ─────────────────────
  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastDbWriteRef = useRef(0);
  const latestSpotPriceRef = useRef(null);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData({ ...latestTickerDataRef.current });
  }, []);

  // ── Product + expiry (UI display only, server manages its own copy) ───
  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (isConfigLoaded && exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        updateConfig('expiry', exps[0]);
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry, isConfigLoaded]);

  // Validate expiry when config and products are loaded
  useEffect(() => {
    if (isConfigLoaded && products.length > 0) {
      const exps = getExpiries(products);
      if (exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        updateConfig('expiry', exps[0]);
      }
    }
  }, [isConfigLoaded, products, selExpiry]);

  useEffect(() => {
    setExpiries([]);
    setTickerData({});
    refreshProducts();
  }, [underlying]);

  useEffect(() => {
    const interval = setInterval(refreshProducts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshProducts]);

  // ── Config ────────────────────────────────────────────────────────────
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
      tabBroadcast('CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  const fetchSupabaseConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('paper_trading_config').select('*').eq('id', 'global').single();
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
          maxSellQty: data.max_sell_qty || 10,
        });
        setIsConfigLoaded(true);
      }
    } catch (e) { }
  }, []);

  // ── Supabase reads ────────────────────────────────────────────────────
  const fetchSupabaseActivePositions = useCallback(async () => {
    try {
      if (Date.now() - lastDbWriteRef.current < 3000) return;
      const { data, error } = await supabase
        .from('active_positions')
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
              sellQty: p.sell_qty, strikeDiff: p.strike_diff,
              entryTime: new Date(p.entry_time),
              entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
              entrySpotPrice: p.entry_spot_price,
              stagesExited: p.stages_exited || 0,
              margin: p.margin || 0, entryFee: p.entry_fee || 0,
              accumulatedSellPnl: p.accumulated_sell_pnl || 0,
              // Preserve live display data from current state
              currentBuyPrice: existing?.currentBuyPrice ?? null,
              currentSellPrice: existing?.currentSellPrice ?? null,
              currentBuyIv: existing?.currentBuyIv ?? null,
              currentSellIv: existing?.currentSellIv ?? null,
              entryBuyIv: buyLeg?.entryIv || null,
              entrySellIv: sellLeg?.entryIv || null,
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
  }, []);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('trade_history')
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
          margin: t.margin,
          realizedGrossPnl: t.realized_gross_pnl, realizedNetPnl: t.realized_net_pnl,
          exitFee: t.exit_fee, totalFees: t.total_fees,
          entryFee: (t.total_fees || 0) - (t.exit_fee || 0),
          exitReason: t.exit_reason,
          entryBuyIv: safeParseLeg(t.buy_leg)?.entryIv || null,
          entrySellIv: safeParseLeg(t.sell_leg)?.entryIv || null,
          exitBuyIv: safeParseLeg(t.buy_leg)?.exitIv || null,
          exitSellIv: safeParseLeg(t.sell_leg)?.exitIv || null,
          _isPartial: t.is_partial || false,
          _exitedBuyQty: t.lot_size ?? safeParseLeg(t.buy_leg)?.lotSize ?? 1,
        }));
        setTradeHistory(mapped);
      }
    } catch (e) { }
  }, [underlying]);

  // ── Initial data load + Realtime subscription ─────────────────────────
  useEffect(() => {
    fetchSupabaseActivePositions();
    fetchSupabaseTradeHistory();
    fetchSupabaseConfig();

    const realtimeChannel = supabase
      .channel('active_positions_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'active_positions' },
        () => { fetchSupabaseActivePositions(); }
      )
      .subscribe();

    const historyChannel = supabase
      .channel('trade_history_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_history' },
        () => { fetchSupabaseTradeHistory(); }
      )
      .subscribe();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchSupabaseActivePositions();
        fetchSupabaseTradeHistory();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      supabase.removeChannel(realtimeChannel);
      supabase.removeChannel(historyChannel);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig]);

  // ── Engine heartbeat ──────────────────────────────────────────────────
  const fetchHeartbeat = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('engine_heartbeat')
        .select('*')
        .eq('id', 'paper_trading')
        .single();

      if (error || !data) {
        setEngineStatus({ status: 'offline', lastHeartbeat: null, data: null });
        return;
      }

      const age = Date.now() - new Date(data.last_heartbeat).getTime();
      const status = age < HEARTBEAT_ONLINE_THRESHOLD ? 'online'
        : age < HEARTBEAT_STALE_THRESHOLD ? 'stale' : 'offline';

      setEngineStatus({ status, lastHeartbeat: new Date(data.last_heartbeat), data: data.payload });

      // Use server's last evaluation time for the UI timestamp
      if (data.last_heartbeat) {
        setLastEvaluated(new Date(data.last_heartbeat).getTime());
      }
    } catch (e) { }
  }, []);

  useEffect(() => {
    let interval = null;
    const start = () => {
      fetchHeartbeat();
      interval = setInterval(fetchHeartbeat, 30000);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
    };

    if (document.visibilityState === 'visible') {
      start();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchHeartbeat]);

  // ── Spot price (for PnL display math) ────────────────────────────────
  useEffect(() => {
    let interval = null;
    const fetchSpot = () => {
      getSpotPrice(underlying)
        .then(sp => {
          if (sp) {
            latestSpotPriceRef.current = sp;
            setSpotPrice(sp);
          }
        })
        .catch(() => { });
    };

    const start = () => {
      fetchSpot();
      interval = setInterval(fetchSpot, 10000);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
    };

    if (document.visibilityState === 'visible') {
      start();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [underlying]);

  // Throttle spot price state updates to UI to exactly once per second
  useEffect(() => {
    const interval = setInterval(() => {
      if (latestSpotPriceRef.current !== null) {
        setSpotPrice(latestSpotPriceRef.current);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── WebSocket (read-only: feeds Phase 1 PnL display only) ────────────
  const positionsSymbolsKey = React.useMemo(() => {
    return positions
      .filter(p => p.underlying === underlying)
      .map(p => `${p.buyLeg?.symbol}_${p.sellLeg?.symbol}`)
      .sort()
      .join(',');
  }, [positions, underlying]);

  const getSymbolMeta = useCallback(() => {
    if (!selExpiry || !products.length) return {};
    const strikes = getStrikes(products, selExpiry);
    const meta = {};
    for (const strike of strikes) {
      const callProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'call')
      );
      if (callProd) {
        const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
        meta[callProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'call', symbol: callProd.symbol };
      }
      const putProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'put')
      );
      if (putProd) {
        const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
        meta[putProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'put', symbol: putProd.symbol };
      }
    }
    // Also subscribe to symbols from open positions (tracks P&L across expiries)
    positions.forEach(pos => {
      if (pos.underlying === underlying) {
        if (pos.buyLeg && !meta[pos.buyLeg.symbol]) {
          meta[pos.buyLeg.symbol] = { strike: pos.buyLeg.strike, lotSize: pos.buyLeg.lotSize, type: pos.type, symbol: pos.buyLeg.symbol };
        }
        if (pos.sellLeg && !meta[pos.sellLeg.symbol]) {
          meta[pos.sellLeg.symbol] = { strike: pos.sellLeg.strike, lotSize: pos.sellLeg.lotSize, type: pos.type, symbol: pos.sellLeg.symbol };
        }
      }
    });
    return meta;
  }, [selExpiry, products, underlying, positionsSymbolsKey]);

  useEffect(() => {
    if (!selExpiry || !products.length) return;

    const symbolMeta = getSymbolMeta();
    const perpSymbol = `${underlying}USD`;
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.includes(perpSymbol)) {
      allSymbols.push(perpSymbol);
    }
    if (allSymbols.length < 2) return;

    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) { }
      wsRef.current = null;
    }
    tickerBufferRef.current = {};
    latestTickerDataRef.current = {};
    setTickerData({});

    wsRef.current = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        if (sym === perpSymbol) {
          const sp = toFiniteNumber(msg.spot_price ?? msg.mark_price ?? msg.close ?? msg.last_price);
          if (sp && !isNaN(sp)) {
            latestSpotPriceRef.current = sp;
          }
          return;
        }
        const meta = symbolMeta[sym];
        if (!meta) return;

        const markPrice = toFiniteNumber(msg.mark_price);
        const lastPrice = toFiniteNumber(msg.last_price ?? msg.close);
        const bid = toFiniteNumber(msg.quotes?.best_bid);
        const ask = toFiniteNumber(msg.quotes?.best_ask);
        const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.bid_iv));
        const askIv = normalizeIv(toFiniteNumber(msg.quotes?.ask_iv));
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;

        const prev = tickerBufferRef.current[sym] ?? latestTickerDataRef.current[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
          markPrice: markPrice ?? prev?.markPrice ?? null,
          lastPrice: lastPrice ?? prev?.lastPrice ?? null,
          bid: bid ?? prev?.bid ?? null,
          ask: ask ?? prev?.ask ?? null,
          bidIv: bidIv ?? prev?.bidIv ?? null,
          askIv: askIv ?? prev?.askIv ?? null,
          iv: iv ?? prev?.iv ?? null,
          delta: delta !== null ? delta : prev?.delta,
          deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prev?.deltaNotional,
        };

        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
        }
      },
      () => { }
    );

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    };
  }, [selExpiry, products, underlying, getSymbolMeta, flushTickerBuffer]);

  // ── Phase 1: Real-time PnL display (read-only, no writes) ────────────
  useEffect(() => {
    const interval = setInterval(() => {
      if (!spotPrice || positions.length === 0) return;
      const live = latestTickerDataRef.current;

      setPositions(prev => {
        if (prev.length === 0) return prev;
        return prev.map(pos => {
          const tickerBuy = live[pos.buyLeg?.symbol];
          const tickerSell = live[pos.sellLeg?.symbol];
          const latestBuy = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
          const latestSell = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice ?? pos.currentSellPrice;

          // If we don't have any price at all for both legs, skip this position's updates
          if (latestBuy == null && latestSell == null) return pos;

          const hasBothPrices = latestBuy != null && latestSell != null;
          const buyPnl = hasBothPrices ? ((latestBuy - pos.entryBuyPrice) || 0) : 0; // Sell - Buy
          const sellPnl = hasBothPrices ? (((pos.entrySellPrice - latestSell) * pos.sellQty) || 0) : 0; // Sell - Buy
          const grossPnl = hasBothPrices
            ? (buyPnl * pos.buyLeg.lotSize) + (sellPnl * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0)
            : pos.unrealizedGrossPnl;
          const exitFee = hasBothPrices
            ? calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize)
            : pos.currentExitFee;
          const totalFees = hasBothPrices ? ((pos.entryFee || 0) + exitFee) : pos.currentTotalFees;

          return {
            ...pos,
            currentBuyPrice: latestBuy,
            currentSellPrice: latestSell,
            currentBuyIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? pos.currentBuyIv ?? null,
            currentSellIv: tickerSell?.askIv ?? tickerSell?.iv ?? pos.currentSellIv ?? null,
            unrealizedGrossPnl: grossPnl,
            unrealizedNetPnl: grossPnl - totalFees,
            currentExitFee: exitFee,
            currentTotalFees: totalFees,
          };
        });
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [spotPrice, positions.length, underlying, positionsSymbolsKey]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (wsRef.current) wsRef.current.close();
    if (spotIntervalRef.current) clearInterval(spotIntervalRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  // ── Cross-tab sync (config only) ──────────────────────────────────────
  const { broadcast: tabBroadcast } = useTabListener({
    CONFIG_SYNC: (payload) => {
      if (payload.config) {
        const updates = {};
        if (payload.config.underlying !== undefined) updates.underlying = payload.config.underlying;
        if (payload.config.expiry !== undefined) updates.expiry = payload.config.expiry;
        if (Object.keys(updates).length > 0) {
          setConfig(prev => ({ ...prev, ...updates }));
        }
      }
    }
  });

  // ── Export CSV ────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!filteredTradeHistory.length) {
      alert('No closed trades found for the selected filter.');
      return;
    }
    const headers = [
      'Entry Time', 'Exit Time', 'Expiry', 'Type', 'Ratio', 'Original Ratio',
      'Buy Strike', 'Sell Strike', 'Entry Buy Price', 'Entry Sell Price',
      'Exit Buy Price', 'Exit Sell Price', 'Entry Spot', 'Exit Spot',
      'Entry ATM Ratio', 'Entry ATM Buy Price', 'Entry ATM Sell Price',
      'Exit ATM Ratio', 'Exit ATM Buy Price', 'Exit ATM Sell Price',
      'Gross PnL', 'Total Fees', 'Net PnL', 'Margin', 'Exit Reason'
    ];
    const rows = filteredTradeHistory.map(t => {
      let sellQty = t.sellQty;
      let grossPnl = t.realizedGrossPnl || 0;
      let netPnl = t.realizedNetPnl || 0;
      if (extraCreditMode && t.entrySellPrice > 0) {
        const extraCredit = t.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
        const extraQty = Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25;
        const extraPnl = extraQty * (t.entrySellPrice - (t.exitSellPrice || t.entrySellPrice));
        sellQty += extraQty;
        grossPnl += extraPnl;
        netPnl += extraPnl;
      }
      let margin = t.margin || 0;
      if (extraCreditMode && t.entrySellPrice > 0) {
        const buyPrice = t.entryBuyPrice || 0;
        const buyLot = t.buyLeg?.lotSize || 1;
        const sellLot = t.sellLeg?.lotSize || 1;
        const spot = t.entrySpotPrice || 0;
        const longMargin = buyPrice * buyLot;
        const shortValue = Math.min(200000, spot * sellQty * sellLot);
        const leverage = 200;
        margin = longMargin + (shortValue / leverage);
      }
      return [
        formatDateTime(t.entryTime), formatDateTime(t.exitTime), fmtExpiry(t.expiry),
        t.type.toUpperCase(), `${t.buyLeg.lotSize.toFixed(2)}:${sellQty.toFixed(2)}`,
        `${(t.buyLeg?.originalLotSize || t.buyLeg.lotSize).toFixed(2)}:${(t.buyLeg?.originalSellQty || sellQty).toFixed(2)}`,
        t.buyLeg.strike, t.sellLeg.strike,
        t.entryBuyPrice || '', t.entrySellPrice || '',
        t.exitBuyPrice || '', t.exitSellPrice || '',
        t.entrySpotPrice || '', t.exitSpotPrice || '',
        t.buyLeg?.entryAtmRatio != null ? t.buyLeg.entryAtmRatio.toFixed(2) : '',
        t.buyLeg?.entryBuyAtmPrice != null ? t.buyLeg.entryBuyAtmPrice.toFixed(2) : '',
        t.buyLeg?.entrySellAtmPrice != null ? t.buyLeg.entrySellAtmPrice.toFixed(2) : '',
        t.buyLeg?.exitAtmRatio != null ? t.buyLeg.exitAtmRatio.toFixed(2) : '',
        t.buyLeg?.exitBuyAtmPrice != null ? t.buyLeg.exitBuyAtmPrice.toFixed(2) : '',
        t.buyLeg?.exitSellAtmPrice != null ? t.buyLeg.exitSellAtmPrice.toFixed(2) : '',
        grossPnl.toFixed(2), (t.totalFees || 0).toFixed(2), netPnl.toFixed(2),
        margin.toFixed(2), t.exitReason || ''
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paper_trades_${historyFilterDate || 'all_time'}_${Date.now()}.csv`;
    a.click();
  };

  // ── KPI / display helpers ─────────────────────────────────────────────
  const filteredTradeHistory = React.useMemo(() => {
    if (!historyFilterDate) return tradeHistory;
    return tradeHistory.filter(t => {
      if (!t.exitTime) return false;
      const d = new Date(t.exitTime);
      if (isNaN(d.getTime())) return false;
      d.setUTCHours(d.getUTCHours() + 12);
      return d.toISOString().split('T')[0] === historyFilterDate;
    });
  }, [tradeHistory, historyFilterDate]);

  const totalUnrealizedPnl = positions
    .filter(p => p.underlying === underlying)
    .reduce((s, p) => {
      let val = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
      if (extraCreditMode && p.entrySellPrice > 0) {
        const extraCredit = p.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
        const extraQty = Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25;
        val += extraQty * (p.entrySellPrice - (p.currentSellPrice || p.currentSellPrice));
      }
      return s + val;
    }, 0);

  const totalRealizedPnl = tradeHistory.reduce((s, t) => {
    let val = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
    if (extraCreditMode && t.entrySellPrice > 0) {
      const extraCredit = t.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
      const extraQty = Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25;
      val += extraQty * (t.entrySellPrice - (t.exitSellPrice || t.entrySellPrice));
    }
    return s + val;
  }, 0);

  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;

  const todayRealizedPnl = React.useMemo(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    const todayUtc = d.toISOString().split('T')[0];
    return tradeHistory.reduce((s, t) => {
      if (!t.exitTime) return s;
      const dTrade = new Date(t.exitTime);
      if (isNaN(dTrade.getTime())) return s;
      dTrade.setUTCHours(dTrade.getUTCHours() + 12);
      if (dTrade.toISOString().split('T')[0] !== todayUtc) return s;
      let val = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
      if (extraCreditMode && t.entrySellPrice > 0) {
        const extraCredit = t.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
        const extraQty = Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25;
        val += extraQty * (t.entrySellPrice - (t.exitSellPrice || t.entrySellPrice));
      }
      return s + val;
    }, 0);
  }, [tradeHistory, includeFees, extraCreditMode, extraCreditAmountCall, extraCreditAmountPut]);

  const todayPnl = todayRealizedPnl + totalUnrealizedPnl;
  const wins = tradeHistory.filter(t =>
    (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)) > 0
  ).length;
  const winRate = tradeHistory.length > 0
    ? ((wins / tradeHistory.length) * 100).toFixed(1) : '—';
  const calculatePositionMargin = useCallback((p, isExtraMode = false) => {
    const buyPrice = p.currentBuyPrice != null ? p.currentBuyPrice : (p.entryBuyPrice || 0);
    const buyLot = p.buyLeg?.lotSize || 1;
    const sellLot = p.sellLeg?.lotSize || 1;
    const spot = spotPrice || p.entrySpotPrice || 0;
    let sellQty = p.sellQty;
    if (isExtraMode && p.entrySellPrice > 0) {
      const extraCredit = p.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
      sellQty += Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25;
    }
    const longMargin = buyPrice * buyLot;
    const shortValue = Math.min(200000, spot * sellQty * sellLot);
    const leverage = 200;
    return longMargin + (shortValue / leverage);
  }, [spotPrice, extraCreditAmountCall, extraCreditAmountPut]);

  const totalMargin = React.useMemo(() => {
    return positions
      .filter(p => p.underlying === underlying)
      .reduce((s, p) => s + calculatePositionMargin(p, extraCreditMode), 0);
  }, [positions, underlying, extraCreditMode, calculatePositionMargin]);
  const filteredRealizedPnl = filteredTradeHistory.reduce((s, t) =>
    s + (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)), 0);
  const filteredWins = filteredTradeHistory.filter(t =>
    (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)) > 0
  ).length;

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const exitBadgeClass = (reason) => {
    if (reason?.includes('Manual')) return 'manual';
    if (reason?.includes('Top 3')) return 'position';
    if (reason?.includes('ITM')) return 'itm';
    if (reason?.includes('ATM')) return 'atm';
    if (reason?.includes('Expiry')) return 'expiry';
    return 'position';
  };

  const renderRatio = (t) => {
    const r = t.exitReason || '';
    let mult = 1;
    if (r.includes('50%')) mult = 2;
    else if (r.includes('33%') || r.includes('34%')) mult = 3;

    const sellQty = t.sellQty || 0;
    const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;

    let uncappedSellQty = t.buyLeg?.originalSellQty !== undefined
      ? t.buyLeg.originalSellQty
      : sellQty / origLot;

    const originalSell = Math.round((uncappedSellQty * mult) * 4) / 4;
    let simSell = originalSell;
    if (extraCreditMode && t.entrySellPrice > 0) {
      const extraCredit = t.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
      const extraLots = extraCredit / t.entrySellPrice;
      simSell += ((Math.round(extraLots / 0.25) * 0.25) / origLot) * mult;
    }
    simSell = Math.round(simSell * 4) / 4;
    return `1:${simSell.toFixed(2)}`;
  };

  // ── Engine status badge helper ────────────────────────────────────────
  const engineStatusLabel = engineStatus.status === 'online' ? 'Engine Live'
    : engineStatus.status === 'stale' ? 'Engine Stale'
      : 'Engine Offline';
  const engineStatusColor = engineStatus.status === 'online' ? '#0ecb81'
    : engineStatus.status === 'stale' ? '#f0b90b'
      : '#f85149';

  // ── Render ────────────────────────────────────────────────────────────
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
            </span> <span className="nav-tab-text">Charts</span>
          </button>
          <button className="nav-tab" onClick={() => onNavigate('scanner')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> <span className="nav-tab-text">Ratio Spread</span>
          </button>
          <button className="nav-tab active">
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> <span className="nav-tab-text">Paper Trading</span>
          </button>
          <button className="nav-tab" onClick={() => onNavigate('atm-exit')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </span> <span className="nav-tab-text">ATM Exit</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
          {/* Engine status — replaces the old Start/Stop trading button */}
          <div className="ws-badge">
            <div className="ws-dot" style={{ background: engineStatusColor }} />
            <span>{engineStatusLabel}</span>
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
              <select value={underlying} onChange={e => updateConfig('underlying', e.target.value)}
                style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => updateConfig('expiry', e.target.value)}
                disabled={!expiries.length}
                style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
                {!expiries.length
                  ? <option>Loading...</option>
                  : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
              </select>
            </div>
            <button
              className="pt-filters-toggle-btn"
              onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
            >
              {isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}
            </button>
          </div>

          <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

          <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
            <span className="pt-control-label">Filters</span>
            {[
              { label: 'Min Strike Diff ($):', key: 'minStrikeDiff', width: 60 },
              { label: 'Min IV Diff (%):', key: 'minIvDiff', width: 50 },
              { label: 'Max Ratio Dev:', key: 'maxRatioDeviation', width: 60, step: '0.01' },
              { label: 'Min Sell Prem ($):', key: 'minSellPremium', width: 60 },
              { label: 'Max Debit ($):', key: 'maxNetPremium', width: 60 },
              { label: 'Min Long Dist:', key: 'minLongDist', width: 60 },
              { label: 'Max Ratio (1:X):', key: 'maxSellQty', width: 65, step: '0.25' },
            ].map(({ label, key, width, step }) => (
              <div key={key} className="form-group">
                <label style={{ marginBottom: 0 }}>{label}</label>
                <input type="number" step={step} value={config[key] ?? ''}
                  onChange={e => updateConfig(key, Number(e.target.value))}
                  style={{ width, padding: '4px 8px', fontSize: '13px' }} />
              </div>
            ))}
          </div>
        </div>
        <div className='flex justify-between mt-3! px-10!'>
          {spotPrice && (
            <div className="pt-spot-display">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
            </div>
          )}

          <div className="pt-status-badge live ml-10">
            <span className="pt-pulse"></span>
            LIVE ALGO
          </div>
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
            <span className="pt-kpi-sub">{wins}W / {tradeHistory.length - wins}L of {tradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.filter(p => p.underlying === underlying).length}</span>
            <span className="pt-kpi-sub">
              {positions.filter(p => p.type === 'call' && p.underlying === underlying).length} calls /&nbsp;
              {positions.filter(p => p.type === 'put' && p.underlying === underlying).length} puts
            </span>
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
            <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
            <span className="pt-kpi-sub">
              Across {positions.filter(p => p.underlying === underlying).length} position
              {positions.filter(p => p.underlying === underlying).length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className="pt-section live">
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions ({underlying})
                <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
              </div>

              <div className="pt-section-controls">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {lastEvaluated > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
                      Updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastEvaluated))}
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      fetchSupabaseActivePositions();
                      fetchSupabaseTradeHistory();
                      fetchHeartbeat();
                    }}
                    title="Refresh now"
                    style={{
                      padding: '4px 8px', fontSize: 12, background: 'var(--bg-card)',
                      border: '1px solid var(--border)', color: 'var(--text)',
                      borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      minWidth: '50px', justifyContent: 'center'
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" />
                    </svg>
                    {lastEvaluated > 0 ? `${Math.max(0, 30 - Math.round((now - lastEvaluated) / 1000))}s` : ''}
                  </button>
                </div>

                {/* Extra Credit Toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '1px solid var(--border)', paddingLeft: '12px' }}>
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

                <div className="pt-fee-toggle-container">
                  <span className={`pt-fee-toggle-label ${!includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(false)}>Gross</span>
                  <label className="pt-switch">
                    <input type="checkbox" checked={includeFees} onChange={e => setIncludeFees(e.target.checked)} />
                    <span className="pt-slider"></span>
                  </label>
                  <span className={`pt-fee-toggle-label ${includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(true)}>Net</span>
                </div>

                <div style={{ fontSize: 14, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  Spot: {spotPrice ? spotPrice.toLocaleString() : '---'}
                </div>

                <div className="pt-live-badge">
                  <div className="pt-live-dot" style={{ background: engineStatusColor }} />
                  {engineStatusLabel}
                </div>
              </div>
            </div>

            {positions.filter(p => p.underlying === underlying).length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon scanning">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={engineStatusColor} strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4">
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" />
                    </path>
                  </svg>
                </div>
                <span className="pt-empty-title">No Active Positions</span>
                <span className="pt-empty-desc">The server engine is scanning for entries. Positions appear here automatically when entered.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type / Ratio</th>
                    <th>Expiry</th>
                    <th>Buy / Sell Strike</th>
                    <th className="hide-mobile">Entry Spot</th>
                    <th>In (Buy / Sell)</th>
                    <th className="hide-mobile">IV In (B/S)</th>
                    <th>Cur (Buy / Sell)</th>
                    <th className="hide-mobile">IV Cur (B/S)</th>
                    <th>Unrl P&L</th>
                    <th className="hide-xs">Margin</th>
                    <th className="hide-mobile">Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.filter(p => p.underlying === underlying).map(p => {
                      const pnlBase = includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl;
                      const extraCredit = p.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
                      const extraAdj = extraCreditMode && p.entrySellPrice > 0
                        ? (Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25) * (p.entrySellPrice - (p.currentSellPrice || p.entrySellPrice))
                        : 0;
                      const pnlValue = (pnlBase || 0) + extraAdj;
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                      const displaySellQty = extraCreditMode && p.entrySellPrice > 0
                        ? p.sellQty + (Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25)
                        : p.sellQty;

                      const origLot = p.buyLeg?.originalLotSize || p.buyLeg?.lotSize || 1;
                      const rawOrigSellQty = p.buyLeg?.originalSellQty !== undefined
                        ? (extraCreditMode && p.entrySellPrice > 0
                          ? p.buyLeg.originalSellQty + (Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25) / (p.buyLeg.originalLotSize || 1)
                          : p.buyLeg.originalSellQty)
                        : (extraCreditMode && p.entrySellPrice > 0
                          ? (p.sellQty + (Math.round((extraCredit / p.entrySellPrice) / 0.25) * 0.25)) / origLot
                          : p.sellQty / origLot);
                      const displayOrigSellQty = Math.round(rawOrigSellQty * 4) / 4;

                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: extraCreditMode ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 600 }}>
                                {p.buyLeg.lotSize.toFixed(2)}:{displaySellQty.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                (Orig 1:{displayOrigSellQty.toFixed(2)})
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
                          <td className="hide-mobile"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>{p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{p.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                              <span>{p.entryBuyIv != null ? p.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{p.entrySellIv != null ? p.entrySellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
                              <span style={{ color: '#f85149' }}>{p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--accent)' }}>
                              <span>{p.currentBuyIv != null ? p.currentBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{p.currentSellIv != null ? p.currentSellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td><span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span></td>
                          <td className="hide-xs">
                            <div className="pt-margin-cell">
                              <span>${calculatePositionMargin(p, extraCreditMode).toFixed(0)}</span>
                              <div className="pt-margin-bar">
                                <div className="pt-margin-fill" style={{ width: `${Math.min(100, (calculatePositionMargin(p, extraCreditMode) / (totalMargin || 1)) * 100)}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="hide-mobile"><span className="pt-duration">{fmtDuration(new Date() - p.entryTime)}</span></td>
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
            <div className="pt-section-header pt-history-header" style={{
              flexDirection: 'column', alignItems: 'stretch', gap: '16px',
              padding: '16px 20px', borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)'
            }}>
              {/* Row 1: Title and Centered Filter */}
              <div className="pt-history-row-1">
                <div className="pt-history-title-area">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Trade History</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
                  </div>
                  <span style={{ background: 'var(--bg3)', color: 'var(--accent)', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, border: '1px solid rgba(240, 185, 11, 0.2)' }}>
                    {filteredTradeHistory.length}
                  </span>
                </div>

                {/* Centered Date Filter */}
                <div className="pt-history-date-filter">
                  <button onClick={() => adjustFilterDay(-1)} title="Previous Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px' }}>
                    <input type="date" value={historyFilterDate} onChange={(e) => setHistoryFilterDate(e.target.value)}
                      style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '125px', outline: 'none', cursor: 'pointer' }} />
                    <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, background: 'rgba(240, 185, 11, 0.1)', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                      12:00 UTC SESSION
                    </span>
                  </div>
                  <button onClick={() => adjustFilterDay(1)} title="Next Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </button>
                  <button onClick={resetToToday} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '4px 12px', fontSize: '11px', color: 'var(--text)', fontWeight: 700, cursor: 'pointer', marginLeft: '4px' }}>
                    TODAY
                  </button>
                  <button onClick={() => setHistoryFilterDate('')} title="Show All History"
                    style={{ background: historyFilterDate ? 'none' : 'rgba(240, 185, 11, 0.1)', border: 'none', color: historyFilterDate ? 'var(--text-dim)' : 'var(--accent)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px', marginLeft: '4px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
                  </button>
                </div>
              </div>

              {/* Row 2: Stats and Export */}
              {filteredTradeHistory.length > 0 && (
                <div className="pt-history-row-2">
                  <div className="pt-history-stats" style={{ gap: '20px' }}>
                    <div className="pt-history-stat">
                      <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Realized:</span>
                      <span className={`value ${filteredRealizedPnl >= 0 ? 'green' : 'red'}`} style={{ fontSize: '14px' }}>
                        {filteredRealizedPnl > 0 ? '+' : ''}{filteredRealizedPnl.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ width: '1px', height: '16px', background: 'var(--border)' }} />
                    <div className="pt-history-stat">
                      <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Win / Loss:</span>
                      <span style={{ fontSize: '14px', fontWeight: 700 }}>
                        <span className="value green">{filteredWins}</span>
                        <span style={{ margin: '0 4px', color: 'var(--text-dim)', fontWeight: 400 }}>/</span>
                        <span className="value red">{filteredTradeHistory.length - filteredWins}</span>
                      </span>
                    </div>
                  </div>
                  <button className="pt-export-btn" onClick={exportCSV}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', borderRadius: '8px', background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    Export CSV
                  </button>
                </div>
              )}
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
                    <th className="hide-mobile">Entry Time</th>
                    <th className="hide-mobile">Exit Time</th>
                    <th className="hide-mobile">Duration</th>
                    <th>Expiry</th>
                    <th>Type / Ratio</th>
                    <th>Buy / Sell Strike</th>
                    <th>Spot (In / Out)</th>
                    <th>In (Buy / Sell)</th>
                    <th className="hide-mobile">IV In (B/S)</th>
                    <th className="hide-mobile">Entry ATM Ratio (Prices)</th>
                    <th className="hide-mobile">Entry Fee</th>
                    <th className="hide-mobile">Exit Fee</th>
                    <th>Out (Buy / Sell)</th>
                    <th className="hide-mobile">IV Out (B/S)</th>
                    <th className="hide-mobile">Exit ATM Ratio (Prices)</th>
                    <th>Realized P&L</th>
                    <th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {filteredTradeHistory.map((t, i) => {
                      const pnlBase = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
                      const extraCredit = t.type === 'call' ? extraCreditAmountCall : extraCreditAmountPut;
                      const extraAdj = extraCreditMode && t.entrySellPrice > 0
                        ? (Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25) * (t.entrySellPrice - (t.exitSellPrice || t.entrySellPrice))
                        : 0;
                      const pnlValue = pnlBase + extraAdj;
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                      const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;
                      const displaySellQty = extraCreditMode && t.entrySellPrice > 0
                        ? t.sellQty + (Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25)
                        : t.sellQty;

                      const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;
                      const rawOrigSellQty = t.buyLeg?.originalSellQty !== undefined
                        ? (extraCreditMode && t.entrySellPrice > 0
                          ? t.buyLeg.originalSellQty + (Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25) / (t.buyLeg.originalLotSize || 1)
                          : t.buyLeg.originalSellQty)
                        : (extraCreditMode && t.entrySellPrice > 0
                          ? (t.sellQty + (Math.round((extraCredit / t.entrySellPrice) / 0.25) * 0.25)) / origLot
                          : t.sellQty / origLot);
                      const displayOrigSellQty = Math.round(rawOrigSellQty * 4) / 4;

                      return (
                        <tr key={i}>
                          <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.entryTime)}</td>
                          <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.exitTime)}</td>
                          <td className="hide-mobile"><span className="pt-duration" style={{ fontSize: '11px' }}>{fmtDuration(durationMs)}</span></td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(t.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${t.type}`}>
                                {t.type.toUpperCase()}
                                {t._isPartial && (
                                  <span style={{ fontSize: '9px', marginLeft: 4, opacity: 0.8 }}>
                                    ({t.exitReason?.match(/\d+%/)?.[0] || 'P'})
                                  </span>
                                )}
                              </span>
                              <span style={{ fontSize: '10px', color: extraCreditMode ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 600 }}>
                                {t.buyLeg.lotSize.toFixed(2)}:{displaySellQty.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                (Orig 1:{displayOrigSellQty.toFixed(2)})
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
                              <span style={{ fontSize: '10px', color: extraCreditMode ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 600, marginTop: 2 }}>
                                {renderRatio(t)}
                              </span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                              <span>{t.entryBuyIv != null ? t.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{t.entrySellIv != null ? t.entrySellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            {t.buyLeg?.entryAtmRatio != null ? (
                              <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                                <span style={{ fontWeight: 600 }}>{t.buyLeg.entryAtmRatio.toFixed(2)}</span>
                                <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                                  ({t.buyLeg.entryBuyAtmPrice != null ? t.buyLeg.entryBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.entrySellAtmPrice != null ? t.buyLeg.entrySellAtmPrice.toFixed(2) : '—'})
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                          <td className="hide-mobile">
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                              ${t.entryFee?.toFixed(2) || '0.00'}
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                              ${t.exitFee?.toFixed(2) || '0.00'}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.exitBuyPrice?.toFixed(2) || '—'}</span>
                              <span style={{ color: '#f85149' }}>{t.exitSellPrice?.toFixed(2) || '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text)' }}>
                              <span>{t.exitBuyIv != null ? t.exitBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{t.exitSellIv != null ? t.exitSellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            {t.buyLeg?.exitAtmRatio != null ? (
                              <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                                <span style={{ fontWeight: 600 }}>{t.buyLeg.exitAtmRatio.toFixed(2)}</span>
                                <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                                  ({t.buyLeg.exitBuyAtmPrice != null ? t.buyLeg.exitBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.exitSellAtmPrice != null ? t.buyLeg.exitSellAtmPrice.toFixed(2) : '—'})
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                              <span className={`pt-pnl ${pnlClass}`}>
                                {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${t.margin?.toFixed(0)}</span>
                            </div>
                          </td>
                          <td><span className={`pt-exit-badge ${exitBadgeClass(t.exitReason)}`}>{t.exitReason}</span></td>
                        </tr>
                      );
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