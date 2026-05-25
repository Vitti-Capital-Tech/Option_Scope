/**
 * ATM Exit Trading Engine — Server-Side
 *
 * Headless Node.js version of ATMExitTrading.jsx's evaluateStrategy.
 * Simplified compared to Paper Trading:
 * - No partial exits / multi-stage scale-out
 * - No leg swaps
 * - 100% exit at ATM only
 * - Self-contained scanner
 * - Bucketed analytics aggregation on every exit
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

const ENGINE_ID = 'atm_exit';

// ── Analytics helpers ─────────────────────────────────────────────────

function getQtyTable(sellQty) {
  if (sellQty <= 2.5) return 'atm_exit_qty_0_2_5';
  if (sellQty <= 5) return 'atm_exit_qty_2_5_5';
  if (sellQty <= 7.5) return 'atm_exit_qty_5_7_5';
  return 'atm_exit_qty_7_5_10';
}

async function upsertAnalytics(trade) {
  try {
    const tableName = getQtyTable(trade.sellQty);
    const netPremium = (trade.entryBuyPrice || 0) - (trade.sellQty || 0) * (trade.entrySellPrice || 0);
    const strikeDiff = Math.round((trade.strikeDiff || 0) / 100) * 100;

    const { data: existing } = await supabase
      .from(tableName).select('*')
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
  } catch (e) { logError('Analytics upsert error:', e); }
}

// ── Main engine ─────────────────────────────────────────────────────────

export async function startAtmExitEngine() {
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
  let positions = [];
  let tickerData = {};
  let wsHandle = null;
  let symbolMeta = {};
  let lastEvaluated = 0;
  let isEvaluating = false;
  let lastDbWrite = 0;

  // ── Supabase data fetchers ────────────────────────────────────────────

  async function fetchConfig() {
    try {
      const { data, error } = await supabase
        .from('atm_exit_config').select('*').eq('id', 'global').maybeSingle();
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
        log(`[ATM] Config loaded: ${config.underlying} | Expiry: ${config.expiry || 'auto'}`);
      }
    } catch (e) { logError('[ATM] Config fetch error', e); }
  }

  async function fetchActivePositions() {
    try {
      if (Date.now() - lastDbWrite < 10000) return;
      const { data, error } = await supabase
        .from('atm_exit_active_positions').select('*')
        .order('entry_time', { ascending: true });

      if (error) { logError('[ATM] Fetch positions error', error); return; }

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
            margin: p.margin || 0, entryFee: p.entry_fee || 0,
            accumulatedSellPnl: p.accumulated_sell_pnl || 0,
          };
        }).filter(p => p.buyLeg && p.sellLeg);
      } else if (data) {
        positions = [];
      }
    } catch (e) { logError('[ATM] Fetch positions exception', e); }
  }

  async function refreshProducts() {
    try {
      const prods = await loadProducts(config.underlying);
      products = prods;
      expiries = getExpiries(prods);
      if (expiries.length && (!config.expiry || !expiries.includes(config.expiry))) {
        config.expiry = expiries[0];
        log(`[ATM] Expiry auto-selected: ${config.expiry}`);
        await supabase.from('atm_exit_config').upsert({
          id: 'global', expiry: config.expiry, updated_at: new Date().toISOString()
        });
      }
    } catch (e) { logError('[ATM] Product refresh error', e); }
  }

  async function fetchSpot() {
    try {
      const sp = await getSpotPrice(config.underlying);
      if (sp) { spotPrice = sp; lastSpotUpdate = Date.now(); }
    } catch (e) { /* ignore */ }
  }

  function startWebSocket() {
    if (!config.expiry || !products.length) return;
    symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
    const allSymbols = Object.keys(symbolMeta);
    if (allSymbols.length < 2) { logWarn('[ATM] Not enough symbols for WS'); return; }

    if (wsHandle) { try { wsHandle.close(); } catch (e) { } wsHandle = null; }

    log(`[ATM] Starting WS: ${allSymbols.length} symbols`);

    wsHandle = createTickerStream(
      allSymbols,
      (msg) => {
        const processed = processTickerMessage(msg, symbolMeta, tickerData);
        if (processed) tickerData[processed.symbol] = processed;
      },
      (status) => {
        const mappedWsStatus = status === 'live' ? 'live' : 'reconnecting';
        heartbeat.update({ ws_status: mappedWsStatus });
        if (status === 'live') log('[ATM] WebSocket connected');
        else if (status === 'disconnected') logWarn('[ATM] WebSocket disconnected — reconnecting...');
      }
    );
  }

  // ── Core strategy evaluation ──────────────────────────────────────────

  async function evaluateStrategy(onlyExits = false) {
    if (isEvaluating || !spotPrice) return;

    // Spot staleness guard
    const spotAge = Date.now() - lastSpotUpdate;
    if (lastSpotUpdate > 0 && spotAge > 120000) {
      logWarn(`[ATM] Spot stale (${Math.round(spotAge / 1000)}s). Skipping evaluation.`);
      return;
    }

    isEvaluating = true;

    try {
      const allTickers = Object.values(tickerData);
      if (allTickers.length === 0) return;

      const underlying = config.underlying;
      const selExpiry = config.expiry;

      // ATM strike
      let atmStrike = null, minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      // Scan
      const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));
      const topSpreads = [...scanTickers(callTickers, config, spotPrice), ...scanTickers(putTickers, config, spotPrice)];
      const uniqueTopSpreads = [
        ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'call'), 10),
        ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'put'), 10)
      ];

      const activeCallsCount = positions.filter(p => p.type === 'call' && p.underlying === underlying).length;
      const activePutsCount = positions.filter(p => p.type === 'put' && p.underlying === underlying).length;
      let callRotationsApproved = 0, putRotationsApproved = 0;
      const MAX_ROTATIONS = 3;

      const remaining = [], exited = [];
      const sortedPositions = [...positions].sort((a, b) =>
        Math.abs(b.buyLeg.strike - spotPrice) - Math.abs(a.buyLeg.strike - spotPrice)
      );

      // ── Exit evaluation ─────────────────────────────────────────────────
      for (const pos of sortedPositions) {
        if (pos.underlying !== underlying) { remaining.push(pos); continue; }

        const tickerBuy = tickerData[pos.buyLeg.symbol];
        const tickerSell = tickerData[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice;
        if (liveExitBuy == null || liveExitSell == null) { remaining.push(pos); continue; }

        const latestBuy = liveExitBuy, latestSell = liveExitSell;
        let shouldExit = false, exitReason = '', zombieExitTime = null;

        // Expiry
        const expiryTs = new Date(pos.expiry).getTime();
        if (Date.now() >= expiryTs - 120000) {
          shouldExit = true; exitReason = 'Expiry Reached';
          if (Date.now() > expiryTs + 600000) zombieExitTime = new Date(expiryTs).toISOString();
        }

        // PnL
        const buyPriceDiff = (latestBuy - pos.entryBuyPrice) || 0;
        const sellPriceDiff = (latestSell - pos.entrySellPrice) || 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) - (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);
        const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        // Rotation check
        const inTop3 = uniqueTopSpreads.some(s => s.buyLeg.type === pos.type && Number(s.buyLeg.strike) === Number(pos.buyLeg.strike));
        if (!shouldExit && pos.expiry === selExpiry && uniqueTopSpreads.length > 0 && !inTop3) {
          shouldExit = true; exitReason = 'Lost Top 3';
        }

        // ATM exit
        if (!shouldExit) {
          const isCall = pos.type === 'call';
          const isAtmMET = isCall ? spotPrice >= pos.buyLeg.strike : spotPrice <= pos.buyLeg.strike;
          if (isAtmMET) { shouldExit = true; exitReason = 'Full Exit @ ATM'; }
        }

        // Rotation threshold guard
        const canRotate = pos.type === 'call'
          ? (activeCallsCount >= 3 && callRotationsApproved < MAX_ROTATIONS)
          : (activePutsCount >= 3 && putRotationsApproved < MAX_ROTATIONS);
        let rotationApproved = false;

        if (!canRotate && exitReason.includes('Lost Top 3')) { shouldExit = false; }
        else if (canRotate && exitReason.includes('Lost Top 3') && shouldExit) {
          rotationApproved = true;
          if (pos.type === 'call') callRotationsApproved++; else putRotationsApproved++;
        }

        if (shouldExit) {
          if (exitReason.includes('Lost Top 3') && !rotationApproved) {
            shouldExit = false;
            remaining.push(pos);
            continue;
          }

          const tradeRecord = {
            ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell,
            exitSpotPrice: spotPrice, realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees,
            entryFee: pos.entryFee || 0, exitFee, totalFees, exitReason,
            _latestBuy: latestBuy, _latestSell: latestSell, zombieExitTime,
          };
          exited.push(tradeRecord);
        } else {
          remaining.push(pos);
        }
      }

      // ── Entry evaluation ────────────────────────────────────────────────
      const newEntries = [];

      if (!onlyExits) {
        for (const spread of topSpreads) {
          const spreadType = spread.buyLeg.type;
          const count = remaining.filter(p => p.underlying === underlying && p.type === spreadType).length +
            newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
          if (count >= 3) continue;

          const minutesToExpiry = (new Date(config.expiry).getTime() - Date.now()) / 60000;
          if (minutesToExpiry < 5) continue;

          const candidateLongStrike = Number(spread.buyLeg.strike);
          const existingOfType = remaining.filter(p => p.underlying === underlying && p.type === spreadType);

          // 0.5% spot scaling guard
          let validSpotMove = true;
          for (const p of existingOfType) {
            if (p.entrySpotPrice) {
              const thresh = Math.round((p.entrySpotPrice * 0.005) / 100) * 100;
              const spotValid = spreadType === 'call'
                ? spotPrice <= p.entrySpotPrice - thresh
                : spotPrice >= p.entrySpotPrice + thresh;
              if (!spotValid) { validSpotMove = false; break; }
            }
          }
          if (!validSpotMove) continue;

          // 400pt diversification
          let validStrikeDiff = true;
          for (const p of existingOfType) {
            if (Math.abs(candidateLongStrike - Number(p.buyLeg.strike)) < 400) { validStrikeDiff = false; break; }
          }
          if (!validStrikeDiff) continue;

          // Strike collision
          const buyConflict = [...remaining, ...newEntries].some(p =>
            p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === candidateLongStrike
          );
          const sellConflict = [...remaining, ...newEntries].some(p =>
            p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === Number(spread.sellLeg.strike)
          );
          if (buyConflict || sellConflict) continue;

          const entryFee = calculateFee(spread.buyPrice, spotPrice, 1, spread.buyLeg.lotSize) +
            calculateFee(spread.sellPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
          const id = `ATM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

          newEntries.push({
            id, underlying, expiry: config.expiry, type: spreadType,
            buyLeg: spread.buyLeg, sellLeg: spread.sellLeg, sellQty: spread.sellQty,
            strikeDiff: spread.strikeDiff, entryTime: new Date(),
            entryBuyPrice: spread.buyPrice, entrySellPrice: spread.sellPrice,
            entrySpotPrice: spotPrice, entryFee,
            margin: calcMargin(spread.buyPrice, spread.buyLeg.lotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize),
          });
        }
      }

      // ── Supabase side effects ─────────────────────────────────────────
      if (exited.length > 0 || newEntries.length > 0) lastDbWrite = Date.now();

      for (const t of exited) {
        try {
          await upsertAnalytics(t);
          const { data: existing } = await supabase.from('atm_exit_trade_history')
            .select('trade_id').eq('trade_id', t.id).maybeSingle();
          if (!existing) {
            await supabase.from('atm_exit_trade_history').insert([{
              trade_id: t.id, underlying, expiry: t.expiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff,
              entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
              entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice,
              margin: t.margin, exit_time: t.zombieExitTime || new Date().toISOString(),
              exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell,
              exit_spot_price: t.exitSpotPrice, realized_gross_pnl: t.realizedGrossPnl,
              realized_net_pnl: t.realizedNetPnl, exit_fee: t.exitFee, total_fees: t.totalFees,
              exit_reason: t.exitReason,
            }]);
          }
          await supabase.from('atm_exit_active_positions').delete().eq('id', t.id);
          log(`[ATM] 📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (e) { logError('[ATM] Exit persistence error:', e); }
      }

      if (!onlyExits) {
        for (const t of newEntries) {
          try {
            const { data } = await supabase.from('atm_exit_active_positions').select('id')
              .eq('underlying', underlying).eq('type', t.type);
            if (data?.length >= 3) continue;

            await supabase.from('atm_exit_active_positions').insert([{
              id: t.id, underlying, expiry: config.expiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff,
              entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
              entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice,
              margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
              buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
            }]);
            log(`[ATM] 📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: 1:${t.sellQty}`);
          } catch (e) { logError('[ATM] Entry persistence error:', e); }
        }
      }

      positions = [...remaining, ...newEntries];
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

  // ── Config hot-reload ─────────────────────────────────────────────────

  function subscribeConfigChanges() {
    return supabase
      .channel('atm_exit_config_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'atm_exit_config' }, async () => {
        log('[ATM] Config change detected — reloading...');
        const oldUnderlying = config.underlying;
        const oldExpiry = config.expiry;
        await fetchConfig();
        if (config.underlying !== oldUnderlying || config.expiry !== oldExpiry) {
          await refreshProducts();
          tickerData = {};
          startWebSocket();
          await fetchActivePositions();
        }
      })
      .subscribe();
  }

  // ── Main startup ──────────────────────────────────────────────────────

  log('═══════════════════════════════════════════');
  log('ATM Exit Engine starting...');
  log('═══════════════════════════════════════════');

  await fetchConfig();
  await refreshProducts();
  await fetchSpot();
  if (spotPrice) log(`[ATM] Spot price: $${spotPrice.toFixed(2)}`);

  await fetchActivePositions();
  log(`[ATM] Active positions loaded: ${positions.length}`);

  symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
  tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
  log(`[ATM] Ticker backfill: ${Object.keys(tickerData).length} symbols`);

  startWebSocket();

  heartbeat.update({
    underlying: config.underlying, expiry: config.expiry,
    active_positions: positions.length, spot_price: spotPrice,
  });
  await heartbeat.start();

  const configChannel = subscribeConfigChanges();

  const evalTimer = setInterval(async () => {
    if (!spotPrice || !config.expiry) return;
    const currentMinute = Math.floor(Date.now() / 60000);
    const lastMinute = Math.floor(lastEvaluated / 60000);
    if (currentMinute > lastMinute || lastEvaluated === 0) {
      await evaluateStrategy(false); // Full evaluation (exits + entries)
    } else {
      await evaluateStrategy(true);  // Exit-only evaluation
    }
  }, 1000);

  const spotTimer = setInterval(fetchSpot, 10000);
  const productTimer = setInterval(async () => {
    await refreshProducts();
    const newMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
    const newSymbols = Object.keys(newMeta).sort().join(',');
    const oldSymbols = Object.keys(symbolMeta).sort().join(',');
    if (newSymbols !== oldSymbols) { symbolMeta = newMeta; startWebSocket(); }
  }, 5 * 60 * 1000);
  const positionsTimer = setInterval(fetchActivePositions, 30000);

  log('[ATM] ATM Exit Engine is LIVE');

  return {
    async stop() {
      log('[ATM] ATM Exit Engine shutting down...');
      clearInterval(evalTimer);
      clearInterval(spotTimer);
      clearInterval(productTimer);
      clearInterval(positionsTimer);
      if (wsHandle) { wsHandle.close(); wsHandle = null; }
      supabase.removeChannel(configChannel);
      await heartbeat.stop();
      log('[ATM] ATM Exit Engine stopped.');
    }
  };
}
