/**
 * Paper Trading Engine — Server-Side
 *
 * Headless Node.js version of PaperTrading.jsx's evaluateStrategy Phase 2.
 * Runs as a persistent process: connects to Delta Exchange WS, evaluates
 * strategy every minute, and writes all state to Supabase.
 *
 * Features preserved from browser version:
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

async function startSingleAccountEngine(account) {
  let accountState = account;
  const ENGINE_ID = 'paper_trading_' + accountState.id;
  const heartbeat = createHeartbeat(ENGINE_ID);
  let configDbId = null;

  // ── Mutable engine state ──────────────────────────────────────────────
  let config = {
    underlying: 'BTC', expiry: '',
    minStrikeDiff: 800, minIvDiff: 5, maxRatioDeviation: 0.25,
    minSellPremium: 10, maxNetPremium: 20, minLongDist: 500, maxSellQty: 10,
    atmRatioScaling: false,
    atmRatioPctCall: 50,
    atmRatioPctPut: 50,
    daysToExpiry: 0,
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
  let evaluationStart = 0;
  let lastWsReconnectTime = 0;
  let lastDbWrite = 0;

  // ── Supabase data fetchers ────────────────────────────────────────────

  async function fetchConfig() {
    let retries = 10;
    let data = null;
    let error = null;

    while (retries > 0) {
      try {
        const res = await supabase
          .from('paper_trading_config')
          .select('*')
          .eq('account_id', accountState.id)
          .single();
        data = res.data;
        error = res.error;

        if (data && !error) {
          break;
        }
      } catch (e) {
        error = e;
      }

      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    try {
      if (error && error.code === 'PGRST116') {
        // Row not found, let's create a default one
        logWarn(`[${accountState.name}] No config row found after retries for account_id = ${accountState.id}. Creating default...`);
        const defaultRow = {
          id: accountState.id,
          account_id: accountState.id,
          underlying: 'BTC',
          min_strike_diff: 800,
          min_iv_diff: 5,
          max_ratio_deviation: 0.25,
          min_sell_premium: 10,
          max_net_premium: 20,
          min_long_dist: 500,
          max_sell_qty: 10,
          atm_ratio_scaling: false,
          atm_ratio_distance_call: 50,
          atm_ratio_distance_put: 50,
          days_to_expiry: 0,
          updated_at: new Date().toISOString()
        };
        const { data: inserted, error: insertErr } = await supabase
          .from('paper_trading_config')
          .insert([defaultRow])
          .select('*')
          .single();
        if (inserted && !insertErr) {
          data = inserted;
          error = null;
        } else {
          logError(`[${accountState.name}] Failed to auto-create config row:`, insertErr?.message);
        }
      }

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
          atmRatioScaling: data.atm_ratio_scaling ?? false,
          atmRatioPctCall: data.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: data.atm_ratio_distance_put ?? 50,
          daysToExpiry: data.days_to_expiry ?? 0,
        };
        configDbId = data.id;
        log(`[${accountState.name}] Config loaded: ${config.underlying} | Expiry: ${config.expiry || 'auto'}`);
      }
    } catch (e) { logError(`[${accountState.name}] Config fetch error`, e); }
  }

  async function fetchActivePositions() {
    try {
      if (Date.now() - lastDbWrite < 3000) return;
      const { data, error } = await supabase
        .from('active_positions').select('*')
        .eq('account_id', accountState.id)
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
        let selectedExpiry = null;
        for (const exp of expiries) {
          const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining >= (config.daysToExpiry || 0)) {
            selectedExpiry = exp;
            break;
          }
        }
        if (!selectedExpiry) {
          selectedExpiry = expiries[0];
        }
        config.expiry = selectedExpiry;
        log(`[${accountState.name}] Expiry auto-selected: ${config.expiry}`);
        // Persist the auto-selected expiry back to Supabase
        if (configDbId) {
          await supabase.from('paper_trading_config').upsert({
            id: configDbId,
            expiry: config.expiry,
            updated_at: new Date().toISOString()
          });
        }
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
    if (isEvaluating) {
      const evalDuration = Date.now() - evaluationStart;
      if (evaluationStart > 0 && evalDuration > 60000) {
        logError(`[${accountState.name}] Strategy evaluation has been hung for ${Math.round(evalDuration / 1000)}s. Crashing process for PM2 recovery.`);
        process.exit(1);
      }
      return;
    }
    if (!spotPrice) return;

    // Spot staleness guard
    const spotAge = Date.now() - lastSpotUpdate;
    if (lastSpotUpdate > 0 && spotAge > 120000) {
      logWarn(`[${accountState.name}] Spot stale (${Math.round(spotAge / 1000)}s). Skipping evaluation.`);
      
      const now = Date.now();
      if (now - lastWsReconnectTime > 60000) {
        logWarn(`[${accountState.name}] Forcing WebSocket reconnect due to stale spot...`);
        lastWsReconnectTime = now;
        try {
          startWebSocket();
        } catch (e) {
          logError(`[${accountState.name}] Failed to force WS reconnect:`, e);
        }
      }
      return;
    }

    isEvaluating = true;
    evaluationStart = Date.now();
    try {
      const allTickers = Object.values(tickerData);
      if (allTickers.length === 0) {
        if (!onlyExits) {
          logWarn('No tickers in cache — skipping entry scan.');
        }
        return;
      }

      const underlying = config.underlying;
      const selExpiry = config.expiry;

      function getScaledSellQty(s) {
        const targetLotSize = s.buyLeg.lotSize || 1;
        const targetSellLotSize = s.sellLeg.lotSize || targetLotSize;
        const targetShortValue = spotPrice * s.sellQty * targetSellLotSize;
        if (targetShortValue >= 200000) {
          const swapScale = 200000 / targetShortValue;
          return Number((s.sellQty * swapScale).toFixed(2));
        }
        return s.sellQty;
      }

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

      function getTickerPrice(strike, optType, priceField, expiry) {
        const lowerType = optType.toLowerCase();
        const allTickersOfType = allTickers.filter(t => t.type === lowerType && (!expiry || t.expiry === expiry));
        if (!allTickersOfType.length) return null;

        // Exact match first
        const exact = allTickersOfType.find(t => t.strike === strike);
        if (exact) {
          const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
          return (val != null && val > 0) ? val : null;
        }

        // Nearest strike fallback - tight tolerance
        const maxTolerance = config.underlying === 'ETH' ? 50 : 500;
        let nearest = null;
        let minDist = Infinity;
        for (const t of allTickersOfType) {
          const dist = Math.abs(t.strike - strike);
          if (dist < minDist && dist <= maxTolerance) {
            minDist = dist;
            nearest = t;
          }
        }
        if (!nearest) return null;
        const val = nearest[priceField] ?? nearest.lastPrice ?? nearest.markPrice;
        return (val != null && val > 0) ? val : null;
      }

      function calculateAtmPnlAndRoi(spread) {
        const buyIntrinsic = getTickerPrice(atmStrike, spread.buyLeg.type, 'bid', config.expiry);
        const targetSellStrike = spread.buyLeg.type === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
        const sellIntrinsic = getTickerPrice(targetSellStrike, spread.buyLeg.type, 'ask', config.expiry);
        const lotSize = spread.buyLeg.lotSize || 1;

        if (buyIntrinsic == null || sellIntrinsic == null) {
          return { atmPnl: null, roi: null };
        }

        const sellLotSize = spread.sellLeg.lotSize || lotSize;
        let shortValue = spotPrice * spread.sellQty * sellLotSize;

        let adjustedLotSize = lotSize;
        let adjustedSellQty = spread.sellQty;
        let scale = 1;

        if (shortValue >= 200000) {
          scale = 200000 / shortValue;
          adjustedLotSize = Number((lotSize * scale).toFixed(2));
          adjustedSellQty = Number((spread.sellQty * scale).toFixed(2));
          shortValue = 200000;
        }

        const atmPnl = ((buyIntrinsic - spread.buyPrice) + (spread.sellPrice - sellIntrinsic) * spread.sellQty) * adjustedLotSize;
        const margin = calcMargin(spread.buyPrice, adjustedLotSize, spotPrice, adjustedSellQty, sellLotSize);
        const roi = margin > 0 ? (atmPnl / margin) * 100 : 0;

        return { atmPnl, roi };
      }

      // Compute ATM P&L and ROI for each spread in topSpreads, and filter by ATM P&L >= 50
      const processedSpreads = [];
      if (!onlyExits) {
        log(`Evaluating ${topSpreads.length} candidate spreads for entry (Spot: ${spotPrice}, ATM Strike: ${atmStrike})`);
      }
      for (const spread of topSpreads) {
        const { atmPnl, roi } = calculateAtmPnlAndRoi(spread);
        const passed = (atmPnl != null && atmPnl >= 50);
        if (!onlyExits) {
          log(`  Candidate ${spread.buyLeg.type.toUpperCase()} ${spread.buyLeg.strike}/${spread.sellLeg.strike}: ATM P&L = $${atmPnl != null ? atmPnl.toFixed(2) : 'null'} (Min required: $50.00), ROI = ${roi != null ? roi.toFixed(2) : 0}%, Passed = ${passed}`);
        }
        if (passed) {
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

      if (!onlyExits && uniqueTopSpreads.length > 0) {
        const topDesc = uniqueTopSpreads.map(s => `${s.buyLeg.type.toUpperCase()} ${s.buyLeg.strike}/${s.sellLeg.strike} (ROI: ${s.roi.toFixed(1)}%, ATM P&L: $${s.atmPnl.toFixed(1)})`).join(', ');
        log(`Selected top unique spreads: ${topDesc}`);
      }

      // Count active positions
      const activeCallsCount = positions.filter(p => p.type === 'call' && p.underlying === underlying).length;
      const activePutsCount = positions.filter(p => p.type === 'put' && p.underlying === underlying).length;

      let callRotationsApproved = 0;
      let putRotationsApproved = 0;
      const MAX_ROTATIONS_PER_CYCLE = 3;

      const remaining = [];
      const exited = [];
      const reservedTargets = new Set();
      const reservedSellTargets = new Set();

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
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

        if (liveExitBuy == null || liveExitSell == null) {
          remaining.push(pos);
          continue;
        }

        // Dynamic ATM ratio-based scaling
        if (atmStrike !== null) {
          // Initialize missing fields for older positions
          if (pos.buyLeg && (pos.buyLeg.originalLotSize === undefined || pos.buyLeg.originalSellQty === undefined || pos.buyLeg.initialScaledLotSize === undefined)) {
            pos.buyLeg.originalLotSize = pos.buyLeg.originalLotSize ?? (pos.buyLeg.lotSize || 1);
            pos.buyLeg.originalSellQty = pos.buyLeg.originalSellQty ?? (pos.sellQty || 0);
            if (pos.buyLeg.initialScaledLotSize === undefined) {
              const origLot = pos.buyLeg.originalLotSize;
              const origSell = pos.buyLeg.originalSellQty;
              if (origSell > 0 && pos.sellQty > 0) {
                pos.buyLeg.initialScaledLotSize = Number((pos.sellQty * (origLot / origSell)).toFixed(2));
              } else {
                pos.buyLeg.initialScaledLotSize = pos.buyLeg.lotSize || origLot;
              }
            }
            try {
              await supabase.from('active_positions').update({
                buy_leg: JSON.stringify(pos.buyLeg)
              }).eq('id', pos.id);
            } catch (e) {
              logError(`Failed to initialize originalLotSize/originalSellQty/initialScaledLotSize for position ${pos.id}:`, e);
            }
          }

          const buyIntrinsic = getTickerPrice(atmStrike, pos.type, 'bid', pos.expiry);
          const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, pos.type, 'ask', pos.expiry);

          if (pos.buyLeg && pos.buyLeg.originalLotSize !== undefined && buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0) {
            const liveAtmRatio = parseFloat((Math.round((buyIntrinsic / sellIntrinsic) / 0.25) * 0.25).toFixed(2));
            const originalLotSize = pos.buyLeg.originalLotSize || pos.buyLeg.lotSize || 1;
            const initialScaledLotSize = pos.buyLeg.initialScaledLotSize !== undefined
              ? pos.buyLeg.initialScaledLotSize
              : (pos.buyLeg.originalSellQty && pos.buyLeg.originalSellQty > 0
                  ? Number((pos.sellQty * (originalLotSize / pos.buyLeg.originalSellQty)).toFixed(2))
                  : originalLotSize);
            const deltaBuyQty = Number((initialScaledLotSize * 0.25).toFixed(2));
            const floorLimit = Number((initialScaledLotSize * 0.5).toFixed(2));
            let currentLotSize = pos.buyLeg.lotSize;
            let hypotheticalLotSize = Number((currentLotSize - deltaBuyQty).toFixed(2));
            let recalculatedRatio = hypotheticalLotSize > 0
              ? Number((pos.sellQty / hypotheticalLotSize).toFixed(2))
              : Infinity;
            let entryFee = pos.entryFee || 0;
            let hasScaled = false;
            let partialExitsToRecord = [];

            const buyPriceDiff = (liveExitBuy != null && pos.entryBuyPrice != null) ? (liveExitBuy - pos.entryBuyPrice) : 0;
            const sellPriceDiff = (liveExitSell != null && pos.entrySellPrice != null) ? (pos.entrySellPrice - liveExitSell) : 0;

            // NOTE: DB column is "accumulated_sell_pnl" but it actually tracks accumulated BUY leg partial exit PnL
            let accumulatedPartialBuyPnl = pos.accumulatedSellPnl || 0;

            let currentGrossPnl = (buyPriceDiff * currentLotSize)
              + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
              + accumulatedPartialBuyPnl;

            // ATM PnL: buy side scales with lotSize, sell side is fixed (sellQty unchanged in partial exits)
            const atmBuyPnlPerLot = buyIntrinsic - pos.entryBuyPrice;
            const atmSellPnlTotal = (pos.entrySellPrice - sellIntrinsic) * pos.sellQty * (pos.sellLeg.lotSize || 1);

            let checkpointPnl = pos.buyLeg.lastCheckpointPnl !== undefined
              ? pos.buyLeg.lastCheckpointPnl
              : (pos.entrySellPrice * pos.sellQty * (pos.sellLeg.lotSize || 1))
              - (pos.entryBuyPrice * currentLotSize);

            let checkpointAtmPnl = pos.buyLeg.lastCheckpointAtmPnl !== undefined
              ? pos.buyLeg.lastCheckpointAtmPnl
              : (atmBuyPnlPerLot * currentLotSize) + atmSellPnlTotal;

            let threshold = (checkpointAtmPnl * 0.25) + checkpointPnl;

            while (
              currentGrossPnl >= threshold &&
              hypotheticalLotSize >= floorLimit &&
              liveAtmRatio >= recalculatedRatio + 1
            ) {
              log(`⚖️ SCALING: Position ${pos.id} (${pos.type.toUpperCase()}) - PnL: $${currentGrossPnl.toFixed(2)} >= Threshold: $${threshold.toFixed(2)}. ATM ratio (1:x) increased: Recalculated Ratio ${recalculatedRatio.toFixed(2)} <= Live ${liveAtmRatio} - 1. Reducing buy lot size from ${currentLotSize} to ${hypotheticalLotSize}.`);

              const partialGrossPnl = buyPriceDiff * deltaBuyQty;

              // Proportional entry fee: use local (decremented) entryFee and currentLotSize
              const partialEntryFee = entryFee * (deltaBuyQty / currentLotSize);
              const partialExitFee = calculateFee(liveExitBuy, spotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1);
              const partialTotalFees = partialEntryFee + partialExitFee;
              const partialNetPnl = partialGrossPnl - partialTotalFees;

              accumulatedPartialBuyPnl += partialGrossPnl;

              const partialTradeId = `${pos.id}-PE-${Date.now().toString(36).toUpperCase()}-${partialExitsToRecord.length}`;

              const historyBuyLeg = {
                ...pos.buyLeg,
                lotSize: deltaBuyQty,
                exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null,
                exitBuyAtmPrice: buyIntrinsic,
                exitSellAtmPrice: sellIntrinsic,
                exitAtmRatio: liveAtmRatio
              };

              // FIX B5: remainingGrossPnl double count fix
              const remainingGrossPnl = (buyPriceDiff * hypotheticalLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + (accumulatedPartialBuyPnl - partialGrossPnl);

              const remainingExitFee = calculateFee(liveExitBuy, spotPrice, hypotheticalLotSize, pos.buyLeg.originalLotSize || 1)
                + calculateFee(liveExitSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize || 1);
              const remainingEntryFee = Math.max(0, entryFee - partialEntryFee);
              const remainingNetPnl = remainingGrossPnl - (remainingEntryFee + remainingExitFee);

              const originalSellQty = pos.buyLeg.originalSellQty || pos.sellQty || 0;
              const entryNetPremium = (pos.entrySellPrice * originalSellQty * (pos.sellLeg.lotSize || 1))
                - (pos.entryBuyPrice * originalLotSize);
              const entryPremiumType = entryNetPremium >= 0 ? 'Credit' : 'Debit';
              const entryPremiumVal = Math.abs(entryNetPremium);

              // Compute next threshold using post-update values (after lot size reduction)
              const postAtmPnl = (atmBuyPnlPerLot * hypotheticalLotSize) + atmSellPnlTotal;
              const postGrossPnl = (buyPriceDiff * hypotheticalLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + accumulatedPartialBuyPnl;
              const nextThreshold = (postAtmPnl * 0.25) + postGrossPnl;
              const partialExitReason = [
                `Partial Exit`,
                `Current Gross PnL: $${currentGrossPnl.toFixed(2)}`,
                `Threshold Met: $${threshold.toFixed(2)}`,
                `Checkpoint PnL: $${checkpointPnl.toFixed(2)}`,
                `Checkpoint ATM PnL: $${checkpointAtmPnl.toFixed(2)}`,
                `ATM step (25%): $${(checkpointAtmPnl * 0.25).toFixed(2)}`,
                `Next threshold: $${nextThreshold.toFixed(2)}`,
                `Live ATM Ratio: ${liveAtmRatio.toFixed(2)}`,
                `Recalculated Ratio: ${recalculatedRatio.toFixed(2)}`,
                `Lots remaining: ${hypotheticalLotSize.toFixed(2)}`,
                `Net ${entryPremiumType} at Entry: $${entryPremiumVal.toFixed(2)}`
              ].join(' | ');

              partialExitsToRecord.push({
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
                exit_reason: partialExitReason,
                is_partial: true,
                account_id: accountState.id
              });

              entryFee = Math.max(0, entryFee - partialEntryFee);

              // FIX B3: save checkpoint AFTER lot size reduction
              currentLotSize = hypotheticalLotSize;

              currentGrossPnl = (buyPriceDiff * currentLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + accumulatedPartialBuyPnl;

              checkpointPnl = currentGrossPnl;
              pos.buyLeg.lastCheckpointPnl = checkpointPnl;

              // Recalculate ATM PnL: buy scales with reduced lot size, sell stays fixed
              checkpointAtmPnl = (atmBuyPnlPerLot * currentLotSize) + atmSellPnlTotal;
              pos.buyLeg.lastCheckpointAtmPnl = checkpointAtmPnl;

              threshold = (checkpointAtmPnl * 0.25) + checkpointPnl;

              pos.buyLeg.maxAtmRatio = recalculatedRatio;

              hasScaled = true;

              hypotheticalLotSize = Number((currentLotSize - deltaBuyQty).toFixed(2));
              recalculatedRatio = hypotheticalLotSize > 0
                ? Number((pos.sellQty / hypotheticalLotSize).toFixed(2))
                : Infinity;
            }

            if (hasScaled) {
              pos.entryFee = entryFee;
              pos.buyLeg.lotSize = currentLotSize;
              pos.accumulatedSellPnl = accumulatedPartialBuyPnl; // DB column name is misleading; tracks buy leg partial PnL

              pos.margin = calcMargin(
                pos.entryBuyPrice,
                pos.buyLeg.lotSize,
                spotPrice,
                pos.sellQty,
                pos.sellLeg.lotSize || 1
              );

              // FIX B6: batched insert
              try {
                await supabase.from('trade_history').insert(partialExitsToRecord);
                log(`📤 PARTIAL EXITS RECORDED: ${pos.id} | ${partialExitsToRecord.length} exits | Total reduced: ${partialExitsToRecord.length * deltaBuyQty} lots`);
              } catch (e) {
                logError(`Failed to insert partial exit history for position ${pos.id}:`, e);
              }

              try {
                await supabase.from('active_positions').update({
                  buy_leg: JSON.stringify(pos.buyLeg),
                  entry_fee: pos.entryFee,
                  margin: pos.margin,
                  accumulated_sell_pnl: pos.accumulatedSellPnl
                }).eq('id', pos.id);
              } catch (e) {
                logError(`Failed to update scaled position ${pos.id} in DB:`, e);
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

        // PnL calculations (for remaining lots only; partial exit PnL stored separately in trade_history with is_partial=true)
        const buyPriceDiff = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
        const sellPriceDiff = (latestSell != null && pos.entrySellPrice != null) ? (pos.entrySellPrice - latestSell) : 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) + (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize);
        const exitFee = calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) +
          calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        // Check top-3 ranking
        const top3SpreadsOfType = uniqueTopSpreads
          .filter(s => s.buyLeg.type === pos.type)
          .slice(0, 3);
        const inTop3 = top3SpreadsOfType.some(s =>
          Number(s.buyLeg.strike) === Number(pos.buyLeg.strike)
        );

        // Priority 4: Rotation
        if (!shouldExit && pos.expiry === selExpiry && uniqueTopSpreads.length > 0) {
          const otherActiveBuyStrikes = sortedPositions
            .filter(p => p.id !== pos.id && p.underlying === underlying && p.type === pos.type)
            .map(p => Number(p.buyLeg.strike));
          const otherActiveSellStrikes = sortedPositions
            .filter(p => p.id !== pos.id && p.underlying === underlying && p.type === pos.type)
            .map(p => Number(p.sellLeg.strike));

          // 1. Check for Leg Swap (same sell strike, better buy strike)
          const bestSwapTarget = uniqueTopSpreads.filter(s => s.buyLeg.type === pos.type).find(s => {
            const bS = Number(s.buyLeg.strike);
            const sS = Number(s.sellLeg.strike);

            // Must match the exact sell strike of the active position
            if (sS !== Number(pos.sellLeg.strike)) return false;

            // Check buy/sell conflicts
            const buyConflict = otherActiveBuyStrikes.includes(bS);
            const sellConflict = otherActiveSellStrikes.includes(sS);
            if (buyConflict || sellConflict || reservedTargets.has(bS) || reservedSellTargets.has(sS)) return false;

            // Must be a better buy strike (closer to ATM)
            const currentStrike = Number(pos.buyLeg.strike);
            const isPut = pos.type === 'put';
            const isBetter = isPut ? (bS > currentStrike) : (bS < currentStrike);
            if (!isBetter) return false;

            // Swap PnL guard: net premium swap cost (sell - buy) must be at least 0 (i.e. no debit)
            const deltaQty = getScaledSellQty(s) - pos.sellQty;
            const netPremiumSwap = (deltaQty * latestSell) - (s.buyPrice - latestBuy);
            if (netPremiumSwap < 0) {
              if (!onlyExits) {
                log(`  Leg Swap candidate target ${s.buyLeg.type.toUpperCase()} ${bS}/${sS} rejected: net premium swap cost too high ($${netPremiumSwap.toFixed(2)} < $0.00 credit/debit)`);
              }
              return false;
            }

            // Spot step movement guard
            const oldSpotBase = pos.entrySpotPrice || pos.entryBuyPrice || spotPrice;
            const oldThresh = Math.round((oldSpotBase * 0.005) / 100) * 100;
            const spotStepValid = Math.abs(spotPrice - oldSpotBase) >= oldThresh;
            if (!spotStepValid) {
              if (!onlyExits) {
                log(`  Leg Swap candidate target ${s.buyLeg.type.toUpperCase()} ${bS}/${sS} rejected: spot step invalid (Spot: ${spotPrice}, Entry Spot Base: ${oldSpotBase}, Required movement: ${oldThresh})`);
              }
              return false;
            }
            return true;
          });

          if (bestSwapTarget) {
            const targetStrike = Number(bestSwapTarget.buyLeg.strike);
            const targetSellStrike = Number(bestSwapTarget.sellLeg.strike);
            const currentStrike = Number(pos.buyLeg.strike);
            if (!onlyExits) {
              log(`  Leg Swap target found: ${bestSwapTarget.buyLeg.type.toUpperCase()} ${targetStrike}/${targetSellStrike}. Upgrading buy strike from ${currentStrike}`);
            }
            pos._pendingLegSwap = bestSwapTarget;
            shouldExit = true;
            const deltaQty = getScaledSellQty(bestSwapTarget) - pos.sellQty;
            const netPremiumSwap = (deltaQty * latestSell) - (bestSwapTarget.buyPrice - latestBuy);
            exitReason = `Leg Swap: Buy ${currentStrike} -> ${targetStrike} | Old Buy: $${latestBuy.toFixed(2)} | New Buy: $${bestSwapTarget.buyPrice.toFixed(2)} | Old Sell Qty: ${pos.sellQty} | New Sell Qty: ${getScaledSellQty(bestSwapTarget)} | Sell Price: $${latestSell.toFixed(2)} | Net Premium Swap: $${netPremiumSwap.toFixed(2)}`;
            reservedTargets.add(targetStrike);
            reservedSellTargets.add(targetSellStrike);
          } else if (!onlyExits && !inTop3) {
            // 2. Fallback to standard rotation (only for positions not in Top 3 during a full cycle)
            const bestTarget = uniqueTopSpreads.filter(s => s.buyLeg.type === pos.type).find(s => {
              const bS = Number(s.buyLeg.strike);
              const sS = Number(s.sellLeg.strike);

              const buyConflict = otherActiveBuyStrikes.includes(bS);
              const sellConflict = otherActiveSellStrikes.includes(sS);
              if (buyConflict || sellConflict || reservedTargets.has(bS) || reservedSellTargets.has(sS)) return false;

              // If it's a leg swap (same sell strike), check swap cost based on net premium
              if (sS === Number(pos.sellLeg.strike)) {
                const deltaQty = getScaledSellQty(s) - pos.sellQty;
                const netPremiumSwap = (deltaQty * latestSell) - (s.buyPrice - latestBuy);
                if (netPremiumSwap < 0) return false;
              }

              const oldSpotBase = pos.entrySpotPrice || pos.entryBuyPrice || spotPrice;
              const oldThresh = Math.round((oldSpotBase * 0.005) / 100) * 100;
              const spotStepValid = Math.abs(spotPrice - oldSpotBase) >= oldThresh;
              if (!spotStepValid) {
                if (!onlyExits) {
                  log(`  Candidate target ${s.buyLeg.type.toUpperCase()} ${bS}/${sS} rejected: spot step invalid (Spot: ${spotPrice}, Entry Spot Base: ${oldSpotBase}, Required movement: ${oldThresh})`);
                }
                return false;
              }

              return true;
            });

            if (bestTarget) {
              const targetStrike = Number(bestTarget.buyLeg.strike);
              const targetSellStrike = Number(bestTarget.sellLeg.strike);
              const currentStrike = Number(pos.buyLeg.strike);
              const isPut = pos.type === 'put';
              const isBetter = isPut ? (targetStrike > currentStrike) : (targetStrike < currentStrike);
              if (!onlyExits) {
                log(`  Best target found: ${bestTarget.buyLeg.type.toUpperCase()} ${targetStrike}/${targetSellStrike}. Is Better (closer to ATM): ${isBetter}`);
              }

              if (isBetter) {
                const isSellStrikeMatch = Number(bestTarget.sellLeg.strike) === Number(pos.sellLeg.strike);
                if (isSellStrikeMatch) {
                  pos._pendingLegSwap = bestTarget;
                  shouldExit = true;
                  const deltaQty = getScaledSellQty(bestTarget) - pos.sellQty;
                  const netPremiumSwap = (deltaQty * latestSell) - (bestTarget.buyPrice - latestBuy);
                  exitReason = `Leg Swap: Buy ${currentStrike} -> ${targetStrike} | Old Buy: $${latestBuy.toFixed(2)} | New Buy: $${bestTarget.buyPrice.toFixed(2)} | Old Sell Qty: ${pos.sellQty} | New Sell Qty: ${getScaledSellQty(bestTarget)} | Sell Price: $${latestSell.toFixed(2)} | Net Premium Swap: $${netPremiumSwap.toFixed(2)}`;
                  reservedTargets.add(targetStrike);
                  reservedSellTargets.add(targetSellStrike);
                } else {
                  // Standard rotation: Verify DB-level uniqueness checks before exiting
                  let hasConflict = false;
                  try {
                    const { data: dbBuyConflict } = await supabase.from('active_positions').select('id')
                      .eq('account_id', accountState.id)
                      .eq('underlying', underlying).eq('type', pos.type)
                      .eq('buy_strike', targetStrike).limit(1);
                    const { data: dbSellConflict } = await supabase.from('active_positions').select('id')
                      .eq('account_id', accountState.id)
                      .eq('underlying', underlying).eq('type', pos.type)
                      .eq('sell_strike', targetSellStrike).limit(1);

                    if ((dbBuyConflict && dbBuyConflict.length > 0) || (dbSellConflict && dbSellConflict.length > 0)) {
                      hasConflict = true;
                      log(`[${accountState.name}] Rotation target ${bestTarget.buyLeg.type.toUpperCase()} ${targetStrike}/${targetSellStrike} skipped: DB strike conflict exists.`);
                    }
                  } catch (dbErr) {
                    hasConflict = true;
                    logError(`[${accountState.name}] Failed to verify DB strike conflict for rotation:`, dbErr);
                  }

                  if (!hasConflict) {
                    shouldExit = true;
                    exitReason = `Lost Top 3 and Rank 1 better target available (${targetStrike})`;
                    reservedTargets.add(targetStrike);
                    reservedSellTargets.add(targetSellStrike);
                  }
                }
              }
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

          let finalGrossPnl = grossPnl;
          let finalExitFee = exitFee;
          let finalEntryFee = pos.entryFee || 0;
          let finalTotalFees = totalFees;
          let finalNetPnl = grossPnl - totalFees;
          let finalSellQty = pos.sellQty;
          let finalSellLeg = { ...pos.sellLeg, exitIv: latestSellIv };

          const isLegSwap = exitReason.startsWith('Leg Swap');
          if (isLegSwap) {
            // Gross PNL based on change in buyQty (only long leg)
            finalGrossPnl = (latestBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize;
            // Exit fee based on long leg exit only
            finalExitFee = calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1);
            // Entry fee apportioned to long leg
            const longEntryFee = (pos.entryFee || 0) * (pos.buyLeg.lotSize / (pos.buyLeg.lotSize + (pos.sellQty * (pos.sellLeg.lotSize || 1))));
            finalEntryFee = longEntryFee;
            finalTotalFees = finalEntryFee + finalExitFee;
            finalNetPnl = finalGrossPnl - finalTotalFees;
            // sellQty should be 0 when exiting
            finalSellQty = 0;
            finalSellLeg = { ...pos.sellLeg, lotSize: 0, exitIv: latestSellIv };
          }

          let exitBuyAtmPrice = null;
          let exitSellAtmPrice = null;
          let exitAtmRatio = null;
          if (atmStrike !== null) {
            exitBuyAtmPrice = getTickerPrice(atmStrike, pos.type, 'bid', pos.expiry);
            const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
            exitSellAtmPrice = getTickerPrice(targetSellStrike, pos.type, 'ask', pos.expiry);
            if (exitBuyAtmPrice != null && exitSellAtmPrice != null && exitSellAtmPrice > 0) {
              exitAtmRatio = parseFloat((Math.round((exitBuyAtmPrice / exitSellAtmPrice) / 0.25) * 0.25).toFixed(2));
            }
          }

          const tradeRecord = {
            ...pos,
            id: pos._pendingLegSwap ? `${pos.id}-LS-${Date.now().toString(36).toUpperCase()}` : pos.id,
            sellQty: finalSellQty,
            buyLeg: {
              ...pos.buyLeg,
              exitIv: latestBuyIv,
              exitBuyAtmPrice,
              exitSellAtmPrice,
              exitAtmRatio
            },
            sellLeg: finalSellLeg,
            _exitedBuyQty: pos.buyLeg.lotSize,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            exitSpotPrice: spotPrice,
            realizedGrossPnl: finalGrossPnl,
            realizedNetPnl: finalNetPnl,
            entryFee: finalEntryFee,
            exitFee: finalExitFee,
            totalFees: finalTotalFees,
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
            const longPnl = finalGrossPnl;
            const longExitFee = finalExitFee;
            const longEntryFee = finalEntryFee;

            // Apply $200,000 cap scaling to the target spread
            const targetLotSize = target.buyLeg.lotSize || 1;
            const targetSellLotSize = target.sellLeg.lotSize || targetLotSize;
            let targetShortValue = spotPrice * target.sellQty * targetSellLotSize;

            let adjustedTargetLotSize = targetLotSize;
            let adjustedTargetSellQty = target.sellQty;
            let swapScale = 1;

            if (targetShortValue >= 200000) {
              swapScale = 200000 / targetShortValue;
              adjustedTargetLotSize = Number((targetLotSize * swapScale).toFixed(2));
              adjustedTargetSellQty = Number((target.sellQty * swapScale).toFixed(2));
              targetShortValue = 200000;
            }

            const deltaQty = adjustedTargetSellQty - pos.sellQty;
            let adjustedSellEntryPrice = pos.entrySellPrice;
            let shortAdjustmentFee = 0;
            let shortAdjustmentPnl = 0;

            if (deltaQty > 0) {
              adjustedSellEntryPrice = ((pos.sellQty * pos.entrySellPrice) + (deltaQty * latestSell)) / adjustedTargetSellQty;
              shortAdjustmentFee = calculateFee(latestSell, spotPrice, Math.abs(deltaQty), pos.sellLeg.lotSize || 1);
            } else if (deltaQty < 0) {
              shortAdjustmentFee = calculateFee(latestSell, spotPrice, Math.abs(deltaQty), pos.sellLeg.lotSize || 1);
              shortAdjustmentPnl = (pos.entrySellPrice - latestSell) * Math.abs(deltaQty) * (pos.sellLeg.lotSize || 1);
            }

            const newLongEntryFee = calculateFee(target.buyPrice, spotPrice, adjustedTargetLotSize, target.buyLeg.lotSize || 1);
            const newActiveEntryFee = (pos.entryFee || 0) - longEntryFee + newLongEntryFee + shortAdjustmentFee;

            let newEntryAtmRatio = null;
            let entryBuyAtmPrice = null;
            let entrySellAtmPrice = null;
            if (atmStrike !== null) {
              entryBuyAtmPrice = getTickerPrice(atmStrike, pos.type, 'bid', pos.expiry);
              const targetSellStrike = pos.type === 'call' ? atmStrike + target.strikeDiff : atmStrike - target.strikeDiff;
              entrySellAtmPrice = getTickerPrice(targetSellStrike, pos.type, 'ask', pos.expiry);
              if (entryBuyAtmPrice != null && entrySellAtmPrice != null && entrySellAtmPrice > 0) {
                newEntryAtmRatio = parseFloat((Math.round((entryBuyAtmPrice / entrySellAtmPrice) / 0.25) * 0.25).toFixed(2));
              }
            }

            const tickerNewBuy = tickerData[target.buyLeg.symbol];
            const newBuyLeg = {
              ...target.buyLeg,
              lotSize: adjustedTargetLotSize,
              entryIv: tickerNewBuy?.askIv ?? tickerNewBuy?.iv ?? null,
              entryAtmRatio: newEntryAtmRatio,
              entryBuyAtmPrice,
              entrySellAtmPrice,
              maxAtmRatio: newEntryAtmRatio,
              originalLotSize: target.buyLeg.lotSize || 1,
              originalSellQty: target.sellQty,
              initialScaledLotSize: adjustedTargetLotSize
            };

            const swappedPos = {
              ...pos,
              buyLeg: newBuyLeg,
              sellQty: adjustedTargetSellQty,
              entryBuyPrice: target.buyPrice,
              entrySellPrice: adjustedSellEntryPrice,
              entryFee: newActiveEntryFee,
              accumulatedSellPnl: (pos.accumulatedSellPnl || 0) + (longPnl - longExitFee) + shortAdjustmentPnl,
              entryTime: new Date(),
              entrySpotPrice: spotPrice,
              margin: calcMargin(target.buyPrice, adjustedTargetLotSize, spotPrice, adjustedTargetSellQty, target.sellLeg.lotSize || 1),
            };
            remaining.push(swappedPos);

            // Sync leg swap to Supabase
            try {
              await supabase.from('active_positions').update({
                buy_leg: JSON.stringify(newBuyLeg),
                buy_strike: newBuyLeg.strike,
                sell_qty: adjustedTargetSellQty,
                entry_buy_price: target.buyPrice,
                entry_sell_price: adjustedSellEntryPrice,
                entry_fee: newActiveEntryFee,
                accumulated_sell_pnl: swappedPos.accumulatedSellPnl,
                entry_time: swappedPos.entryTime.toISOString(),
                entry_spot_price: spotPrice,
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
          if (expiryCheck < 5) {
            logWarn(`Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: too close to expiry (${expiryCheck.toFixed(1)} mins remaining)`);
            continue;
          }

          // Days to expiry guard
          const daysRemaining = (new Date(config.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < (config.daysToExpiry || 0)) {
            logWarn(`Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: days to expiry (${daysRemaining.toFixed(2)}) is less than min required (${config.daysToExpiry})`);
            continue;
          }

          // Buy strike conflict check
          const buyConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
          );

          // Sell strike conflict check
          const sellConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
          );

          if (buyConflictPos) {
            logWarn(`Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Buy strike conflict with active/new position ${buyConflictPos.id} (${buyConflictPos.buyLeg.strike}/${buyConflictPos.sellLeg.strike})`);
            continue;
          }
          if (sellConflictPos) {
            logWarn(`Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Sell strike conflict with active/new position ${sellConflictPos.id} (${sellConflictPos.buyLeg.strike}/${sellConflictPos.sellLeg.strike})`);
            continue;
          }

          // Portfolio cap
          let count = remaining.filter(p => p.underlying === underlying && p.type === spreadType).length +
            newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
          if (count >= 3) {
            logWarn(`Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Portfolio cap of 3 reached for type ${spreadType}`);
            continue;
          }

          // Diversification guard removed

          // Entry pricing
          const entryBuyPrice = spread.buyPrice;
          const entrySellPrice = spread.sellPrice;
          const tickerBuyEntry = tickerData[spread.buyLeg.symbol];
          const tickerSellEntry = tickerData[spread.sellLeg.symbol];
          const entryBuyIv = tickerBuyEntry?.askIv ?? tickerBuyEntry?.iv ?? null;
          const entrySellIv = tickerSellEntry?.bidIv ?? tickerSellEntry?.iv ?? null;

          // Calculate ATM ratio scaling
          const buyIntrinsic = getTickerPrice(atmStrike, spreadType, 'bid', config.expiry);
          const targetSellStrike = spreadType === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, spreadType, 'ask', config.expiry);

          const entryAtmRatio = (buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0)
            ? parseFloat((Math.round((buyIntrinsic / sellIntrinsic) / 0.25) * 0.25).toFixed(2))
            : null;

          let ratioToUse = spread.sellQty;
          if (config.atmRatioScaling && entryAtmRatio != null) {
            const pct = spreadType === 'call' ? config.atmRatioPctCall : config.atmRatioPctPut;
            const originalRatio = spread.sellQty;
            const diff = Math.max(0, entryAtmRatio - originalRatio);
            ratioToUse = Math.max(originalRatio, Math.round((originalRatio + (pct / 100) * diff) / 0.25) * 0.25);
          }

          const originalLotSize = spread.buyLeg.lotSize || 1;

          const sellLotSize = spread.sellLeg.lotSize || originalLotSize;
          let shortValue = spotPrice * ratioToUse * sellLotSize;

          let adjustedLotSize = originalLotSize;
          let adjustedSellQty = ratioToUse;
          let scale = 1;

          if (shortValue >= 200000) {
            scale = 200000 / shortValue;
            adjustedLotSize = Number((originalLotSize * scale).toFixed(2));
            adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
            shortValue = 200000;
          }

          const buyLegWithIv = {
            ...spread.buyLeg,
            lotSize: adjustedLotSize,
            entryIv: entryBuyIv,
            entryAtmRatio,
            entryBuyAtmPrice: buyIntrinsic,
            entrySellAtmPrice: sellIntrinsic,
            maxAtmRatio: entryAtmRatio,
            originalLotSize: spread.buyLeg.lotSize || 1,
            originalSellQty: ratioToUse,
            initialScaledLotSize: adjustedLotSize
          };
          const sellLegWithIv = { ...spread.sellLeg, entryIv: entrySellIv };

          const entryBuyFee = calculateFee(entryBuyPrice, spotPrice, adjustedLotSize, spread.buyLeg.lotSize || 1);
          const entrySellFee = calculateFee(entrySellPrice, spotPrice, adjustedSellQty, spread.sellLeg.lotSize);
          const entryFee = entryBuyFee + entrySellFee;
          const candidateMargin = calcMargin(entryBuyPrice, adjustedLotSize, spotPrice, adjustedSellQty, spread.sellLeg.lotSize);

          // Hard margin cap check per account
          const currentTotalMargin = remaining.reduce((sum, p) => sum + (p.margin || 0), 0);
          const stagedTotalMargin = newEntries.reduce((sum, p) => sum + (p.margin || 0), 0);
          if (currentTotalMargin + stagedTotalMargin + candidateMargin > (accountState.balance ?? 10000)) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Account balance margin cap exceeded. Deployed: $${(currentTotalMargin + stagedTotalMargin).toFixed(2)}, Candidate: $${candidateMargin.toFixed(2)}, Balance: $${(accountState.balance ?? 10000).toFixed(2)}`);
            continue;
          }

          const id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

          const newPos = {
            id, underlying, expiry: config.expiry, type: spreadType,
            buyLeg: buyLegWithIv, sellLeg: sellLegWithIv, sellQty: adjustedSellQty,
            strikeDiff: spread.strikeDiff, entryTime: new Date(),
            entryBuyPrice, entrySellPrice, entrySpotPrice: spotPrice,
            entryFee,
            margin: candidateMargin,
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
              account_id: accountState.id,
            }]);
            if (histError) logError(`[${accountState.name}] History insert error:`, histError.message);
          }

          // Delete from active (skip for leg swaps — they were updated in-place above)
          if (!t.exitReason?.startsWith('Leg Swap')) {
            await supabase.from('active_positions').delete().eq('id', t.id);
          }

          log(`[${accountState.name}] 📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (err) { logError(`[${accountState.name}] Exit persistence error:`, err); }
      }

      // Process entries
      if (!onlyExits) {
        for (const t of newEntries) {
          try {
            // DB-level count guard per account
            const { data: activeOfType, error: countError } = await supabase
              .from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type);
            if (!countError && (activeOfType?.length ?? 0) >= 3) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Active count on DB: ${activeOfType?.length ?? 0}`);
              continue;
            }

            // DB-level diversification guard check removed

            // Buy strike uniqueness per account
            const { data: buyConflict } = await supabase.from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .eq('buy_strike', t.buyLeg.strike).limit(1);
            if (buyConflict && buyConflict.length > 0) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Buy strike conflict on DB.`);
              continue;
            }

            // Sell strike uniqueness per account
            const { data: sellConflict } = await supabase.from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .eq('sell_strike', t.sellLeg.strike).limit(1);
            if (sellConflict && sellConflict.length > 0) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Sell strike conflict on DB.`);
              continue;
            }

            const { error: insertError } = await supabase.from('active_positions').insert([{
              id: t.id, underlying, expiry: config.expiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff,
              entry_time: t.entryTime.toISOString(),
              entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
              entry_spot_price: t.entrySpotPrice,
              margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
              buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
              account_id: accountState.id,
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
              log(`📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: ${ratioLong.toFixed(2)}:${t.sellQty} | Net: $${(t.sellQty * t.entrySellPrice - t.entryBuyPrice * ratioLong).toFixed(2)}`);
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

    } catch (e) {
      logError(`[${accountState.name}] Strategy evaluation error:`, e);
    } finally {
      isEvaluating = false;
      evaluationStart = 0;
      if (!onlyExits) {
        lastEvaluated = Date.now();
      }
    }
  }

  // ── Config hot-reload via Supabase Realtime ───────────────────────────

  function subscribeConfigChanges() {
    const channel = supabase
      .channel(`paper_config_changes_${accountState.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_config' },
        async (payload) => {
          const newRecord = payload.new;
          const oldRecord = payload.old;
          const relevantRecord = newRecord || oldRecord;
          if (relevantRecord && relevantRecord.account_id !== accountState.id) {
            return;
          }

          log(`[${accountState.name}] Config change detected — reloading...`);
          const oldUnderlying = config.underlying;
          const oldExpiry = config.expiry;
          await fetchConfig();

          // If underlying or expiry changed, restart WS and refresh products
          if (config.underlying !== oldUnderlying || config.expiry !== oldExpiry) {
            log(`[${accountState.name}] Config changed: ${oldUnderlying}/${oldExpiry} → ${config.underlying}/${config.expiry}`);
            await refreshProducts();
            await fetchActivePositions();
            tickerData = {};
            startWebSocket();
            tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
          }
        }
      )
      .subscribe();

    return channel;
  }

  // ── Main startup sequence ─────────────────────────────────────────────

  log(`[${accountState.name}] ═══════════════════════════════════════════`);
  log(`[${accountState.name}] Paper Trading Engine starting...`);
  log(`[${accountState.name}] ═══════════════════════════════════════════`);

  // 1. Load config
  await fetchConfig();

  // 2. Load products + expiry
  await refreshProducts();

  // 3. Fetch spot price
  await fetchSpot();
  if (spotPrice) log(`[${accountState.name}] Spot price: $${spotPrice.toFixed(2)}`);

  // 4. Fetch existing positions
  await fetchActivePositions();
  log(`[${accountState.name}] Active positions loaded: ${positions.length}`);

  // 5. Build symbol map and backfill tickers via REST
  symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
  tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
  log(`[${accountState.name}] Ticker backfill complete: ${Object.keys(tickerData).length} symbols`);

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
    try {
      if (!spotPrice || !config.expiry) return;

      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const lastMinute = Math.floor(lastEvaluated / 60000);

      if (currentMinute > lastMinute || lastEvaluated === 0) {
        await evaluateStrategy(false); // Full evaluation (exits + entries)
      } else {
        await evaluateStrategy(true);  // Exit-only evaluation
      }
    } catch (e) {
      logError(`[${accountState.name}] Error in evalTimer:`, e);
    }
  }, 1000);

  // Spot price polling — every 10 seconds
  const spotTimer = setInterval(async () => {
    try {
      await fetchSpot();
    } catch (e) {
      logError(`[${accountState.name}] Error in spotTimer:`, e);
    }
  }, 10000);

  // Product refresh — every 5 minutes
  const productTimer = setInterval(async () => {
    try {
      await refreshProducts();
      // Rebuild symbol meta and restart WS if needed
      const newMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
      const newSymbols = Object.keys(newMeta).sort().join(',');
      const oldSymbols = Object.keys(symbolMeta).sort().join(',');
      if (newSymbols !== oldSymbols) {
        symbolMeta = newMeta;
        startWebSocket();
      }
    } catch (e) {
      logError(`[${accountState.name}] Error in productTimer:`, e);
    }
  }, 5 * 60 * 1000);

  // Active positions refresh — every 30 seconds (fallback sync)
  const positionsTimer = setInterval(async () => {
    try {
      await fetchActivePositions();
    } catch (e) {
      logError(`[${accountState.name}] Error in positionsTimer:`, e);
    }
  }, 30000);

  log(`[${accountState.name}] Paper Trading Engine is LIVE`);

  // ── Return cleanup function ───────────────────────────────────────────
  return {
    async stop(isDeleted = false) {
      log(`[${accountState.name}] Paper Trading Engine shutting down... (isDeleted: ${isDeleted})`);
      clearInterval(evalTimer);
      clearInterval(spotTimer);
      clearInterval(productTimer);
      clearInterval(positionsTimer);
      if (wsHandle) { wsHandle.close(); wsHandle = null; }
      supabase.removeChannel(configChannel);
      
      await heartbeat.stop(isDeleted);
      
      log(`[${accountState.name}] Paper Trading Engine stopped.`);
    },
    updateAccount(newAccount) {
      accountState = newAccount;
      log(`[${accountState.name}] Account state updated (new balance: $${accountState.balance})`);
    }
  };
}

// ── Multi-Account Engine Manager ──────────────────────────────────────

export async function startPaperTradingEngine() {
  const runningEngines = {}; // accountId -> engineHandle

  async function startAccountEngine(account) {
    const accountId = account.id;
    if (runningEngines[accountId]) {
      logWarn(`Account engine ${accountId} (${account.name}) is already running.`);
      return;
    }
    log(`Starting engine for account ${accountId} (${account.name})...`);
    try {
      const handle = await startSingleAccountEngine(account);
      runningEngines[accountId] = handle;
    } catch (e) {
      logError(`Failed to start engine for account ${accountId}:`, e);
    }
  }

  async function stopAccountEngine(accountId, isDeleted = false) {
    const handle = runningEngines[accountId];
    if (handle) {
      log(`Stopping engine for account ${accountId}... (isDeleted: ${isDeleted})`);
      try {
        await handle.stop(isDeleted);
      } catch (e) {
        logError(`Error stopping engine for account ${accountId}:`, e);
      }
      delete runningEngines[accountId];
    }
  }

  // Fetch all active accounts
  const { data: accounts, error } = await supabase
    .from('paper_trading_accounts')
    .select('*')
    .eq('is_active', true);

  if (error) {
    logError('Failed to fetch paper trading accounts:', error.message);
  } else if (accounts) {
    for (const acc of accounts) {
      await startAccountEngine(acc);
    }
  }

  // Subscribe to paper_trading_accounts changes
  const accountsChannel = supabase
    .channel('paper_trading_accounts_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'paper_trading_accounts' },
      async (payload) => {
        const { eventType, new: newRecord, old: oldRecord } = payload;
        log(`Account change event detected: ${eventType}`);

        if (eventType === 'INSERT') {
          if (newRecord.is_active) {
            await startAccountEngine(newRecord);
          }
        } else if (eventType === 'DELETE') {
          await stopAccountEngine(oldRecord.id, true);
        } else if (eventType === 'UPDATE') {
          if (!newRecord.is_active) {
            await stopAccountEngine(newRecord.id);
          } else {
            if (!runningEngines[newRecord.id]) {
              await startAccountEngine(newRecord);
            } else {
              runningEngines[newRecord.id].updateAccount(newRecord);
            }
          }
        }
      }
    )
    .subscribe();

  // Periodic sync check — every 30 seconds as fallback for missed Realtime events
  const syncTimer = setInterval(async () => {
    try {
      const { data: currentAccounts, error: syncError } = await supabase
        .from('paper_trading_accounts')
        .select('*');
      
      if (syncError || !currentAccounts) {
        logError('Fallback sync: failed to fetch accounts:', syncError?.message);
        return;
      }

      const activeAccounts = currentAccounts.filter(a => a.is_active);
      const activeIds = new Set(activeAccounts.map(a => a.id));

      // 1. Stop engines that are no longer active or have been deleted
      for (const accountId of Object.keys(runningEngines)) {
        if (!activeIds.has(accountId)) {
          const stillExists = currentAccounts.some(a => a.id === accountId);
          log(`Fallback sync: Account ${accountId} is no longer active or deleted. Stopping engine.`);
          await stopAccountEngine(accountId, !stillExists);
        }
      }

      // 2. Start engines for active accounts that are not running, and update state for running ones
      for (const acc of activeAccounts) {
        const running = runningEngines[acc.id];
        if (!running) {
          log(`Fallback sync: Account ${acc.id} (${acc.name}) is active but not running. Starting engine.`);
          await startAccountEngine(acc);
        } else {
          running.updateAccount(acc);
        }
      }
    } catch (e) {
      logError('Fallback sync exception:', e);
    }
  }, 30000);

  return {
    async stop() {
      log('Shutting down all running account engines...');
      clearInterval(syncTimer);
      supabase.removeChannel(accountsChannel);
      for (const accountId of Object.keys(runningEngines)) {
        await stopAccountEngine(accountId);
      }
      log('All account engines shut down.');
    }
  };
}
