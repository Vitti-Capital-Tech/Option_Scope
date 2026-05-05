import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';
import { getClaudeReview, getGroqReview } from './aiService';

const UNDERLYINGS = ['BTC', 'ETH'];

const calculateFee = (price, spot, qty, lotSize) => {
  if (!price || !spot) return 0;
  const feePerUnit = Math.min(0.035 * price, 0.0001 * spot);
  return feePerUnit * qty * lotSize;
};

export default function PaperTrading({ onNavigate, theme, toggleTheme }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [spotPrice, setSpotPrice] = useState(null);
  const [trading, setTrading] = useState(true);

  const [includeFees, setIncludeFees] = useState(false);

  const [positions, setPositions] = useState([]); // Active positions
  const [tradeHistory, setTradeHistory] = useState([]); // Closed trades
  const [aiReviews, setAiReviews] = useState({}); // { tradeId: { claude: string, groq: string } }
  const [selectedTradeId, setSelectedTradeId] = useState(null); // For AI review modal

  const fetchTopTradesMemory = async () => {
    try {
      const { data } = await supabase
        .from('trade_history')
        .select('*')
        .gt('realized_net_pnl', 0)
        .order('realized_net_pnl', { ascending: false })
        .limit(3);
      return data || [];
    } catch (e) {
      return [];
    }
  };

  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const [expectedTickerCount, setExpectedTickerCount] = useState(0);

  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const cooldownRef = useRef({});
  const lastEvaluatedRef = useRef(0);

  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);

  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('vitti_algo_config');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { }
    }
    return {
      minStrikeDiff: 800,
      minIvDiff: 3,
      maxRatioDeviation: 0.35,
      minSellPremium: 8,
      maxNetPremium: 25,
    };
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

  // ── Supabase History Fetch ──────────────────────────
  useEffect(() => {
    const fetchHistory = async () => {
      const { data, error } = await supabase
        .from('trade_history')
        .select('*')
        .order('exit_time', { ascending: false });

      if (error) {
        console.error('Error fetching trade history:', error);
      } else if (data) {
        // Map snake_case from DB to camelCase used in app
        const mapped = data.map(t => {
          return {
            ...t,
            id: t.trade_id,
            buyLeg: JSON.parse(t.buy_leg),
            sellLeg: JSON.parse(t.sell_leg),
            entryTime: new Date(t.entry_time),
            exitTime: new Date(t.exit_time),
            entryBuyPrice: t.entry_buy_price,
            entrySellPrice: t.entry_sell_price,
            exitBuyPrice: t.exit_buy_price,
            exitSellPrice: t.exit_sell_price,
            realizedGrossPnl: t.realized_gross_pnl,
            realizedNetPnl: t.realized_net_pnl,
            exitFee: t.exit_fee,
            totalFees: t.total_fees,
            exitReason: t.exit_reason,
            sellQty: t.sell_qty,
            strikeDiff: t.strike_diff,
            underlying: t.underlying,
            realizedGrossPnl: t.realized_gross_pnl,
            realizedNetPnl: t.realized_net_pnl,
            claudeReview: t.claude_review,
            groqReview: t.groq_review
          };
        });
        
        // Populate aiReviews state from fetched history
        const initialReviews = {};
        mapped.forEach(t => {
          if (t.claudeReview || t.groqReview) {
            initialReviews[t.id] = { claude: t.claudeReview, groq: t.groqReview };
          }
        });
        setAiReviews(initialReviews);
        setTradeHistory(mapped);
      }
    };
    fetchHistory();
  }, []);


  const runManualAiReview = async (tradeId) => {
    const trade = tradeHistory.find(t => t.id === tradeId) || positions.find(t => t.id === tradeId);
    if (!trade) return;

    // Set a placeholder to show loading
    setAiReviews(prev => ({
      ...prev,
      [tradeId]: { claude: null, groq: null }
    }));

    try {
      const memory = await fetchTopTradesMemory();
      const [claude, groq] = await Promise.all([
        getClaudeReview(trade, trade.exitTime ? 'EXIT' : 'ENTRY', memory),
        getGroqReview(trade, trade.exitTime ? 'EXIT' : 'ENTRY', memory)
      ]);
      setAiReviews(prev => ({
        ...prev,
        [tradeId]: { claude, groq }
      }));

      // Update Supabase with the new review
      await supabase
        .from('trade_history')
        .update({
          claude_review: claude,
          groq_review: groq
        })
        .eq('trade_id', tradeId);

    } catch (e) {
      console.error('Manual AI Error:', e);
    }
  };

  const clearHistory = () => {
    if (window.confirm("Are you sure you want to clear the local trade history? This will allow the algo to re-enter previous strike pairs.")) {
      setTradeHistory([]);
      setAiReviews({});
    }
  };

  useEffect(() => {
    if (selectedTradeId && (!aiReviews[selectedTradeId] || (!aiReviews[selectedTradeId].claude && !aiReviews[selectedTradeId].groq))) {
      runManualAiReview(selectedTradeId);
    }
  }, [selectedTradeId]);

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
    // Removed setPositions([]) and setTradeHistory([]) to keep history across expiry switches
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

        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTickerBuffer, 200);
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

  // Paper Trading Engine
  useEffect(() => {
    if (!trading || !spotPrice) return;

    const allTickers = Object.values(tickerData);
    if (allTickers.length === 0) return; // Wait for at least one ticker

    const nowTime = Date.now();
    const shouldEvaluateAlgo = nowTime - lastEvaluatedRef.current > 60000;

    if (!shouldEvaluateAlgo) {
      // Just update PnL for existing positions based on latest tickerData
      setPositions(prev => {
        // If prev is empty, we don't need to do anything
        if (prev.length === 0) return prev;

        return prev.map(pos => {
          const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice || pos.buyLeg.markPrice;
          const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice || pos.sellLeg.markPrice;

          const buyPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
          const sellPnl = (latestSell - pos.entrySellPrice) * pos.sellLeg.lotSize * pos.sellQty;
          const grossPnl = buyPnl - sellPnl + (pos.accumulatedSellPnl || 0);

          const exitBuyFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize);
          const exitSellFee = calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
          const exitFee = exitBuyFee + exitSellFee;
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
      });
      return;
    }

    lastEvaluatedRef.current = nowTime;
    setLastEvaluated(nowTime);

    let atmStrike = null;
    let minDiff = Infinity;
    for (const t of allTickers) {
      const diff = Math.abs(t.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = t.strike;
      }
    }

    // Pre-calculate force exits (ITM/ATM) so their cooldowns take effect BEFORE scanTickers runs.
    // This ensures scanTickers will immediately find valid replacements to maintain 6 positions.
    const forceExits = new Map();
    const now = Date.now();
    for (const pos of positionsRef.current) {
      let reason = '';
      const isCall = pos.type === 'call';
      const buyStrike = pos.buyLeg.strike;

      if (pos.strikeDiff < 1000) {
        if (isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike) reason = 'Buy Strike reached ATM/ITM (<1000 diff)';
      } else if (pos.strikeDiff < 1200) {
        if ((isCall ? spotPrice - buyStrike : buyStrike - spotPrice) >= 200) reason = '200 points ITM (<1200 diff)';
      } else if (pos.strikeDiff < 1400) {
        if ((isCall ? spotPrice - buyStrike : buyStrike - spotPrice) >= 300) reason = '300 points ITM (<1400 diff)';
      }

      if (reason) {
        forceExits.set(pos.id, reason);
        cooldownRef.current[pos.buyLeg.symbol] = now + 60000;
        cooldownRef.current[pos.sellLeg.symbol] = now + 60000;
      }
    }

    const scanTickers = (tickers) => {
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

          if ((cooldownRef.current[buyLeg.symbol] && cooldownRef.current[buyLeg.symbol] > Date.now()) ||
            (cooldownRef.current[sellLeg.symbol] && cooldownRef.current[sellLeg.symbol] > Date.now())) continue;

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
          const netPrem = buyLeg.markPrice - sellQty * sellLeg.markPrice;

          if (config.maxNetPremium < 0) {
            if (netPrem < 0 && netPrem < config.maxNetPremium) continue;
          } else {
            if (netPrem > 0 && netPrem > config.maxNetPremium) continue;
          }

          validPairs.push({ buyLeg, sellLeg, strikeDiff, sellQty, netPremium: netPrem });
        }
      }
      validPairs.sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        if (distA !== distB) return distA - distB;
        return a.netPremium - b.netPremium;
      });
      // Pick top 3 with UNIQUE buy AND sell strikes
      const unique = [];
      const seenBuyStrikes = new Set();
      const seenSellStrikes = new Set();
      for (const pair of validPairs) {
        if (seenBuyStrikes.has(pair.buyLeg.strike) || seenSellStrikes.has(pair.sellLeg.strike)) continue;
        seenBuyStrikes.add(pair.buyLeg.strike);
        seenSellStrikes.add(pair.sellLeg.strike);
        unique.push(pair);
        if (unique.length >= 3) break;
      }
      return unique;
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
      const usedBuySymbols = new Set();
      const usedSellSymbols = new Set();

      for (const pos of prev) {
        let shouldExit = false;
        let exitReason = '';
        let isUpdated = false;
        let updatedSpread = null;

        // Get latest prices for PnL calculation even if exiting
        const latestBuy = tickerData[pos.buyLeg.symbol]?.markPrice || pos.buyLeg.markPrice;
        const latestSell = tickerData[pos.sellLeg.symbol]?.markPrice || pos.sellLeg.markPrice;
        const buyPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
        const sellPnl = (latestSell - pos.entrySellPrice) * pos.sellLeg.lotSize * pos.sellQty;
        const grossPnl = buyPnl - sellPnl + (pos.accumulatedSellPnl || 0);
        const exitBuyFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize);
        const exitSellFee = calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const exitFee = exitBuyFee + exitSellFee;
        const totalFees = (pos.entryFee || 0) + exitFee;

        if (forceExits.has(pos.id)) {
          shouldExit = true;
          exitReason = forceExits.get(pos.id);
        } else {
          const matchingSpread = topSpreads.find(s => s.buyLeg.symbol === pos.buyLeg.symbol);
          
          if (matchingSpread) {
            // BUY STRIKE IS THE SAME -> Update sell leg if it changed
            if (matchingSpread.sellLeg.symbol !== pos.sellLeg.symbol) {
              isUpdated = true;
              updatedSpread = matchingSpread;
            } else {
              // Stay as is
            }
          } else {
            // BUY STRIKE CHANGED -> Exit
            shouldExit = true;
            exitReason = 'Buy Strike lost Top 3 position';
          }
        }

        if (shouldExit) {
          exited.push({
            ...pos,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            realizedGrossPnl: grossPnl,
            realizedNetPnl: grossPnl - totalFees,
            exitFee,
            totalFees,
            exitReason
          });
        } else if (isUpdated) {
          // Check for strike duplicates before updating
          if (usedBuySymbols.has(updatedSpread.buyLeg.symbol) || usedSellSymbols.has(updatedSpread.sellLeg.symbol)) {
            exited.push({ ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell, realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, exitFee, totalFees, exitReason: 'Strike Conflict on Update' });
          } else {
            const oldLegRealizedPnl = -sellPnl; 
            const newAccumulated = (pos.accumulatedSellPnl || 0) + oldLegRealizedPnl;
            const newSellEntry = updatedSpread.sellLeg.markPrice;
            const newSellFee = calculateFee(newSellEntry, spotPrice, updatedSpread.sellQty, updatedSpread.sellLeg.lotSize);
            const newEntryFee = (pos.entryFee || 0) + exitSellFee + newSellFee;
            // Update ID
            const newId = `${updatedSpread.buyLeg.symbol}_${updatedSpread.sellLeg.symbol}`;
            remaining.push({
              ...pos,
              id: newId,
              sellLeg: updatedSpread.sellLeg,
              sellQty: updatedSpread.sellQty,
              entrySellPrice: newSellEntry,
              accumulatedSellPnl: newAccumulated,
              entryFee: newEntryFee,
              currentBuyPrice: latestBuy,
              currentSellPrice: newSellEntry,
              unrealizedGrossPnl: buyPnl + newAccumulated,
              unrealizedNetPnl: (buyPnl + newAccumulated) - (newEntryFee + exitBuyFee + calculateFee(newSellEntry, spotPrice, updatedSpread.sellQty, updatedSpread.sellLeg.lotSize)),
              strikeDiff: updatedSpread.strikeDiff,
              netPremium: updatedSpread.netPremium
            });
            usedBuySymbols.add(updatedSpread.buyLeg.symbol);
            usedSellSymbols.add(updatedSpread.sellLeg.symbol);
          }
        } else {
          // Regular stay
          if (usedBuySymbols.has(pos.buyLeg.symbol) || usedSellSymbols.has(pos.sellLeg.symbol)) {
            exited.push({ ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell, realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, exitFee, totalFees, exitReason: 'Strike Conflict' });
          } else {
            remaining.push({
              ...pos,
              currentBuyPrice: latestBuy,
              currentSellPrice: latestSell,
              unrealizedGrossPnl: grossPnl,
              unrealizedNetPnl: grossPnl - totalFees,
              currentExitFee: exitFee,
              currentTotalFees: totalFees
            });
            usedBuySymbols.add(pos.buyLeg.symbol);
            usedSellSymbols.add(pos.sellLeg.symbol);
          }
        }
      }

      // Record exited trades
      if (exited.length > 0) {
        setTradeHistory(th => [...exited, ...th]);

        // Trigger AI Reviews and Persist to Supabase
        exited.forEach(async (t) => {
          try {
            const memory = await fetchTopTradesMemory();
            const [claude, groq] = await Promise.all([
              getClaudeReview(t, 'EXIT', memory),
              getGroqReview(t, 'EXIT', memory)
            ]);
            
            setAiReviews(prev => ({
              ...prev,
              [t.id]: { claude, groq }
            }));

            // Persist to Supabase with Reviews
            const { error } = await supabase
              .from('trade_history')
              .insert([{
                trade_id: t.id,
                underlying: underlying,
                expiry: selExpiry,
                type: t.type,
                buy_leg: JSON.stringify(t.buyLeg),
                sell_leg: JSON.stringify(t.sellLeg),
                sell_qty: t.sellQty,
                strike_diff: t.strikeDiff,
                entry_time: t.entryTime.toISOString(),
                exit_time: t.exitTime.toISOString(),
                entry_buy_price: t.entryBuyPrice,
                entry_sell_price: t.entrySellPrice,
                exit_buy_price: t.exitBuyPrice,
                exit_sell_price: t.exitSellPrice,
                realized_gross_pnl: t.realizedGrossPnl,
                realized_net_pnl: t.realizedNetPnl,
                exit_fee: t.exitFee,
                total_fees: t.totalFees,
                margin: t.margin,
                exit_reason: t.exitReason,
                claude_review: claude,
                groq_review: groq
              }]);
            if (error) console.error('Error saving trade to Supabase:', error);
          } catch (err) {
            console.error('Error in AI/Supabase exit logic:', err);
          }
        });
      }

      // Open new positions from top 3 that are not active
      for (const spread of topSpreads) {
        // Double check cooldowns here because an exit in the block above might have just triggered one!
        if ((cooldownRef.current[spread.buyLeg.symbol] && cooldownRef.current[spread.buyLeg.symbol] > Date.now()) ||
          (cooldownRef.current[spread.sellLeg.symbol] && cooldownRef.current[spread.sellLeg.symbol] > Date.now())) {
          continue;
        }

        const id = `${spread.buyLeg.symbol}_${spread.sellLeg.symbol}`;
        
        // Skip if this specific pair is already in Trade History (Client Rule)
        const inHistory = tradeHistory.some(h => h.id === id);
        if (inHistory) {
          console.log(`Algo: Skipping ${id} - Already in Trade History.`);
          continue;
        }

        const exists = remaining.find(p => p.id === id);
        const buyCovered = usedBuySymbols.has(spread.buyLeg.symbol);
        const sellCovered = usedSellSymbols.has(spread.sellLeg.symbol);

        if (!exists && !buyCovered && !sellCovered) {
          usedBuySymbols.add(spread.buyLeg.symbol);
          usedSellSymbols.add(spread.sellLeg.symbol);
          // Margin: 100% for long (1x), 200x leverage for short leg (Value / 200)
          const longMargin = spread.buyLeg.markPrice * spread.buyLeg.lotSize * 1;
          const shortMargin = (spread.sellLeg.markPrice * spread.sellLeg.lotSize * spread.sellQty) / 200;
          const margin = longMargin + shortMargin;

          const entryBuyFee = calculateFee(spread.buyLeg.markPrice, spotPrice, 1, spread.buyLeg.lotSize);
          const entrySellFee = calculateFee(spread.sellLeg.markPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
          const entryFee = entryBuyFee + entrySellFee;

          const newPos = {
            id,
            underlying: underlying,
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
            unrealizedGrossPnl: 0,
            unrealizedNetPnl: -entryFee,
            entryFee,
            currentExitFee: entryFee,
            currentTotalFees: entryFee * 2,
            margin
          };
          remaining.push(newPos);

          // Trigger AI Reviews for Entries
          (async () => {
            try {
              const memory = await fetchTopTradesMemory();
              const [claude, groq] = await Promise.all([
                getClaudeReview(newPos, 'ENTRY', memory),
                getGroqReview(newPos, 'ENTRY', memory)
              ]);
              setAiReviews(prev => ({
                ...prev,
                [id]: { claude, groq }
              }));
            } catch (e) {
              console.error('AI Review Entry Error:', e);
            }
          })();
        }
      }

      return remaining;
    });

  }, [tickerData, trading, spotPrice, config, expectedTickerCount]);

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
      const elapsed = Date.now() - lastEvaluated;
      const left = Math.ceil((60000 - elapsed) / 1000);
      setTimeRemaining(left > 0 ? left : 0);
    }, 1000);

    const elapsed = Date.now() - lastEvaluated;
    const left = Math.ceil((60000 - elapsed) / 1000);
    setTimeRemaining(left > 0 ? left : 0);

    return () => clearInterval(timer);
  }, [lastEvaluated, trading]);

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
    const headers = ['Entry Time', 'Exit Time', 'Type', 'Buy Strike', 'Sell Strike', 'Sell Qty', 'Entry Net Premium', 'Exit Net Premium', 'Gross PnL', 'Total Fees', 'Net PnL', 'Margin', 'Exit Reason'];
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
        (t.realizedGrossPnl || t.realizedPnl || 0).toFixed(2),
        (t.totalFees || 0).toFixed(2),
        (t.realizedNetPnl || t.realizedPnl || 0).toFixed(2),
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
  const totalUnrealizedPnl = positions.reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || p.unrealizedPnl || 0)), 0);
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
            <span className="pt-kpi-value neutral">{positions.length}</span>
            <span className="pt-kpi-sub">{positions.filter(p => p.type === 'call').length} calls / {positions.filter(p => p.type === 'put').length} puts</span>
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
            <span className="pt-kpi-sub">Across {positions.length} position{positions.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className={`pt-section ${trading ? 'live' : ''}`}>
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions
                <span className="pt-section-count">{positions.length}</span>
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
                  <div className="pt-live-badge" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {timeRemaining !== null && timeRemaining <= 60 ? `${timeRemaining}s` : ''}
                  </div>
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
                    <th>Type</th><th>Buy Strike</th><th>Sell Strike</th><th>Sell Qty</th>
                    <th>Entry Net</th><th>Current Net</th><th>Unrl P&L</th>
                    <th>Margin</th><th>AI</th><th>Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.map(p => {
                      const entryNet = p.entryBuyPrice - (p.sellQty * p.entrySellPrice);
                      const currentNet = p.currentBuyPrice - (p.sellQty * p.currentSellPrice);
                      const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || p.unrealizedPnl || 0);
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td><span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span></td>
                          <td className="pt-strike pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</td>
                          <td className="pt-strike pt-strike-sell">{p.sellLeg.strike.toLocaleString()}</td>
                          <td>{p.sellQty}x</td>
                          <td>{entryNet.toFixed(2)}</td>
                          <td>{currentNet.toFixed(2)}</td>
                          <td><span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span></td>
                          <td>
                            <div className="pt-margin-cell">
                              <span>${p.margin.toFixed(0)}</span>
                              <div className="pt-margin-bar"><div className="pt-margin-fill" style={{ width: `${Math.min(100, (p.margin / (totalMargin || 1)) * 100)}%` }} /></div>
                            </div>
                          </td>
                          <td>
                            <button className="pt-ai-btn" onClick={() => setSelectedTradeId(p.id)} title="View AI Analysis">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                            </button>
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
                  <button className="pt-export-btn" onClick={clearHistory} style={{ color: 'var(--red)', borderColor: 'rgba(235, 77, 75, 0.3)', background: 'rgba(235, 77, 75, 0.1)' }}>
                    Clear History
                  </button>
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
                    <th>Exit Time</th><th>Type</th><th>Buy / Sell Strike</th>
                    <th>Realized P&L</th><th>Margin</th><th>AI</th><th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {tradeHistory.map((t, i) => {
                      const pnlValue = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || t.realizedPnl || 0);
                      return (
                        <tr key={i}>
                          <td style={{ color: 'var(--text-dim)' }}>{formatTime(t.exitTime)}</td>
                          <td><span className={`pt-type-badge ${t.type}`}>{t.type.toUpperCase()}</span></td>
                          <td>
                            <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                            <span className="pt-strike-separator"> / </span>
                            <span className="pt-strike-sell">{t.sellLeg.strike.toLocaleString()}</span>
                          </td>
                          <td><span className={`pt-pnl ${pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero'}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span></td>
                          <td>${t.margin.toFixed(0)}</td>
                          <td>
                            <button className="pt-ai-btn" onClick={() => setSelectedTradeId(t.id)} title="View AI Analysis">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                            </button>
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
        {/* ── AI Review Modal ───────────────────────── */}
        {selectedTradeId && (
          <div className="pt-modal-overlay" onClick={() => setSelectedTradeId(null)}>
            <div className="pt-modal" onClick={e => e.stopPropagation()}>
              <div className="pt-modal-header">
                <h3>Trade AI Analysis</h3>
                <button className="pt-modal-close" onClick={() => setSelectedTradeId(null)}>&times;</button>
              </div>
              <div className="pt-modal-body">
                {(!aiReviews[selectedTradeId] || (!aiReviews[selectedTradeId].claude && !aiReviews[selectedTradeId].groq)) ? (
                  <div className="ai-loading">
                    <div className="ai-spinner"></div>
                    <p>AI models are analyzing the trade context...</p>
                  </div>
                ) : (
                  <div className="ai-review-grid">
                    <div className="ai-review-box">
                      <div className="ai-header claude">
                        <img src="https://anthropic.com/favicon.ico" alt="Claude" />
                        Claude 3.5 Sonnet
                      </div>
                      <div className="ai-content">
                        {aiReviews[selectedTradeId]?.claude || "Analysis pending..."}
                      </div>
                    </div>
                    <div className="ai-review-box">
                      <div className="ai-header groq">
                        <img src="https://groq.com/favicon.ico" alt="Groq" />
                        Llama 3.3 (70B)
                      </div>
                      <div className="ai-content">
                        {aiReviews[selectedTradeId]?.groq || "Analysis pending..."}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
