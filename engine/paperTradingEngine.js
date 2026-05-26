/**
 * Paper Trading Engine — Server-Side
 *
 * Headless Node.js version of PaperTrading.jsx's evaluateStrategy Phase 2.
 * Runs as a persistent process: connects to Delta Exchange WS, evaluates
 * strategy every minute, and writes all state to Supabase.
 *
 * Features preserved from browser version:
 * - Leg swap optimization
 * - Rotation with worst-first, 1-for-1 reservation
 * - 0.5% spot scaling guard
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
    const perpSymbol = `${config.underlying}USD`;
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.includes(perpSymbol)) {
      allSymbols.push(perpSymbol);
    }
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
        if (msg.symbol === perpSymbol) {
          const sp = parseFloat(msg.spot_price || msg.mark_price || msg.close || msg.last_price);
          if (sp && !isNaN(sp)) {
            spotPrice = sp;
            lastSpotUpdate = Date.now();
          }
          return;
        }
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

  async function evaluateStrategy(onlyExits = false) {
    if (isEvaluating || !spotPrice) return;

    // Spot staleness guard
    const spotAge = Date.now() - lastSpotUpdate;
    if (lastSpotUpdate > 0 && spotAge > 120000) {
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

      function getTickerPrice(strike, optType, priceField) {
        const lowerType = optType.toLowerCase();
        const allTickersOfType = allTickers.filter(t => t.type === lowerType);
        if (!allTickersOfType.length) return null;

        // Exact match first
        const exact = allTickersOfType.find(t => t.strike === strike);
        if (exact) {
          const val = exact[priceField] ?? exact.markPrice;
          return (val != null && val > 0) ? val : null;
        }

        // Nearest strike fallback
        const tolerance = Math.max(spotPrice * 0.10, 5000);
        let nearest = null;
        let minDist = Infinity;
        for (const t of allTickersOfType) {
          const dist = Math.abs(t.strike - strike);
          if (dist < minDist && dist <= tolerance) {
            minDist = dist;
            nearest = t;
          }
        }
        if (!nearest) return null;
        const val = nearest[priceField] ?? nearest.markPrice;
        return (val != null && val > 0) ? val : null;
      }

      function calculateAtmPnlAndRoi(spread) {
        const buyIntrinsic = getTickerPrice(atmStrike, spread.buyLeg.type, 'bid');
        const targetSellStrike = spread.buyLeg.type === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
        const sellIntrinsic = getTickerPrice(targetSellStrike, spread.buyLeg.type, 'ask');
        const lotSize = spread.buyLeg.lotSize || 1;

        if (buyIntrinsic == null || sellIntrinsic == null) {
          return { atmPnl: null, roi: null };
        }

        const atmPnl = ((buyIntrinsic - spread.buyPrice) - (sellIntrinsic - spread.sellPrice) * spread.sellQty) * lotSize;
        const margin = calcMargin(spread.buyPrice, lotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize || lotSize);
        const roi = margin > 0 ? (atmPnl / margin) * 100 : 0;

        return { atmPnl, roi };
      }

      // Compute ATM P&L and ROI for each spread in topSpreads, and filter by ATM P&L >= 70
      const processedSpreads = [];
      for (const spread of topSpreads) {
        const { atmPnl, roi } = calculateAtmPnlAndRoi(spread);
        if (atmPnl != null && atmPnl >= 70) {
          processedSpreads.push({ ...spread, atmPnl, roi });
        }
      }

      // Group by buy strike and select the one with highest ROI for each unique strike
      const callGroups = {};
      const putGroups = {};

      for (const spread of processedSpreads) {
        const key = spread.buyLeg.strike;
        if (spread.buyLeg.type === 'call') {
          if (!callGroups[key]) callGroups[key] = [];
          callGroups[key].push(spread);
        } else {
          if (!putGroups[key]) putGroups[key] = [];
          putGroups[key].push(spread);
        }
      }

      const uniqueCalls = Object.values(callGroups).map(group => {
        group.sort((a, b) => b.roi - a.roi);
        return group[0];
      });
      const uniquePuts = Object.values(putGroups).map(group => {
        group.sort((a, b) => b.roi - a.roi);
        return group[0];
      });

      // Sort candidate lists by distance to ATM (closest to ATM first)
      uniqueCalls.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));
      uniquePuts.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));

      const uniqueTopSpreads = [
        ...uniqueCalls.slice(0, 10),
        ...uniquePuts.slice(0, 10)
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

        // Dynamic ATM ratio-based scaling
        if (atmStrike !== null) {
          // Initialize/reconstruct for older/migrated positions if missing
          if (pos.buyLeg && pos.buyLeg.originalLotSize === undefined) {
            pos.buyLeg.originalLotSize = pos.buyLeg.lotSize || 1;
            if (pos.buyLeg.entryAtmRatio === undefined) {
              const liveBuyIntrinsic = getTickerPrice(atmStrike, pos.type, 'bid');
              const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
              const liveSellIntrinsic = getTickerPrice(targetSellStrike, pos.type, 'ask');
              if (liveBuyIntrinsic != null && liveSellIntrinsic != null && liveSellIntrinsic > 0) {
                pos.buyLeg.entryAtmRatio = parseFloat((Math.round((liveBuyIntrinsic / liveSellIntrinsic) / 0.25) * 0.25).toFixed(2));
              } else {
                pos.buyLeg.entryAtmRatio = null;
              }
            }
            if (pos.buyLeg.maxAtmRatio === undefined) {
              pos.buyLeg.maxAtmRatio = pos.buyLeg.entryAtmRatio;
            }
            try {
              await supabase.from('active_positions').update({
                buy_leg: JSON.stringify(pos.buyLeg)
              }).eq('id', pos.id);
            } catch (e) {
              logError(`Failed to initialize entryAtmRatio for position ${pos.id}:`, e);
            }
          }

          if (pos.buyLeg && pos.buyLeg.maxAtmRatio === undefined) {
            pos.buyLeg.maxAtmRatio = pos.buyLeg.entryAtmRatio;
          }

          if (pos.buyLeg && pos.buyLeg.originalLotSize !== undefined && pos.buyLeg.entryAtmRatio != null) {
            const liveBuyIntrinsic = getTickerPrice(atmStrike, pos.type, 'bid');
            const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
            const liveSellIntrinsic = getTickerPrice(targetSellStrike, pos.type, 'ask');

            if (liveBuyIntrinsic != null && liveSellIntrinsic != null && liveSellIntrinsic > 0) {
              const liveAtmRatio = parseFloat((Math.round((liveBuyIntrinsic / liveSellIntrinsic) / 0.25) * 0.25).toFixed(2));
              const currentMaxAtmRatio = pos.buyLeg.maxAtmRatio ?? pos.buyLeg.entryAtmRatio;

              if (liveAtmRatio > currentMaxAtmRatio) {
                const diff = liveAtmRatio - pos.buyLeg.entryAtmRatio;
                let reductionFactor = 0;
                if (diff >= 0.5) {
                  const steps = Math.floor(diff / 0.5);
                  reductionFactor = Math.min(0.5, steps * 0.1);
                }
                let targetLotSize = pos.buyLeg.originalLotSize * (1 - reductionFactor);
                const minAllowed = Math.min(0.5, pos.buyLeg.originalLotSize);
                if (targetLotSize < minAllowed) {
                  targetLotSize = minAllowed;
                }

                if (targetLotSize < pos.buyLeg.lotSize || pos.buyLeg.lotSize < minAllowed) {
                  const actionStr = targetLotSize < pos.buyLeg.lotSize ? 'Reducing' : 'Correcting (floor limit)';
                  log(`⚖️ SCALING: Position ${pos.id} (${pos.type.toUpperCase()}) ATM Ratio increased from ${pos.buyLeg.entryAtmRatio} to ${liveAtmRatio} (diff: ${diff.toFixed(2)}). ${actionStr} buy lot size from ${pos.buyLeg.lotSize} to ${targetLotSize} (original: ${pos.buyLeg.originalLotSize})`);

                  const deltaQty = pos.buyLeg.lotSize - targetLotSize;
                  if (targetLotSize < pos.buyLeg.lotSize && deltaQty > 0) {
                    // Partial exit: record to trade_history
                    const buyPriceDiff = (liveExitBuy != null && pos.entryBuyPrice != null) ? (liveExitBuy - pos.entryBuyPrice) : 0;
                    const partialGrossPnl = buyPriceDiff * deltaQty;
                    const partialExitFee = calculateFee(liveExitBuy, spotPrice, 1, deltaQty);
                    const partialEntryFee = (pos.entryFee || 0) * (deltaQty / pos.buyLeg.lotSize);
                    const partialTotalFees = partialEntryFee + partialExitFee;
                    const partialNetPnl = partialGrossPnl - partialTotalFees;

                    const partialTradeId = `${pos.id}-PE-${Date.now().toString(36).toUpperCase()}`;

                    const historyBuyLeg = {
                      ...pos.buyLeg,
                      lotSize: deltaQty,
                      exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null
                    };

                    try {
                      await supabase.from('trade_history').insert([{
                        trade_id: partialTradeId,
                        underlying: pos.underlying,
                        expiry: pos.expiry,
                        type: pos.type,
                        buy_leg: JSON.stringify(historyBuyLeg),
                        sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
                        sell_qty: 0,
                        strike_diff: pos.strikeDiff,
                        entry_time: pos.entryTime.toISOString(),
                        entry_buy_price: pos.entryBuyPrice,
                        entry_sell_price: pos.entrySellPrice,
                        entry_spot_price: pos.entrySpotPrice,
                        margin: pos.margin,
                        exit_time: new Date().toISOString(),
                        exit_buy_price: liveExitBuy,
                        exit_sell_price: liveExitSell,
                        exit_spot_price: spotPrice,
                        realized_gross_pnl: partialGrossPnl,
                        realized_net_pnl: partialNetPnl,
                        exit_fee: partialExitFee,
                        total_fees: partialTotalFees,
                        exit_reason: `Partial Exit: Buy lot size reduced by ${deltaQty.toFixed(4)} due to ATM ratio increase`,
                        is_partial: true
                      }]);
                      log(`📤 PARTIAL EXIT RECORDED: ${pos.id} | Reduced by ${deltaQty.toFixed(4)} | Net PnL: $${partialNetPnl.toFixed(2)}`);
                    } catch (e) {
                      logError(`Failed to insert partial exit history for position ${pos.id}:`, e);
                    }

                    // Update remaining active position's parameters
                    pos.entryFee = Math.max(0, (pos.entryFee || 0) - partialEntryFee);
                    pos.buyLeg.maxAtmRatio = liveAtmRatio;
                  }

                  pos.buyLeg.lotSize = targetLotSize;

                  // Recalculate margin
                  pos.margin = calcMargin(
                    pos.entryBuyPrice,
                    pos.buyLeg.lotSize,
                    spotPrice,
                    pos.sellQty,
                    pos.sellLeg.lotSize || 1
                  );

                  try {
                    await supabase.from('active_positions').update({
                      buy_leg: JSON.stringify(pos.buyLeg),
                      entry_fee: pos.entryFee,
                      margin: pos.margin
                    }).eq('id', pos.id);
                  } catch (e) {
                    logError(`Failed to update scaled position ${pos.id} in DB:`, e);
                  }
                }
              }
            }
          }
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

            const oldSpotBase = pos.entrySpotPrice || pos.entryBuyPrice || spotPrice;
            const oldThresh = Math.round((oldSpotBase * 0.005) / 100) * 100;
            const spotStepValid = pos.type === 'call'
              ? spotPrice <= oldSpotBase - oldThresh
              : spotPrice >= oldSpotBase + oldThresh;
            if (!spotStepValid) return false;

            const otherPositionsOfType = sortedPositions.filter(p =>
              p.id !== pos.id && p.underlying === underlying && p.type === pos.type
            );
            return otherPositionsOfType.every(p => {
              const thresh = Math.round((p.entrySpotPrice * 0.005) / 100) * 100;
              const spotValid = pos.type === 'call'
                ? spotPrice <= p.entrySpotPrice - thresh
                : spotPrice >= p.entrySpotPrice + thresh;
              return spotValid;
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

        // Priority 3: ATM exit
        if (!shouldExit) {
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          const isAtmMET = isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike;

          if (isAtmMET) {
            shouldExit = true;
            exitReason = 'Full Exit @ ATM';
          }
        }

        // Threshold guard for rotations
        const canRotateThisType = pos.type === 'call'
          ? (activeCallsCount >= 3 && callRotationsApproved < MAX_ROTATIONS_PER_CYCLE)
          : (activePutsCount >= 3 && putRotationsApproved < MAX_ROTATIONS_PER_CYCLE);

        let rotationApproved = false;
        if (!canRotateThisType && exitReason.includes('Lost Top 3')) {
          if (shouldExit) { shouldExit = false; }
        } else if (canRotateThisType && exitReason.includes('Lost Top 3')) {
          if (shouldExit) {
            rotationApproved = true;
            if (pos.type === 'call') callRotationsApproved++; else putRotationsApproved++;
          }
        }

        if (shouldExit) {
          // Final guard for unapproved rotation exits
          if (exitReason.includes('Lost Top 3') && !rotationApproved) {
            shouldExit = false;
            remaining.push(pos);
            continue;
          }

          const totalFees = (pos.entryFee || 0) + exitFee;
          const netPnl = grossPnl - totalFees;

          const tradeRecord = {
            ...pos,
            id: pos._pendingLegSwap ? `${pos.id}-LS-${Date.now().toString(36).toUpperCase()}` : pos.id,
            sellQty: pos.sellQty,
            buyLeg: { ...pos.buyLeg, exitIv: latestBuyIv },
            sellLeg: { ...pos.sellLeg, exitIv: latestSellIv },
            _exitedBuyQty: pos.buyLeg.lotSize,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            exitSpotPrice: spotPrice,
            realizedGrossPnl: grossPnl,
            realizedNetPnl: netPnl,
            entryFee: pos.entryFee || 0,
            exitFee: exitFee,
            totalFees: totalFees,
            exitReason,
            _latestBuy: latestBuy,
            _latestSell: latestSell,
            _isPartial: false,
            zombieExitTime,
          };
          exited.push(tradeRecord);

          if (pos._pendingLegSwap) {
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

      if (!onlyExits) {
        for (const spread of uniqueTopSpreads) {
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

          // Diversification guard removed

          // Entry pricing
          const entryBuyPrice = spread.buyPrice;
          const entrySellPrice = spread.sellPrice;
          const tickerBuyEntry = tickerData[spread.buyLeg.symbol];
          const tickerSellEntry = tickerData[spread.sellLeg.symbol];
          const entryBuyIv = tickerBuyEntry?.askIv ?? tickerBuyEntry?.iv ?? null;
          const entrySellIv = tickerSellEntry?.bidIv ?? tickerSellEntry?.iv ?? null;

          // Calculate ATM ratio scaling
          const buyIntrinsic = getTickerPrice(atmStrike, spreadType, 'bid');
          const targetSellStrike = spreadType === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, spreadType, 'ask');

          const entryAtmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
            ? parseFloat((Math.round((buyIntrinsic / sellIntrinsic) / 0.25) * 0.25).toFixed(2))
            : null;

          const originalLotSize = spread.buyLeg.lotSize || 1;

          const buyLegWithIv = {
            ...spread.buyLeg,
            entryIv: entryBuyIv,
            entryAtmRatio,
            maxAtmRatio: entryAtmRatio,
            originalLotSize
          };
          const sellLegWithIv = { ...spread.sellLeg, entryIv: entrySellIv };

          const entryBuyFee = calculateFee(entryBuyPrice, spotPrice, 1, originalLotSize);
          const entrySellFee = calculateFee(entrySellPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
          const entryFee = entryBuyFee + entrySellFee;
          const id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

          const newPos = {
            id, underlying, expiry: config.expiry, type: spreadType,
            buyLeg: buyLegWithIv, sellLeg: sellLegWithIv, sellQty: spread.sellQty,
            strikeDiff: spread.strikeDiff, entryTime: new Date(),
            entryBuyPrice, entrySellPrice, entrySpotPrice: spotPrice,
            entryFee,
            margin: calcMargin(entryBuyPrice, originalLotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize),
          };
          newEntries.push(newPos);
        }
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
          if (!t.exitReason?.startsWith('Leg Swap')) {
            await supabase.from('active_positions').delete().eq('id', t.id);
          }

          log(`📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (err) { logError('Exit persistence error:', err); }
      }

      // Process entries
      if (!onlyExits) {
        for (const t of newEntries) {
          try {
            // DB-level count guard
            const { data: activeOfType, error: countError } = await supabase
              .from('active_positions').select('id')
              .eq('underlying', underlying).eq('type', t.type);
            if (!countError && (activeOfType?.length ?? 0) >= 3) continue;

            // DB-level diversification guard check removed

            // Buy strike uniqueness
            const { data: buyConflict } = await supabase.from('active_positions').select('id')
              .eq('underlying', underlying).eq('type', t.type)
              .eq('buy_strike', t.buyLeg.strike).limit(1);
            if (buyConflict && buyConflict.length > 0) continue;

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
              const originalLotSize = t.sellLeg.lotSize || 1;
              const ratioLong = t.buyLeg.lotSize / originalLotSize;
              log(`📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: ${ratioLong.toFixed(2)}:${t.sellQty} | Net: $${(t.entryBuyPrice * ratioLong - t.sellQty * t.entrySellPrice).toFixed(2)}`);
            }
          } catch (err) { logError('Entry persistence error:', err); }
        }
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
      if (!onlyExits) {
        lastEvaluated = Date.now();
      }
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

  // Main evaluation loop — every 1 second (exits run every second, entries run at minute boundaries)
  const evalTimer = setInterval(async () => {
    if (!spotPrice || !config.expiry) return;

    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const lastMinute = Math.floor(lastEvaluated / 60000);

    if (currentMinute > lastMinute || lastEvaluated === 0) {
      await evaluateStrategy(false); // Full evaluation (exits + entries)
    } else {
      await evaluateStrategy(true);  // Exit-only evaluation
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
