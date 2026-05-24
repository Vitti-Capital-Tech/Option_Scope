/**
 * Paper Trading Engine — Server-Side
 *
 * Headless Node.js version of PaperTrading.jsx's evaluateStrategy Phase 2.
 * Runs as a persistent process: connects to Delta Exchange WS, evaluates
 * strategy every minute, and writes all state to Supabase.
 *
 * Features preserved from browser version:
 * - Multi-stage partial exits (33%/50%/100%)
 * - Leg swap optimization
 * - Rotation with worst-first, 1-for-1 reservation
 * - 0.5% spot scaling + 400pt diversification guards
 * - DB-level count/strike guards
 * - Spot staleness guard
 * - Expiry settlement (2 min early)
 * - Product refresh every 5 minutes
 */
import { supabase } from './lib/supabase.js';
import { createHeartbeat } from './lib/heartbeat.js';
import {
  loadProducts, getExpiries, getSpotPrice,
  createTickerStream, buildSymbolMeta, processTickerMessage,
  backfillTickers
} from './lib/deltaApi.js';
import {
  safeParseLeg, calculateFee, calcMargin, scanTickers,
  pickTopUniqueStrikes, log, logWarn, logError
} from './lib/utils.js';

const ENGINE_ID = 'paper_trading';

export async function startPaperTradingEngine() {
  const heartbeat = createHeartbeat(ENGINE_ID);

  // ── Mutable engine state ──────────────────────────────────────────────
  let config = {
    underlying: 'BTC', expiry: '',
    minStrikeDiff: 800, minIvDiff: 5, maxRatioDeviation: 0.25,
    minSellPremium: 10, maxNetPremium: 20, minLongDist: 500, maxSellQty: 10,
  };
  let products = [];
  let expiries = [];
  let spotPrice = null;
  let lastSpotUpdate = 0;
  let positions = []; // Active positions (in-memory mirror of Supabase)
  let tickerData = {}; // Live ticker data from WS
  let wsHandle = null;
  let symbolMeta = {};
  let lastEvaluated = 0;
  let isEvaluating = false;
  let lastDbWrite = 0;

  // ── Supabase data fetchers ────────────────────────────────────────────

  async function fetchConfig() {
    try {
      const { data, error } = await supabase
        .from('paper_trading_config').select('*').eq('id', 'global').single();
      if (data && !error) {
        config = {
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10,
        };
        log(`Config loaded: ${config.underlying} | Expiry: ${config.expiry || 'auto'}`);
      }
    } catch (e) { logError('Config fetch error', e); }
  }

  async function fetchActivePositions() {
    try {
      if (Date.now() - lastDbWrite < 3000) return;
      const { data, error } = await supabase
        .from('active_positions').select('*')
        .order('entry_time', { ascending: true });

      if (error) { logError('Fetch positions error', error); return; }

      if (data && data.length > 0) {
        positions = data.map(p => {
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
          };
        }).filter(p => p.buyLeg && p.sellLeg);
      } else if (data) {
        positions = [];
      }
    } catch (e) { logError('Fetch positions exception', e); }
  }

  // ── Product + expiry management ───────────────────────────────────────

  async function refreshProducts() {
    try {
      const prods = await loadProducts(config.underlying);
      products = prods;
      expiries = getExpiries(prods);

      if (expiries.length && (!config.expiry || !expiries.includes(config.expiry))) {
        config.expiry = expiries[0];
        log(`Expiry auto-selected: ${config.expiry}`);
        // Persist the auto-selected expiry back to Supabase
        await supabase.from('paper_trading_config').upsert({
          id: 'global',
          expiry: config.expiry,
          updated_at: new Date().toISOString()
        });
      }
    } catch (e) { logError('Product refresh error', e); }
  }

  // ── Spot price polling ────────────────────────────────────────────────

  async function fetchSpot() {
    try {
      const sp = await getSpotPrice(config.underlying);
      if (sp) {
        spotPrice = sp;
        lastSpotUpdate = Date.now();
      }
    } catch (e) { /* ignore */ }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────

  function startWebSocket() {
    if (!config.expiry || !products.length) return;

    symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
    const allSymbols = Object.keys(symbolMeta);
    if (allSymbols.length < 2) {
      logWarn('Not enough symbols to subscribe — skipping WS start');
      return;
    }

    // Close existing WS if any
    if (wsHandle) {
      try { wsHandle.close(); } catch (e) { }
      wsHandle = null;
    }

    log(`Starting WS: ${allSymbols.length} symbols for ${config.underlying} / ${config.expiry}`);

    wsHandle = createTickerStream(
      allSymbols,
      (msg) => {
        const processed = processTickerMessage(msg, symbolMeta, tickerData);
        if (processed) {
          tickerData[processed.symbol] = processed;
        }
      },
      (status) => {
        const mappedWsStatus = status === 'live' ? 'live' : 'reconnecting';
        heartbeat.update({ ws_status: mappedWsStatus });
        if (status === 'live') {
          log('WebSocket connected');
        } else if (status === 'disconnected') {
          logWarn('WebSocket disconnected — auto-reconnecting in 3s...');
        }
      }
    );

    heartbeat.update({ ws_status: 'live' });
  }

  // ── Core strategy evaluation (Phase 2) ────────────────────────────────

  async function evaluateStrategy() {
    if (isEvaluating || !spotPrice) return;

    // Spot staleness guard
    const spotAge = Date.now() - lastSpotUpdate;
    if (lastSpotUpdate > 0 && spotAge > 30000) {
      logWarn(`Spot stale (${Math.round(spotAge / 1000)}s). Skipping evaluation.`);
      return;
    }

    isEvaluating = true;
    try {
      const allTickers = Object.values(tickerData);
      if (allTickers.length === 0) return;

      const underlying = config.underlying;
      const selExpiry = config.expiry;

      // Identify ATM strike
      let atmStrike = null;
      let minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      // A. Local Scan: top candidates per type
      const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));
      const localTopCalls = scanTickers(callTickers, config, spotPrice);
      const localTopPuts = scanTickers(putTickers, config, spotPrice);
      const topSpreads = [...localTopCalls, ...localTopPuts];

      // C. Unique-by-buy-strike version for ranking
      const uniqueTopSpreads = [
        ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'call'), 10),
        ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'put'), 10)
      ];

      // Count active positions
      const activeCallsCount = positions.filter(p => p.type === 'call' && p.underlying === underlying).length;
      const activePutsCount = positions.filter(p => p.type === 'put' && p.underlying === underlying).length;

      let callRotationsApproved = 0;
      let putRotationsApproved = 0;
      const MAX_ROTATIONS_PER_CYCLE = 3;

      const remaining = [];
      const exited = [];
      const reservedTargets = new Set();

      // Sort worst-first (farthest from ATM)
      const sortedPositions = [...positions].sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        return distB - distA;
      });

      // ── 1. Exit evaluation ──────────────────────────────────────────────
      for (const pos of sortedPositions) {
        if (pos.underlying !== underlying) {
          remaining.push(pos);
          continue;
        }

        // Data gap guard
        const tickerBuy = tickerData[pos.buyLeg.symbol];
        const tickerSell = tickerData[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice;

        if (liveExitBuy == null || liveExitSell == null) {
          remaining.push(pos);
          continue;
        }

        const latestBuy = liveExitBuy;
        const latestSell = liveExitSell;
        const latestBuyIv = tickerBuy?.bidIv ?? tickerBuy?.iv ?? null;
        const latestSellIv = tickerSell?.askIv ?? tickerSell?.iv ?? null;

        let shouldExit = false;
        let exitReason = '';
        let zombieExitTime = null;

        // Priority 2: Expiry settlement (2 min early)
        const expiryTs = new Date(pos.expiry).getTime();
        if (Date.now() >= expiryTs - 120000) {
          shouldExit = true;
          exitReason = 'Expiry Reached (2min Early)';
          if (Date.now() > expiryTs + 600000) {
            zombieExitTime = new Date(expiryTs).toISOString();
          }
        }

        // PnL calculations
        const buyPriceDiff = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
        const sellPriceDiff = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) : 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) - (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);
        const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) +
          calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        // Check top-3 ranking
        const inTop3 = uniqueTopSpreads.some(s =>
          s.buyLeg.type === pos.type && Number(s.buyLeg.strike) === Number(pos.buyLeg.strike)
        );

        // Priority 4: Rotation
        if (!shouldExit && pos.expiry === selExpiry && uniqueTopSpreads.length > 0 && !inTop3) {
          const otherActiveBuyStrikes = sortedPositions
            .filter(p => p.id !== pos.id && p.underlying === underlying && p.type === pos.type)
            .map(p => Number(p.buyLeg.strike));
          const otherActiveSellStrikes = sortedPositions
            .filter(p => p.id !== pos.id && p.underlying === underlying && p.type === pos.type)
            .map(p => Number(p.sellLeg.strike));

          const bestTarget = uniqueTopSpreads.filter(s => s.buyLeg.type === pos.type).find(s => {
            const bS = Number(s.buyLeg.strike);
            const sS = Number(s.sellLeg.strike);

            const buyConflict = otherActiveBuyStrikes.includes(bS);
            const sellConflict = otherActiveSellStrikes.includes(sS);
            if (buyConflict || sellConflict || reservedTargets.has(bS)) return false;

            const stepValid = Math.abs(bS - Number(pos.buyLeg.strike)) >= 400;
            const oldSpotBase = pos.entrySpotPrice || pos.entryBuyPrice || spotPrice;
            const oldThresh = Math.round((oldSpotBase * 0.005) / 100) * 100;
            const spotStepValid = pos.type === 'call'
              ? spotPrice <= oldSpotBase - oldThresh
              : spotPrice >= oldSpotBase + oldThresh;
            if (!stepValid || !spotStepValid) return false;

            const otherPositionsOfType = sortedPositions.filter(p =>
              p.id !== pos.id && p.underlying === underlying && p.type === pos.type
            );
            return otherPositionsOfType.every(p => {
              const thresh = Math.round((p.entrySpotPrice * 0.005) / 100) * 100;
              const spotValid = pos.type === 'call'
                ? spotPrice <= p.entrySpotPrice - thresh
                : spotPrice >= p.entrySpotPrice + thresh;
              const strikeValid = Math.abs(bS - Number(p.buyLeg.strike)) >= 400;
              return spotValid && strikeValid;
            });
          });

          if (bestTarget) {
            const targetStrike = Number(bestTarget.buyLeg.strike);
            const currentStrike = Number(pos.buyLeg.strike);
            const isPut = pos.type === 'put';
            if (isPut ? (targetStrike > currentStrike) : (targetStrike < currentStrike)) {
              const isSellStrikeMatch = Number(bestTarget.sellLeg.strike) === Number(pos.sellLeg.strike);
              if (isSellStrikeMatch) {
                pos._pendingLegSwap = bestTarget;
                shouldExit = true;
                exitReason = `Leg Swap: Buy ${currentStrike} -> ${targetStrike}`;
              } else {
                shouldExit = true;
                exitReason = `Lost Top 3 and Rank 1 better target available (${targetStrike})`;
              }
              reservedTargets.add(targetStrike);
            }
          }
        }

        // Priority 3: ATM/ITM multi-stage scale-out
        let isPartial = false;
        let exitFraction = 1.0;

        if (!shouldExit) {
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          const itmDist = isCall ? spotPrice - buyStrike : buyStrike - spotPrice;
          const isAtmMET = isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike;
          const sExited = pos.stagesExited || 0;

          if (pos.strikeDiff <= 1000) {
            if (isAtmMET) { shouldExit = true; exitReason = 'Full Exit @ ATM (<= 1000 diff)'; }
          } else if (pos.strikeDiff <= 1200) {
            if (sExited === 0 && isAtmMET) {
              isPartial = true; exitFraction = 0.5; exitReason = 'Partial Exit 50% @ ATM (<= 1200 diff)';
            } else if (sExited === 1 && itmDist >= 200) {
              shouldExit = true; exitReason = 'Final Exit 50% @ 200 ITM (<= 1200 diff)';
            }
          } else {
            if (sExited === 0 && isAtmMET) {
              isPartial = true; exitFraction = 0.33; exitReason = 'Partial Exit 33% @ ATM';
            } else if (sExited === 1 && itmDist >= 150) {
              isPartial = true; exitFraction = 0.5; exitReason = 'Partial Exit 33% @ 150 ITM';
            } else if (sExited === 2 && itmDist >= 300) {
              shouldExit = true; exitReason = 'Final Exit 34% @ 300 ITM';
            }
          }
        }

        // Threshold guard for rotations
        const canRotateThisType = pos.type === 'call'
          ? (activeCallsCount >= 3 && callRotationsApproved < MAX_ROTATIONS_PER_CYCLE)
          : (activePutsCount >= 3 && putRotationsApproved < MAX_ROTATIONS_PER_CYCLE);

        let rotationApproved = false;
        if (!canRotateThisType && exitReason.includes('Lost Top 3')) {
          if (shouldExit || isPartial) { shouldExit = false; isPartial = false; }
        } else if (canRotateThisType && exitReason.includes('Lost Top 3')) {
          if (shouldExit) {
            rotationApproved = true;
            if (pos.type === 'call') callRotationsApproved++; else putRotationsApproved++;
          }
        }

        if (shouldExit || isPartial) {
          // Final guard for unapproved rotation exits
          if (exitReason.includes('Lost Top 3') && !rotationApproved) {
            shouldExit = false; isPartial = false;
            remaining.push(pos);
            continue;
          }

          const partGrossPnl = grossPnl * exitFraction;
          const partEntryFee = (pos.entryFee || 0) * exitFraction;
          const partExitFee = exitFee * exitFraction;
          const partTotalFees = partEntryFee + partExitFee;
          const partNetPnl = partGrossPnl - partTotalFees;

          const tradeRecord = {
            ...pos,
            id: isPartial ? `${pos.id}-P${pos.stagesExited + 1}` : (pos._pendingLegSwap ? `${pos.id}-LS-${Date.now().toString(36).toUpperCase()}` : pos.id),
            sellQty: isPartial ? pos.sellQty * exitFraction : pos.sellQty,
            buyLeg: isPartial
              ? { ...pos.buyLeg, lotSize: pos.buyLeg.lotSize * exitFraction, exitIv: latestBuyIv }
              : { ...pos.buyLeg, exitIv: latestBuyIv },
            sellLeg: { ...pos.sellLeg, exitIv: latestSellIv },
            _exitedBuyQty: isPartial ? pos.buyLeg.lotSize * exitFraction : pos.buyLeg.lotSize,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            exitSpotPrice: spotPrice,
            realizedGrossPnl: partGrossPnl,
            realizedNetPnl: partNetPnl,
            entryFee: partEntryFee,
            exitFee: partExitFee,
            totalFees: partTotalFees,
            exitReason,
            _latestBuy: latestBuy,
            _latestSell: latestSell,
            _isPartial: isPartial,
            zombieExitTime,
          };
          exited.push(tradeRecord);

          if (isPartial) {
            // Keep the remaining fraction
            const remainingPos = {
              ...pos,
              sellQty: pos.sellQty * (1 - exitFraction),
              buyLeg: { ...pos.buyLeg, lotSize: pos.buyLeg.lotSize * (1 - exitFraction) },
              margin: calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, Math.max(pos.entrySpotPrice || spotPrice, spotPrice), pos.sellQty, pos.sellLeg.lotSize) * (1 - exitFraction),
              entryFee: (pos.entryFee || 0) * (1 - exitFraction),
              accumulatedSellPnl: (pos.accumulatedSellPnl || 0) * (1 - exitFraction),
              stagesExited: (pos.stagesExited || 0) + 1,
            };
            remaining.push(remainingPos);

            // Sync partial update to Supabase
            try {
              const { error } = await supabase.from('active_positions').update({
                sell_qty: remainingPos.sellQty,
                buy_leg: JSON.stringify(remainingPos.buyLeg),
                margin: remainingPos.margin,
                entry_fee: remainingPos.entryFee,
                stages_exited: remainingPos.stagesExited,
                accumulated_sell_pnl: remainingPos.accumulatedSellPnl,
              }).eq('id', pos.id);
              if (error) logError('Partial sync error:', error.message);
            } catch (e) { logError('Partial sync exception:', e); }
          } else if (pos._pendingLegSwap) {
            // Leg swap execution
            const target = pos._pendingLegSwap;
            const longPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
            const longExitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize);
            const longEntryFee = (pos.entryFee || 0) * (pos.buyLeg.lotSize / (pos.buyLeg.lotSize + (pos.sellQty * pos.sellLeg.lotSize)));

            const deltaQty = target.sellQty - pos.sellQty;
            let adjustedSellEntryPrice = pos.entrySellPrice;
            let shortAdjustmentFee = 0;
            let shortAdjustmentPnl = 0;

            if (deltaQty > 0) {
              adjustedSellEntryPrice = ((pos.sellQty * pos.entrySellPrice) + (deltaQty * latestSell)) / target.sellQty;
              shortAdjustmentFee = calculateFee(latestSell, spotPrice, Math.abs(deltaQty), pos.sellLeg.lotSize);
            } else if (deltaQty < 0) {
              shortAdjustmentFee = calculateFee(latestSell, spotPrice, Math.abs(deltaQty), pos.sellLeg.lotSize);
              shortAdjustmentPnl = (pos.entrySellPrice - latestSell) * Math.abs(deltaQty) * pos.sellLeg.lotSize;
            }

            const newLongEntryFee = calculateFee(target.buyPrice, spotPrice, 1, target.buyLeg.lotSize);
            const newActiveEntryFee = (pos.entryFee || 0) - longEntryFee + newLongEntryFee + shortAdjustmentFee;

            const swappedPos = {
              ...pos,
              buyLeg: target.buyLeg,
              sellQty: target.sellQty,
              entryBuyPrice: target.buyPrice,
              entrySellPrice: adjustedSellEntryPrice,
              entryFee: newActiveEntryFee,
              accumulatedSellPnl: (pos.accumulatedSellPnl || 0) + (longPnl - longExitFee) + shortAdjustmentPnl,
              entryTime: new Date(),
              margin: calcMargin(target.buyPrice, target.buyLeg.lotSize, spotPrice, target.sellQty, target.sellLeg.lotSize),
            };
            remaining.push(swappedPos);

            // Sync leg swap to Supabase
            try {
              await supabase.from('active_positions').update({
                buy_leg: JSON.stringify(target.buyLeg),
                sell_qty: target.sellQty,
                entry_buy_price: target.buyPrice,
                entry_sell_price: adjustedSellEntryPrice,
                entry_fee: newActiveEntryFee,
                accumulated_sell_pnl: swappedPos.accumulatedSellPnl,
                entry_time: swappedPos.entryTime.toISOString(),
                margin: swappedPos.margin,
              }).eq('id', pos.id);
            } catch (e) { logError('Leg swap sync error:', e); }
          }
        } else {
          remaining.push(pos);
        }
      }

      // ── 2. Open new positions (entries) ─────────────────────────────────
      const newEntries = [];

      for (const spread of topSpreads) {
        const bStrike = Number(spread.buyLeg.strike);
        const sStrike = Number(spread.sellLeg.strike);
        const spreadType = spread.buyLeg.type;

        // Expiry buffer guard
        const minutesToExpiry = (new Date(spread.buyLeg.symbol?.includes(config.expiry) ? config.expiry : config.expiry).getTime() - Date.now()) / 60000;
        const expiryCheck = (new Date(config.expiry).getTime() - Date.now()) / 60000;
        if (expiryCheck < 5) continue;

        // Buy strike conflict check
        const buyStrikeConflict = remaining.some(
          p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
        ) || newEntries.some(
          p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
        );

        // Sell strike conflict check
        const sellStrikeConflict = remaining.some(
          p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
        ) || newEntries.some(
          p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
        );

        if (buyStrikeConflict || sellStrikeConflict) continue;

        // Portfolio cap
        const count = remaining.filter(p => p.underlying === underlying && p.type === spreadType).length +
          newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
        if (count >= 3) continue;

        // 400pt diversification guard
        const existingOfType = [
          ...remaining.filter(p => p.underlying?.toUpperCase() === underlying?.toUpperCase() && p.type?.toLowerCase() === spreadType?.toLowerCase()),
          ...newEntries.filter(p => p.underlying?.toUpperCase() === underlying?.toUpperCase() && p.type?.toLowerCase() === spreadType?.toLowerCase())
        ];

        if (existingOfType.length > 0) {
          const valid = existingOfType.every(p => {
            const existingLongStrike = Number(p.buyStrike ?? p.buyLeg?.strike ?? p.buy_strike);
            if (isNaN(existingLongStrike)) return true;
            return Math.abs(bStrike - existingLongStrike) >= 400;
          });
          if (!valid) continue;
        }

        // Entry pricing
        const entryBuyPrice = spread.buyPrice;
        const entrySellPrice = spread.sellPrice;
        const tickerBuyEntry = tickerData[spread.buyLeg.symbol];
        const tickerSellEntry = tickerData[spread.sellLeg.symbol];
        const entryBuyIv = tickerBuyEntry?.askIv ?? tickerBuyEntry?.iv ?? null;
        const entrySellIv = tickerSellEntry?.bidIv ?? tickerSellEntry?.iv ?? null;
        const buyLegWithIv = { ...spread.buyLeg, entryIv: entryBuyIv };
        const sellLegWithIv = { ...spread.sellLeg, entryIv: entrySellIv };

        const entryBuyFee = calculateFee(entryBuyPrice, spotPrice, 1, spread.buyLeg.lotSize);
        const entrySellFee = calculateFee(entrySellPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
        const entryFee = entryBuyFee + entrySellFee;
        const id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

        const newPos = {
          id, underlying, expiry: config.expiry, type: spreadType,
          buyLeg: buyLegWithIv, sellLeg: sellLegWithIv, sellQty: spread.sellQty,
          strikeDiff: spread.strikeDiff, entryTime: new Date(),
          entryBuyPrice, entrySellPrice, entrySpotPrice: spotPrice,
          entryFee,
          margin: calcMargin(entryBuyPrice, spread.buyLeg.lotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize),
        };
        newEntries.push(newPos);
      }

      // ── 3. Supabase side effects ──────────────────────────────────────
      if (exited.length > 0 || newEntries.length > 0) {
        lastDbWrite = Date.now();
      }

      // Process exits
      for (const t of exited) {
        try {
          const { data: alreadyExited } = await supabase
            .from('trade_history').select('trade_id').eq('trade_id', t.id).limit(1);

          if (!alreadyExited || alreadyExited.length === 0) {
            const { error: histError } = await supabase.from('trade_history').insert([{
              trade_id: t.id, underlying, expiry: t.expiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff,
              entry_time: t.entryTime.toISOString(),
              entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
              entry_spot_price: t.entrySpotPrice, margin: t.margin,
              exit_time: t.zombieExitTime || new Date().toISOString(),
              exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell,
              exit_spot_price: t.exitSpotPrice,
              realized_gross_pnl: t.realizedGrossPnl, realized_net_pnl: t.realizedNetPnl,
              exit_fee: t.exitFee, total_fees: t.totalFees, exit_reason: t.exitReason,
              is_partial: t._isPartial || false,
            }]);
            if (histError) logError('History insert error:', histError.message);
          }

          // Delete from active (skip for leg swaps — they were updated in-place above)
          if (!t._isPartial && !t.exitReason?.startsWith('Leg Swap')) {
            await supabase.from('active_positions').delete().eq('id', t.id);
          }

          log(`📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (err) { logError('Exit persistence error:', err); }
      }

      // Process entries
      for (const t of newEntries) {
        try {
          // DB-level count guard
          const { data: activeOfType, error: countError } = await supabase
            .from('active_positions').select('id')
            .eq('underlying', underlying).eq('type', t.type);
          if (!countError && (activeOfType?.length ?? 0) >= 3) continue;

          // DB-level 400pt diversification guard
          const { data: activeStrikes400, error: strikeCheckError } = await supabase
            .from('active_positions').select('buy_strike')
            .eq('underlying', underlying).eq('type', t.type);
          if (strikeCheckError) continue;
          if (activeStrikes400 && activeStrikes400.some(r =>
            Math.abs(Number(r.buy_strike) - Number(t.buyLeg.strike)) < 400
          )) {
            logWarn(`DB Guard: Blocked entry — buy strike ${t.buyLeg.strike} too close (<400 pts).`);
            continue;
          }

          // Sell strike uniqueness
          const { data: sellConflict } = await supabase.from('active_positions').select('id')
            .eq('underlying', underlying).eq('type', t.type)
            .eq('sell_strike', t.sellLeg.strike).limit(1);
          if (sellConflict && sellConflict.length > 0) continue;

          const { error: insertError } = await supabase.from('active_positions').insert([{
            id: t.id, underlying, expiry: config.expiry, type: t.type,
            buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
            sell_qty: t.sellQty, strike_diff: t.strikeDiff,
            entry_time: t.entryTime.toISOString(),
            entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
            entry_spot_price: t.entrySpotPrice,
            margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
            buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
          }]);

          if (insertError) {
            if (insertError.code === '23505') {
              logWarn(`DB Guard: Duplicate strike entry blocked for ${t.buyLeg.strike}/${t.sellLeg.strike}`);
            } else {
              logError('Insert error:', insertError.message);
            }
          } else {
            log(`📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: 1:${t.sellQty} | Net: $${(t.entryBuyPrice - t.sellQty * t.entrySellPrice).toFixed(2)}`);
          }
        } catch (err) { logError('Entry persistence error:', err); }
      }

      // Update in-memory positions
      positions = [...remaining, ...newEntries];

      // Update heartbeat
      heartbeat.update({
        active_positions: positions.length,
        spot_price: spotPrice,
        underlying: config.underlying,
        expiry: config.expiry,
      });

    } finally {
      isEvaluating = false;
      lastEvaluated = Date.now();
    }
  }

  // ── Config hot-reload via Supabase Realtime ───────────────────────────

  function subscribeConfigChanges() {
    const channel = supabase
      .channel('paper_config_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_config' },
        async () => {
          log('Config change detected — reloading...');
          const oldUnderlying = config.underlying;
          const oldExpiry = config.expiry;
          await fetchConfig();

          // If underlying or expiry changed, restart WS and refresh products
          if (config.underlying !== oldUnderlying || config.expiry !== oldExpiry) {
            log(`Config changed: ${oldUnderlying}/${oldExpiry} → ${config.underlying}/${config.expiry}`);
            await refreshProducts();
            tickerData = {};
            startWebSocket();
            await fetchActivePositions();
          }
        }
      )
      .subscribe();

    return channel;
  }

  // ── Main startup sequence ─────────────────────────────────────────────

  log('═══════════════════════════════════════════');
  log('Paper Trading Engine starting...');
  log('═══════════════════════════════════════════');

  // 1. Load config
  await fetchConfig();

  // 2. Load products + expiry
  await refreshProducts();

  // 3. Fetch spot price
  await fetchSpot();
  if (spotPrice) log(`Spot price: $${spotPrice.toFixed(2)}`);

  // 4. Fetch existing positions
  await fetchActivePositions();
  log(`Active positions loaded: ${positions.length}`);

  // 5. Build symbol map and backfill tickers via REST
  symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
  tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
  log(`Ticker backfill complete: ${Object.keys(tickerData).length} symbols`);

  // 6. Start WebSocket
  startWebSocket();

  // 7. Start heartbeat
  heartbeat.update({
    underlying: config.underlying,
    expiry: config.expiry,
    active_positions: positions.length,
    spot_price: spotPrice,
  });
  await heartbeat.start();

  // 8. Subscribe to config changes
  const configChannel = subscribeConfigChanges();

  // ── Timers ────────────────────────────────────────────────────────────

  // Main evaluation loop — every 1 second (algo runs only at minute boundaries)
  const evalTimer = setInterval(async () => {
    if (!spotPrice || !config.expiry) return;

    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const lastMinute = Math.floor(lastEvaluated / 60000);

    if (currentMinute > lastMinute || lastEvaluated === 0) {
      await evaluateStrategy();
    }
  }, 1000);

  // Spot price polling — every 10 seconds
  const spotTimer = setInterval(fetchSpot, 10000);

  // Product refresh — every 5 minutes
  const productTimer = setInterval(async () => {
    await refreshProducts();
    // Rebuild symbol meta and restart WS if needed
    const newMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
    const newSymbols = Object.keys(newMeta).sort().join(',');
    const oldSymbols = Object.keys(symbolMeta).sort().join(',');
    if (newSymbols !== oldSymbols) {
      symbolMeta = newMeta;
      startWebSocket();
    }
  }, 5 * 60 * 1000);

  // Active positions refresh — every 30 seconds (fallback sync)
  const positionsTimer = setInterval(fetchActivePositions, 30000);

  log('Paper Trading Engine is LIVE');

  // ── Return cleanup function ───────────────────────────────────────────
  return {
    async stop() {
      log('Paper Trading Engine shutting down...');
      clearInterval(evalTimer);
      clearInterval(spotTimer);
      clearInterval(productTimer);
      clearInterval(positionsTimer);
      if (wsHandle) { wsHandle.close(); wsHandle = null; }
      supabase.removeChannel(configChannel);
      await heartbeat.stop();
      log('Paper Trading Engine stopped.');
    }
  };
}
