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
import { supabase, hasServiceRole } from './lib/supabase.js';
import { createHeartbeat } from './lib/heartbeat.js';
import { createLiveExecutor, isLiveDryRun, longContracts, shortContracts, extractBalance } from './lib/liveExecution.js';
import { getBalance } from './lib/deltaTradeApi.js';
import {
  loadProducts, getExpiries, getSpotPrice,
  createTickerStream, buildSymbolMeta, processTickerMessage,
  backfillTickers, getOptionHigh
} from './lib/deltaApi.js';
import {
  safeParseLeg, calculateFee, calcMargin, scanTickers,
  computeEntryAtmRatio, computeScaledSellQty,
  pickTopUniqueStrikes, log, logWarn, logError
} from './lib/utils.js';

/**
 * Build `count` equidistant exit price levels (sorted ascending) spanning the
 * long option's current bid up to `upperBound` (= max(entry, last 1-2hr high)).
 * Used to scale a held long-only leg out as its bid recovers. Levels are evenly
 * spaced: the first sits one step above the current bid and the last lands on
 * the upper bound, so each slice needs a distinct price move (no clustering).
 * If the range is degenerate (current already >= upperBound), every level
 * collapses to the upper bound so the whole long exits as soon as it's evaluated.
 */
function buildLongExitLevels(currentBid, upperBound, count = 10) {
  const lo = currentBid ?? 0;
  const hi = Math.max(lo, upperBound);
  if (count <= 1) {
    return [Number(hi.toFixed(2))];
  }
  if (!(hi > lo)) {
    return Array(count).fill(Number(hi.toFixed(2)));
  }
  const step = (hi - lo) / (count - 1);
  const levels = [];
  for (let i = 0; i < count; i++) {
    levels.push(Number((lo + i * step).toFixed(2)));
  }
  return levels;
}

async function getOrBuildLongExitLevels(longBid, pos, config) {
  if (config.variableExitSlices) {
    let upper = pos.entryBuyPrice;
    try {
      const pastHigh = await getOptionHigh(pos.buyLeg.symbol, 4);
      if (pastHigh != null) {
        upper = pastHigh;
      }
    } catch (e) {
      logWarn(`Failed to fetch 4h high for ${pos.buyLeg.symbol}: ${e.message}`);
    }
    return buildLongExitLevels(longBid, upper, config.longExitSlices ?? 10);
  } else {
    if (longBid < 25) {
      return [10, 20, 30, 40, 50];
    } else {
      return [25, 50, 75, 100, 125];
    }
  }
}

/**
 * Index price level that triggers the live SL (short) / TP (long), derived from
 * the account's exitType/exitPoints relative to the buy strike — the same
 * geometry as the paper ATM/ITM/OTM full-exit rule, but enforced on the exchange
 * as a spot-triggered stop. TP and SL share this one level.
 */
function computeIndexTriggerLevel(type, buyStrike, cfg) {
  const exitType = cfg.exitType || 'ATM';
  const pts = Math.abs(cfg.exitPoints || 0);
  const isCall = type === 'call';
  if (exitType === 'ITM') return isCall ? buyStrike + pts : buyStrike - pts;
  if (exitType === 'OTM') return isCall ? buyStrike - pts : buyStrike + pts;
  return buyStrike; // ATM
}

/** True once the index (spot) has reached the trigger level for this option type. */
function isIndexTriggerMet(type, level, spot) {
  if (level == null || spot == null) return false;
  return type === 'call' ? spot >= level : spot <= level;
}

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
    atmRatioScaling: true,
    atmRatioPctCall: 50,
    atmRatioPctPut: 25,
    daysToExpiry: 0,
    numberOfCalls: 3,
    numberOfPuts: 3,
    spotDiff: 0.5,
    exitType: 'ATM',
    exitPoints: 0,
    shortExitPrice: 1.1,
    longExitSlices: 10,
    balanceAllocationPct: 90,
    entryBuyOffset: 5,
    entrySellOffset: 2
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
  let schedules = []; // Time-based schedule windows

  // ── Live trading (Delta Exchange) ─────────────────────────────────────
  let liveCreds = null; // { apiKey, apiSecret } for mode==='live', else null
  const live = createLiveExecutor(() => ({
    accountName: accountState.name,
    mode: accountState.mode,
    liveEnabled: accountState.live_enabled,
    creds: liveCreds,
  }));

  // Load + decrypt Delta credentials for live accounts. Requires the engine to
  // run with the service_role key; otherwise live trading stays disabled.
  async function loadCredentials() {
    if (accountState.mode !== 'live') { liveCreds = null; return; }
    if (!hasServiceRole) {
      liveCreds = null;
      logWarn(`[${accountState.name}] Live account but engine lacks service_role key — live trading disabled.`);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('get_delta_credentials_decrypted', {
        p_account_id: accountState.id,
      });
      if (error) {
        liveCreds = null;
        logError(`[${accountState.name}] Failed to load Delta credentials:`, error.message);
        return;
      }
      if (data && data[0] && data[0].api_key && data[0].api_secret) {
        liveCreds = { apiKey: data[0].api_key, apiSecret: data[0].api_secret };
        log(`[${accountState.name}] Delta credentials loaded. Armed: ${accountState.live_enabled ? 'YES' : 'no (kill-switch off)'} | Dry-run: ${isLiveDryRun() ? 'ON' : 'OFF'}`);
      } else {
        liveCreds = null;
        logWarn(`[${accountState.name}] Live mode but no stored credentials found.`);
      }
    } catch (e) {
      liveCreds = null;
      logError(`[${accountState.name}] Credential load exception:`, e);
    }
  }

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
          atm_ratio_scaling: true,
          atm_ratio_distance_call: 50,
          atm_ratio_distance_put: 25,
          days_to_expiry: 0,
          number_of_calls: 3,
          number_of_puts: 3,
          spot_diff: 0.5,
          exit_type: 'ATM',
          exit_points: 0,
          leg_swap_premium: 0,
          short_exit_price: 1.1,
          long_exit_slices: 10,
          variable_exit_slices: false,
          balance_allocation_pct: 90,
          entry_buy_offset: 5,
          entry_sell_offset: 2,
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
          atmRatioScaling: data.atm_ratio_scaling ?? true,
          atmRatioPctCall: data.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: data.atm_ratio_distance_put ?? 25,
          daysToExpiry: data.days_to_expiry ?? 0,
          numberOfCalls: data.number_of_calls ?? 3,
          numberOfPuts: data.number_of_puts ?? 3,
          spotDiff: data.spot_diff ?? 0.5,
          exitType: data.exit_type ?? 'ATM',
          exitPoints: data.exit_points ?? 0,
          shortExitPrice: data.short_exit_price ?? 1.1,
          longExitSlices: data.long_exit_slices ?? 10,
          variableExitSlices: data.variable_exit_slices ?? false,
          balanceAllocationPct: data.balance_allocation_pct ?? 90,
          entryBuyOffset: data.entry_buy_offset ?? 5,
          entrySellOffset: data.entry_sell_offset ?? 2
        };
        configDbId = data.id;
        // log(`[${accountState.name}] Config loaded: ${config.underlying} | Expiry: ${config.expiry || 'auto'}`);
      }
    } catch (e) { logError(`[${accountState.name}] Config fetch error`, e); }
  }

  // ── Schedule fetcher ────────────────────────────────────────────────────

  async function fetchSchedules() {
    try {
      const { data, error } = await supabase
        .from('paper_trading_schedules')
        .select('*')
        .eq('account_id', accountState.id)
        .order('sort_order', { ascending: true });
      if (error) {
        logError(`[${accountState.name}] Fetch schedules error`, error);
        return;
      }
      if (data) {
        schedules = data.map(s => ({
          id: s.id,
          label: s.label || 'Window',
          startTime: s.start_time,  // 'HH:MM' IST
          endTime: s.end_time,      // 'HH:MM' IST
          numberOfCalls: s.number_of_calls ?? 3,
          numberOfPuts: s.number_of_puts ?? 3,
          minLongDist: s.min_long_dist ?? 500,
          minStrikeDiff: s.min_strike_diff ?? 800,
          atmRatioScaling: s.atm_ratio_scaling ?? true,
          atmRatioPctCall: s.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: s.atm_ratio_distance_put ?? 25,
          spotDiff: s.spot_diff ?? 0.5,
          isActive: s.is_active ?? true,
        }));
      }
    } catch (e) { logError(`[${accountState.name}] Schedule fetch error`, e); }
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

      const currentDaysRemaining = config.expiry ? (new Date(config.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000) : 0;
      const isExpiryStale = config.expiry && currentDaysRemaining < (config.daysToExpiry || 0);

      if (expiries.length && (!config.expiry || !expiries.includes(config.expiry) || isExpiryStale)) {
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
        if (selectedExpiry !== config.expiry) {
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

  // Returns active schedule window for current IST time (UTC + 5:30), or null if none match
  function getActiveSchedule() {
    const now = new Date();
    // Convert current UTC time to IST (UTC + 5:30)
    const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;

    for (const s of schedules) {
      if (!s.isActive) continue;
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      // Handle overnight windows (e.g. 22:00 -> 06:00)
      if (startMin > endMin) {
        if (istMin >= startMin || istMin < endMin) return s;
      } else {
        if (istMin >= startMin && istMin < endMin) return s;
      }
    }
    return null;
  }

  // Peak concurrent positions the account can hold — the max of (calls + puts)
  // across the base config and every active schedule window. Used to divide the
  // allocated balance into equal "parts" (1 part of margin per position).
  function computeMaxPositions() {
    let mx = (config.numberOfCalls || 0) + (config.numberOfPuts || 0);
    for (const s of schedules) {
      if (!s.isActive) continue;
      mx = Math.max(mx, (s.numberOfCalls || 0) + (s.numberOfPuts || 0));
    }
    return Math.max(1, mx);
  }

  // ── Live exit handling (armed live accounts only) ────────────────────────
  // Replaces the paper simulated exits. Exits are driven by the shared index
  // trigger level (exitType/exitPoints vs buy strike): SHORT closes first (SL),
  // then the LONG (TP) at the same level. In dry-run the index crossing itself is
  // the fill signal; when armed, the resting exchange orders fill and we detect it
  // via the exchange position size dropping to 0. Books trade_history directly and
  // pushes surviving (long-only) positions back into `remaining`.
  async function handleLiveExit(pos, remaining, sizeBySymbol) {
    const tickerBuy = tickerData[pos.buyLeg.symbol];
    const tickerSell = tickerData[pos.sellLeg.symbol];
    const longBid = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
    const shortAsk = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

    const triggerLevel = pos.sellLeg?.slTriggerLevel != null
      ? pos.sellLeg.slTriggerLevel
      : computeIndexTriggerLevel(pos.type, pos.buyLeg.strike, config);

    // Expiry settlement — exchange cash-settles; just close the books, no orders.
    const expiryTs = new Date(pos.expiry).getTime();
    const atExpiry = Date.now() >= expiryTs - 120000;

    const triggerMet = isIndexTriggerMet(pos.type, triggerLevel, spotPrice);
    let shortFilled, longFilled;
    if (live.dryRun) {
      shortFilled = pos.sellQty > 0 && triggerMet;
      longFilled = pos.sellQty === 0 && triggerMet;
    } else {
      // Fill-by-absence: a leg missing from the exchange = filled. But "absent"
      // ALSO describes a leg that never opened, or one whose symbol we can't match
      // in the positions response. Only trust absence as a fill for a leg we have
      // actually SEEN open (size≠0) on the exchange first — otherwise we'd phantom-
      // exit a position that is really still open (leaving a naked leg on Delta).
      const shortRaw = sizeBySymbol[pos.sellLeg.symbol];
      const longRaw = sizeBySymbol[pos.buyLeg.symbol];
      const shortSize = Math.abs(shortRaw ?? 0);
      const longSize = Math.abs(longRaw ?? 0);
      shortFilled = pos.sellQty > 0 && pos._shortConfirmedOpen === true && shortSize === 0;
      longFilled = pos.sellQty === 0 && pos._longConfirmedOpen === true && longSize === 0;

      // Diagnostic: log whenever a fill is inferred OR a held leg is unexpectedly
      // absent-but-never-confirmed (the phantom-exit signature). Tells (B1) symbol
      // mismatch / unlisted leg (ABSENT, never confirmed) apart from (B2) a real
      // close (was confirmed open, size dropped to 0).
      const suspicious = (pos.sellQty > 0 && shortSize === 0 && !pos._shortConfirmedOpen)
        || (pos.sellQty === 0 && longSize === 0 && !pos._longConfirmedOpen);
      if (shortFilled || longFilled || suspicious) {
        log(`[${accountState.name}] 🔎 Live fill-check ${pos.id} (${pos.type} ${pos.buyLeg.strike}/${pos.sellLeg.strike}): ` +
          `short ${pos.sellLeg.symbol}=${shortRaw ?? 'ABSENT'}${pos._shortConfirmedOpen ? '' : ' (never-confirmed)'} · ` +
          `long ${pos.buyLeg.symbol}=${longRaw ?? 'ABSENT'}${pos._longConfirmedOpen ? '' : ' (never-confirmed)'} · ` +
          `exchange returned ${Object.keys(sizeBySymbol).length} leg(s) → ` +
          `${shortFilled ? 'SHORT-FILL' : longFilled ? 'LONG-FILL' : 'HELD (phantom avoided)'}`);
      }
    }

    // ── Short SL filled → book short exit, convert to long-only, arm long TP ──
    if (shortFilled && !atExpiry) {
      const shortLot = pos.sellLeg.lotSize || 1;
      const exitShortPrice = shortAsk;
      if (exitShortPrice == null) { remaining.push(pos); return; }
      lastDbWrite = Date.now();
      const gross = (pos.entrySellPrice - exitShortPrice) * pos.sellQty * shortLot;
      const entryFee = Math.min(pos.entryFee || 0, calculateFee(pos.entrySellPrice, pos.entrySpotPrice, pos.sellQty, shortLot));
      const exitFee = calculateFee(exitShortPrice, spotPrice, pos.sellQty, shortLot);
      const net = gross - (entryFee + exitFee);
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: `${pos.id}-LSL`,
          underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: 0 }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, exitIv: tickerSell?.askIv ?? tickerSell?.iv ?? null }),
          sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: longBid, exit_sell_price: exitShortPrice, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: `Live Short SL @ index ${triggerLevel}`, is_partial: true, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
      } catch (e) { logError(`[${accountState.name}] Live short SL booking failed for ${pos.id}:`, e); }

      pos.entryFee = Math.max(0, (pos.entryFee || 0) - entryFee);
      pos.sellLeg = { ...pos.sellLeg, lotSize: 0 };
      pos.sellQty = 0;

      const tpRes = await live.placeStop({
        symbol: pos.buyLeg.symbol, side: 'sell',
        contracts: longContracts(pos.buyLeg), stopPrice: triggerLevel, tag: `${pos.id}-TP`,
      });
      pos.buyLeg = { ...pos.buyLeg, tpOrderId: tpRes?.order?.id ?? pos.buyLeg.tpOrderId ?? null, longExitBaseLot: pos.buyLeg.lotSize };
      pos.margin = calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, spotPrice, 0, 1);
      try {
        await supabase.from('active_positions').update({
          buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          sell_qty: 0, entry_fee: pos.entryFee, margin: pos.margin,
        }).eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Live short SL update failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] ✂️ LIVE SHORT SL: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}/${pos.sellLeg.strike} @ index ${triggerLevel} | PnL $${net.toFixed(2)} → long TP armed`);
      remaining.push(pos);
      return;
    }

    // ── Long TP filled (or expiry) → book long exit, delete position ──
    if (longFilled || atExpiry) {
      const exitLong = longBid;
      // If we have no quote and it isn't an expiry settlement, wait for one.
      if (exitLong == null && !atExpiry) { remaining.push(pos); return; }
      lastDbWrite = Date.now();
      const lot = pos.buyLeg.lotSize || 0;
      const px = exitLong ?? pos.entryBuyPrice;
      const gross = (px - pos.entryBuyPrice) * lot;
      const entryFee = pos.entryFee || 0;
      const exitFee = calculateFee(px, spotPrice, lot, pos.buyLeg.originalLotSize || 1);
      const net = gross - (entryFee + exitFee);
      const reason = atExpiry ? 'Live Expiry Settlement' : `Live Long TP @ index ${triggerLevel}`;
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: `${pos.id}-LTP`,
          underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
          sell_qty: 0, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: px, exit_sell_price: null, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: reason, is_partial: false, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
        await supabase.from('active_positions').delete().eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Live long TP booking failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] 🎯 LIVE ${atExpiry ? 'EXPIRY' : 'LONG TP'}: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} @ index ${triggerLevel} | PnL $${net.toFixed(2)}`);
      return; // closed — not pushed to remaining
    }

    // No fill yet — hold.
    remaining.push(pos);
  }

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

      // ── Apply active time-schedule overrides ──────────────────────────
      const activeSchedule = getActiveSchedule();
      const effectiveConfig = activeSchedule
        ? {
          ...config,
          numberOfCalls: activeSchedule.numberOfCalls,
          numberOfPuts: activeSchedule.numberOfPuts,
          minLongDist: activeSchedule.minLongDist,
          minStrikeDiff: activeSchedule.minStrikeDiff,
          atmRatioScaling: activeSchedule.atmRatioScaling,
          atmRatioPctCall: activeSchedule.atmRatioPctCall,
          atmRatioPctPut: activeSchedule.atmRatioPctPut,
          spotDiff: activeSchedule.spotDiff
        }
        : { ...config };

      // if (activeSchedule) {
      //   log(`[${accountState.name}] Schedule active: "${activeSchedule.label}" — Calls: ${activeSchedule.numberOfCalls}, Puts: ${activeSchedule.numberOfPuts}, LongDist: ${activeSchedule.minLongDist}, StrikeDiff: ${activeSchedule.minStrikeDiff}`);
      // }

      const underlying = effectiveConfig.underlying;

      // Identify ATM strike
      let atmStrike = null;
      let minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      // A. Local Scan: top candidates per type
      const callTickers = allTickers.filter(t => t.type === 'call' && t.expiry === config.expiry && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && t.expiry === config.expiry && (atmStrike === null || t.strike <= atmStrike));

      if (!onlyExits) {
        const now = Date.now();
        const staleCallCount = callTickers.filter(t => !((t.askUpdatedAt || 0) > 0 && (now - t.askUpdatedAt) < 120000)).length;
        const stalePutCount = putTickers.filter(t => !((t.bidUpdatedAt || 0) > 0 && (now - t.bidUpdatedAt) < 120000)).length;
        const totalTickers = allTickers.length;
        const expiryMatchCount = callTickers.length + putTickers.length;
        if (expiryMatchCount === 0) {
          logWarn(`[${accountState.name}] Ticker pool: ${totalTickers} total, 0 match expiry ${config.expiry} — WS may not have started yet.`);
        } else if (staleCallCount + stalePutCount > 0) {
          logWarn(`[${accountState.name}] Ticker pool: ${expiryMatchCount} matching expiry (${callTickers.length} calls, ${putTickers.length} puts), but ${staleCallCount + stalePutCount} have stale quotes (>120s) — waiting for fresh WS data.`);
        }
      }

      const { pairs: localTopCalls, rejected: callRej } = scanTickers(callTickers, effectiveConfig, spotPrice, atmStrike, getTickerPrice);
      const { pairs: localTopPuts, rejected: putRej } = scanTickers(putTickers, effectiveConfig, spotPrice, atmStrike, getTickerPrice);
      const topSpreads = [...localTopCalls, ...localTopPuts];

      // Merge rejection counts from calls + puts
      const totalRejected = {};
      for (const k of Object.keys(callRej)) totalRejected[k] = (callRej[k] || 0) + (putRej[k] || 0);

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

        const entryAtmRatio = computeEntryAtmRatio(buyIntrinsic, sellIntrinsic);
        const ratioToUse = computeScaledSellQty(spread.sellQty, entryAtmRatio, spread.buyLeg.type, effectiveConfig);

        const sellLotSize = spread.sellLeg.lotSize || lotSize;
        let shortValue = spotPrice * ratioToUse * sellLotSize;

        let adjustedLotSize = lotSize;
        let adjustedSellQty = ratioToUse;
        let scale = 1;

        if (shortValue >= 200000) {
          scale = 200000 / shortValue;
          adjustedLotSize = Number((lotSize * scale).toFixed(2));
          adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
          shortValue = 200000;
        }

        const atmPnl = ((buyIntrinsic - spread.buyPrice) + (spread.sellPrice - sellIntrinsic) * ratioToUse) * adjustedLotSize;
        const margin = calcMargin(spread.buyPrice, adjustedLotSize, spotPrice, adjustedSellQty, sellLotSize);
        const roi = margin > 0 ? (atmPnl / margin) * 100 : 0;

        return { atmPnl, roi };
      }

      // Compute ATM P&L and ROI for each spread in topSpreads, and filter by ATM P&L >= 50
      const processedSpreads = [];
      if (!onlyExits) {
        log(`[${accountState.name}] Evaluating ${topSpreads.length} candidate spreads for entry (Spot: ${spotPrice}, ATM Strike: ${atmStrike})`);
        if (topSpreads.length === 0) {
          // Log top rejection reason to diagnose why 0 candidates
          const topFilter = Object.entries(totalRejected)
            .filter(([, v]) => v > 0)
            .sort(([, a], [, b]) => b - a)[0];
          if (topFilter) {
            const filterNames = {
              strikeDiff: 'minStrikeDiff', noPrice: 'no ask/bid price',
              staleQuote: 'stale WS quote (>120s)', noIv: 'missing IV',
              ivDiff: 'minIvDiff', longDist: 'minLongDist',
              sellPremium: 'minSellPremium', noDelta: 'missing delta',
              ratioDev: 'maxRatioDeviation', maxSellQty: 'maxSellQty', netPrem: 'maxNetPremium'
            };
            logWarn(`[${accountState.name}] 0 candidates — top filter: ${filterNames[topFilter[0]] || topFilter[0]} rejected ${topFilter[1]} pairs (pool: ${callTickers.length} calls, ${putTickers.length} puts)`);
          }
        }
      }
      for (const spread of topSpreads) {
        const { atmPnl, roi } = calculateAtmPnlAndRoi(spread);

        let minAtmPnl = 50;
        if (effectiveConfig.atmRatioScaling) {
          const pct = spread.buyLeg.type === 'call' ? effectiveConfig.atmRatioPctCall : effectiveConfig.atmRatioPctPut;
          minAtmPnl = 50 * (1 - (pct || 0) / 100);
        }

        const passed = (atmPnl != null && atmPnl >= minAtmPnl);
        if (!onlyExits) {
          log(`[${accountState.name}] Candidate ${spread.buyLeg.type.toUpperCase()} ${spread.buyLeg.strike}/${spread.sellLeg.strike}: ATM P&L = $${atmPnl != null ? atmPnl.toFixed(2) : 'null'} (Min required: $${minAtmPnl.toFixed(2)}), ROI = ${roi != null ? roi.toFixed(2) : 0}%, Passed = ${passed}`);
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

      const hasConflictWithOtherActivePositions = (spread, activePositions) => {
        const bStrike = Number(spread.buyLeg.strike);
        const sStrike = Number(spread.sellLeg.strike);
        const type = spread.buyLeg.type;

        return activePositions.some(p => {
          if (Number(p.buyLeg.strike) === bStrike && Number(p.sellLeg.strike) === sStrike) {
            return false;
          }
          return p.underlying === underlying &&
            p.type === type &&
            (Number(p.buyLeg.strike) === bStrike || Number(p.sellLeg.strike) === sStrike);
        });
      };

      const uniqueCalls = [];
      for (const group of Object.values(callGroups)) {
        group.sort((a, b) => b.roi - a.roi);
        const primary = group[0];
        uniqueCalls.push(primary);
        if (hasConflictWithOtherActivePositions(primary, positions)) {
          const fallback = group.slice(1).find(s => !hasConflictWithOtherActivePositions(s, positions));
          if (fallback) uniqueCalls.push(fallback);
        }
      }

      const uniquePuts = [];
      for (const group of Object.values(putGroups)) {
        group.sort((a, b) => b.roi - a.roi);
        const primary = group[0];
        uniquePuts.push(primary);
        if (hasConflictWithOtherActivePositions(primary, positions)) {
          const fallback = group.slice(1).find(s => !hasConflictWithOtherActivePositions(s, positions));
          if (fallback) uniquePuts.push(fallback);
        }
      }

      // Sort candidate lists by distance to ATM (closest to ATM first)
      uniqueCalls.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));
      uniquePuts.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));

      const maxCallCandidates = Math.max(10, effectiveConfig.numberOfCalls || 3);
      const maxPutCandidates = Math.max(10, effectiveConfig.numberOfPuts || 3);

      const uniqueTopSpreads = [
        ...uniqueCalls.slice(0, maxCallCandidates),
        ...uniquePuts.slice(0, maxPutCandidates)
      ];

      if (!onlyExits && uniqueTopSpreads.length > 0) {
        const topDesc = uniqueTopSpreads.map(s => `${s.buyLeg.type.toUpperCase()} ${s.buyLeg.strike}/${s.sellLeg.strike} (ROI: ${s.roi.toFixed(1)}%, ATM P&L: $${s.atmPnl.toFixed(1)})`).join(', ');
        log(`Selected top unique spreads: ${topDesc}`);
      }

      // Count active positions
      const remaining = [];
      const exited = [];

      // Armed live accounts use the exchange-resting SL/TP model instead of the
      // paper simulated exits. Fetch current exchange positions once per cycle so
      // fill detection is a single API call, not one per leg.
      const liveExitModel = accountState.mode === 'live' && !!accountState.live_enabled;
      let liveSizeBySymbol = {};
      // In armed real mode, fill detection reads "leg absent from exchange" as
      // "leg filled". That is only safe when we actually KNOW the exchange state.
      // If the positions fetch fails (null), we must NOT run fill detection this
      // cycle — otherwise a single API hiccup reads as an all-flat account and
      // phantom-exits every open position at once. Hold instead; retry next cycle.
      let liveFillDetectionOk = true;
      if (liveExitModel && !live.dryRun) {
        const livePos = await live.positions();
        if (livePos == null) {
          liveFillDetectionOk = false;
          logWarn(`[${accountState.name}] Live exit: exchange positions fetch failed — holding all positions this cycle (skipping fill detection to avoid phantom exits).`);
        } else {
          for (const p of livePos) liveSizeBySymbol[p.product_symbol] = Number(p.size) || 0;
          // Latch "confirmed open" for any held leg the exchange actually reports
          // as non-zero. Fill-by-absence (below) is only trusted for confirmed legs,
          // so a leg we can never match / that never opens can't trigger a phantom
          // exit. The latch survives future cycles (in-memory on the position).
          for (const pos of positions) {
            if (Math.abs(liveSizeBySymbol[pos.sellLeg?.symbol] ?? 0) > 0) pos._shortConfirmedOpen = true;
            if (Math.abs(liveSizeBySymbol[pos.buyLeg?.symbol] ?? 0) > 0) pos._longConfirmedOpen = true;
          }
        }
      }

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

        // Armed live: index-triggered SL/TP model replaces the paper exit logic.
        if (liveExitModel) {
          // Real mode with a failed exchange fetch → hold (no fill detection).
          // Dry-run is unaffected (it uses the index crossing, not exchange size).
          if (!live.dryRun && !liveFillDetectionOk) {
            remaining.push(pos);
            continue;
          }
          await handleLiveExit(pos, remaining, liveSizeBySymbol);
          continue;
        }

        // Data gap guard
        const tickerBuy = tickerData[pos.buyLeg.symbol];
        const tickerSell = tickerData[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

        // Long-only positions (short already exited) only need the long's price.
        if (liveExitBuy == null || (pos.sellQty > 0 && liveExitSell == null)) {
          remaining.push(pos);
          continue;
        }

        // ── Short-leg-only exit ────────────────────────────────────────────
        // When the short leg's live ASK reaches less than the configured shortExitPrice (default 1.1),
        // buy it back (close the short at the ask) and keep holding the long leg. The long leg is
        // then closed later by the normal expiry / ATM-ITM-OTM exit rules.
        // the short leg will not be closed that cycle.
        const shortLiveAsk = tickerSell?.ask ?? null;
        const targetShortExitPrice = config.shortExitPrice ?? 1.1;
        if (pos.sellQty > 0 && shortLiveAsk <= targetShortExitPrice) {
          const shortLotSize = pos.sellLeg.lotSize || 1;
          const exitShortPrice = liveExitSell; // ask (<= targetShortExitPrice)

          const shortGrossPnl = (pos.entrySellPrice - exitShortPrice) * pos.sellQty * shortLotSize;
          const shortEntryFee = Math.min(
            pos.entryFee || 0,
            calculateFee(pos.entrySellPrice, pos.entrySpotPrice, pos.sellQty, shortLotSize)
          );
          const shortExitFee = calculateFee(exitShortPrice, spotPrice, pos.sellQty, shortLotSize);
          const shortTotalFees = shortEntryFee + shortExitFee;
          const shortNetPnl = shortGrossPnl - shortTotalFees;

          const shortExitReason = `Short Leg Exit @ Ask $${exitShortPrice.toFixed(2)} (holding long ${pos.buyLeg.strike})`;
          const shortTradeId = `${pos.id}-SE`;

          // Record the short-leg close as a partial trade_history row. Deterministic
          // trade_id + idempotent upsert so a duplicate evaluator can't double-book.
          try {
            await supabase.from('trade_history').upsert([{
              trade_id: shortTradeId,
              underlying: pos.underlying,
              expiry: pos.expiry,
              type: pos.type,
              buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: 0 }),
              sell_leg: JSON.stringify({ ...pos.sellLeg, exitIv: tickerSell?.askIv ?? tickerSell?.iv ?? null }),
              sell_qty: pos.sellQty,
              strike_diff: pos.strikeDiff,
              entry_time: pos.entryTime.toISOString(),
              entry_buy_price: pos.entryBuyPrice,
              entry_sell_price: pos.entrySellPrice,
              entry_spot_price: pos.entrySpotPrice,
              margin: pos.margin,
              exit_time: new Date().toISOString(),
              exit_buy_price: liveExitBuy,
              exit_sell_price: exitShortPrice,
              exit_spot_price: spotPrice,
              realized_gross_pnl: shortGrossPnl,
              realized_net_pnl: shortNetPnl,
              exit_fee: shortExitFee,
              total_fees: shortTotalFees,
              exit_reason: shortExitReason,
              is_partial: true,
              account_id: accountState.id,
            }], { onConflict: 'trade_id', ignoreDuplicates: true });
          } catch (e) {
            logError(`Failed to record short-leg exit for position ${pos.id}:`, e);
          }

          // LIVE: buy back the short leg to close it (reduce_only).
          await live.closeLeg({
            symbol: pos.sellLeg.symbol, side: 'buy',
            contracts: shortContracts(pos.sellQty),
            price: exitShortPrice, tag: `${pos.id}-SEX`,
          });

          // Convert the position to long-only: drop the short leg, recompute margin.
          // Snapshot the long lot (base for the 10-slice laddered exit) and build 10
          // equidistant exit levels spanning the long's current bid up to its entry price.
          const longBidAtExit = liveExitBuy; // long leg's live bid (the realistic sell price)
          const generatedLevels = await getOrBuildLongExitLevels(longBidAtExit, pos, config);

          pos.entryFee = Math.max(0, (pos.entryFee || 0) - shortEntryFee);
          pos.sellLeg = { ...pos.sellLeg, lotSize: 0 };
          pos.sellQty = 0;
          pos.buyLeg = {
            ...pos.buyLeg,
            longExitBaseLot: pos.buyLeg.lotSize,
            longExitStage: 0,
            longExitLevels: generatedLevels,
          };
          pos.margin = calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, spotPrice, 0, 1);
          log(`[${accountState.name}] 🎚️ Long ladder set: ${pos.buyLeg.strike} | bid at exit: ${longBidAtExit} | config variable: ${config.variableExitSlices} | levels ${JSON.stringify(pos.buyLeg.longExitLevels)}`);

          try {
            await supabase.from('active_positions').update({
              buy_leg: JSON.stringify(pos.buyLeg),
              sell_leg: JSON.stringify(pos.sellLeg),
              sell_qty: 0,
              entry_fee: pos.entryFee,
              margin: pos.margin,
            }).eq('id', pos.id);
          } catch (e) {
            logError(`Failed to persist short-leg exit for position ${pos.id}:`, e);
          }

          log(`[${accountState.name}] ✂️ SHORT EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}/${pos.sellLeg.strike} | Short bought back @ $${exitShortPrice} | PnL: $${shortNetPnl.toFixed(2)} | Holding long ${pos.buyLeg.strike}`);

          remaining.push(pos);
          continue;
        }

        // ── Long-only laddered profit exit ──────────────────────────────────
        // Once the short leg is gone, scale the held long out in slices as its
        // own BID recovers toward entry. At short-exit we placed equidistant
        // exit levels spanning [current bid, entry price]; each crossed level exits
        // a slice of the base lot. Trigger and exit price are both the live bid.
        if (pos.sellQty === 0) {
          const longBid = liveExitBuy; // long leg's live bid (the price we can sell at)

          // Base lot + equidistant exit levels are set at short-exit; fall back for older rows.
          if (pos.buyLeg.longExitBaseLot === undefined) {
            pos.buyLeg.longExitBaseLot = pos.buyLeg.lotSize || 0;
            pos.buyLeg.longExitStage = pos.buyLeg.longExitStage || 0;
          }
          if (!Array.isArray(pos.buyLeg.longExitLevels) || pos.buyLeg.longExitLevels.length === 0) {
            pos.buyLeg.longExitLevels = await getOrBuildLongExitLevels(longBid, pos, config);
          }
          const exitLevels = pos.buyLeg.longExitLevels;
          const baseLot = pos.buyLeg.longExitBaseLot || 0;
          const sliceLot = Number((baseLot / exitLevels.length).toFixed(2));
          let stage = pos.buyLeg.longExitStage || 0;

          if (longBid != null && baseLot > 0 && sliceLot > 0 && pos.entryBuyPrice > 0) {
            const longExitSlices = [];
            let cycleExitLot = 0; // total long lot closed this cycle (for the live order)
            const exitPrice = liveExitBuy; // close long by selling at the bid

            // Exit one slice per newly-crossed level (bid may cross several at once).
            while (stage < exitLevels.length && longBid >= exitLevels[stage]) {
              const isLast = (stage === exitLevels.length - 1);
              // Final checkpoint clears any rounding remainder.
              const exitLot = isLast
                ? Number(pos.buyLeg.lotSize.toFixed(2))
                : Math.min(sliceLot, Number(pos.buyLeg.lotSize.toFixed(2)));
              if (exitLot <= 0) { stage++; continue; }

              const sliceGrossPnl = (exitPrice - pos.entryBuyPrice) * exitLot;
              const sliceEntryFee = Math.min(
                pos.entryFee || 0,
                calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, exitLot, pos.buyLeg.originalLotSize || 1)
              );
              const sliceExitFee = calculateFee(exitPrice, spotPrice, exitLot, pos.buyLeg.originalLotSize || 1);
              const sliceTotalFees = sliceEntryFee + sliceExitFee;
              const sliceNetPnl = sliceGrossPnl - sliceTotalFees;

              longExitSlices.push({
                trade_id: `${pos.id}-LE-${stage}`,
                underlying: pos.underlying,
                expiry: pos.expiry,
                type: pos.type,
                buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: exitLot, exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null }),
                sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
                sell_qty: 0,
                strike_diff: pos.strikeDiff,
                entry_time: pos.entryTime.toISOString(),
                entry_buy_price: pos.entryBuyPrice,
                entry_sell_price: pos.entrySellPrice,
                entry_spot_price: pos.entrySpotPrice,
                margin: pos.margin,
                exit_time: new Date().toISOString(),
                exit_buy_price: exitPrice,
                exit_sell_price: null,
                exit_spot_price: spotPrice,
                realized_gross_pnl: sliceGrossPnl,
                realized_net_pnl: sliceNetPnl,
                exit_fee: sliceExitFee,
                total_fees: sliceTotalFees,
                exit_reason: `Long Leg Exit @ level $${exitLevels[stage]} (Bid $${longBid})`,
                is_partial: true,
                account_id: accountState.id,
              });

              pos.entryFee = Math.max(0, (pos.entryFee || 0) - sliceEntryFee);
              pos.buyLeg.lotSize = Number((pos.buyLeg.lotSize - exitLot).toFixed(2));
              cycleExitLot += exitLot;
              stage++;
            }

            if (longExitSlices.length > 0) {
              pos.buyLeg.longExitStage = stage;

              // LIVE: sell the closed long lot (reduce_only) at the bid.
              await live.closeLeg({
                symbol: pos.buyLeg.symbol, side: 'sell',
                contracts: longContracts(pos.buyLeg, cycleExitLot),
                price: exitPrice, tag: `${pos.id}-LEX-${stage}`,
              });

              try {
                await supabase.from('trade_history').upsert(longExitSlices, { onConflict: 'trade_id', ignoreDuplicates: true });
              } catch (e) {
                logError(`Failed to record long-leg laddered exits for position ${pos.id}:`, e);
              }

              const fullyExited = stage >= exitLevels.length || pos.buyLeg.lotSize <= 0;
              if (fullyExited) {
                try {
                  await supabase.from('active_positions').delete().eq('id', pos.id);
                } catch (e) {
                  logError(`Failed to delete fully-laddered long position ${pos.id}:`, e);
                }
                log(`[${accountState.name}] 🪜 LONG FULLY EXITED: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${longExitSlices.length} slice(s) | Bid $${longBid}`);
                continue;
              }

              pos.margin = calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, spotPrice, 0, 1);
              try {
                await supabase.from('active_positions').update({
                  buy_leg: JSON.stringify(pos.buyLeg),
                  entry_fee: pos.entryFee,
                  margin: pos.margin,
                }).eq('id', pos.id);
              } catch (e) {
                logError(`Failed to persist long-leg laddered exit for position ${pos.id}:`, e);
              }
              log(`[${accountState.name}] 🪜 LONG SLICE EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${longExitSlices.length} slice(s) | remaining lot ${pos.buyLeg.lotSize} | stage ${stage}/5`);
            }
          }
          // remaining long lot (if any) still falls through to expiry / ATM-ITM-OTM exit below
        }

        // Dynamic ATM ratio-based scaling (full spreads only — skipped once long-only)
        if (atmStrike !== null && pos.sellQty > 0) {
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
            const deltaBuyQty = Number((initialScaledLotSize * 0.10).toFixed(2));
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

            let threshold = (checkpointAtmPnl * 0.10) + checkpointPnl;

            while (
              currentGrossPnl >= threshold &&
              hypotheticalLotSize >= floorLimit &&
              liveAtmRatio >= recalculatedRatio + 1
            ) {
              log(`[${accountState.name}]: ⚖️ SCALING: Position ${pos.id} (${pos.type.toUpperCase()}) - PnL: $${currentGrossPnl.toFixed(2)} >= Threshold: $${threshold.toFixed(2)}. ATM ratio (1:x) increased: Recalculated Ratio ${recalculatedRatio.toFixed(2)} <= Live ${liveAtmRatio} - 1. Reducing buy lot size from ${currentLotSize} to ${hypotheticalLotSize}.`);

              const partialGrossPnl = buyPriceDiff * deltaBuyQty;

              // Exact entry fee of the buy leg portion being exited
              const partialEntryFee = Math.min(entryFee, calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1));
              const partialExitFee = calculateFee(liveExitBuy, spotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1);
              const partialTotalFees = partialEntryFee + partialExitFee;
              const partialNetPnl = partialGrossPnl - partialTotalFees;

              accumulatedPartialBuyPnl += partialGrossPnl;

              // Deterministic, lifetime-unique key: lots-remaining after this step
              // strictly decreases across the position's life, so it never collides
              // across cycles AND is identical if two evaluators race the same step —
              // letting the trade_id UNIQUE constraint reject the duplicate.
              const partialTradeId = `${pos.id}-PE-${hypotheticalLotSize.toFixed(2)}`;

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
              const nextThreshold = (postAtmPnl * 0.10) + postGrossPnl;
              const partialExitReason = [
                `Partial Exit`,
                `Current Gross PnL: $${currentGrossPnl.toFixed(2)}`,
                `Threshold Met: $${threshold.toFixed(2)}`,
                `Checkpoint PnL: $${checkpointPnl.toFixed(2)}`,
                `Checkpoint ATM PnL: $${checkpointAtmPnl.toFixed(2)}`,
                `ATM step (10%): $${(checkpointAtmPnl * 0.10).toFixed(2)}`,
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

              threshold = (checkpointAtmPnl * 0.10) + checkpointPnl;

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

              // LIVE: sell the reduced buy-leg lot (reduce_only) at the current bid.
              const totalReducedLot = partialExitsToRecord.length * deltaBuyQty;
              await live.closeLeg({
                symbol: pos.buyLeg.symbol, side: 'sell',
                contracts: longContracts(pos.buyLeg, totalReducedLot),
                price: liveExitBuy, tag: `${pos.id}-PEX-${pos.buyLeg.lotSize}`,
              });

              // FIX B6: batched insert
              try {
                await supabase.from('trade_history').upsert(partialExitsToRecord, { onConflict: 'trade_id', ignoreDuplicates: true });
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

        // Priority 3: Dynamic ATM/ITM/OTM exit
        if (!shouldExit) {
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          const exitType = config.exitType || 'ATM';
          const exitPoints = Math.abs(config.exitPoints || 0);

          let isExitMet = false;
          let reasonSuffix = '';

          if (exitType === 'ITM') {
            isExitMet = isCall ? (spotPrice >= buyStrike + exitPoints) : (spotPrice <= buyStrike - exitPoints);
            reasonSuffix = ` @ ITM (${isCall ? '+' : '-'}${exitPoints}pts)`;
          } else if (exitType === 'OTM') {
            isExitMet = isCall ? (spotPrice >= buyStrike - exitPoints) : (spotPrice <= buyStrike + exitPoints);
            reasonSuffix = ` @ OTM (${isCall ? '-' : '+'}${exitPoints}pts)`;
          } else { // ATM
            isExitMet = isCall ? (spotPrice >= buyStrike) : (spotPrice <= buyStrike);
            reasonSuffix = ' @ ATM';
          }

          if (isExitMet) {
            shouldExit = true;
            exitReason = `Full Exit${reasonSuffix}`;
          }
        }

        if (shouldExit) {
          const finalGrossPnl = grossPnl;
          const finalExitFee = exitFee;
          const finalEntryFee = pos.entryFee || 0;
          const finalTotalFees = totalFees;
          const finalNetPnl = grossPnl - totalFees;
          const finalSellQty = pos.sellQty;
          const finalSellLeg = { ...pos.sellLeg, exitIv: latestSellIv };

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
            id: pos.id,
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
        } else {
          remaining.push(pos);
        }
      }

      // ── 2. Open new positions (entries) ─────────────────────────────────
      const newEntries = [];

      // LIVE sizing context: divide the allocated wallet balance into equal parts
      // (1 part of margin per position). Only for armed live accounts; paper skips this.
      // Paused accounts keep managing open positions (exits ran above) but open
      // no NEW positions. Applies to paper and live alike; defaults false.
      const paused = !!accountState.paused;
      if (paused && !onlyExits) {
        log(`[${accountState.name}] ⏸ Paused — skipping new entries (open positions still managed).`);
      }

      const liveArmed = accountState.mode === 'live' && !!accountState.live_enabled;
      let partMargin = null;
      if (!onlyExits && !paused && liveArmed) {
        try {
          const bal = await live.walletBalance();
          if (bal != null && bal > 0) {
            const allocPct = config.balanceAllocationPct ?? 90;
            const usable = bal * (allocPct / 100);
            const maxPos = computeMaxPositions();
            partMargin = usable / maxPos;
            log(`[${accountState.name}] 💰 LIVE sizing: balance $${bal.toFixed(2)} × ${allocPct}% = $${usable.toFixed(2)} usable ÷ ${maxPos} max pos = $${partMargin.toFixed(2)}/position`);
          } else {
            logWarn(`[${accountState.name}] LIVE sizing: wallet balance unavailable — skipping live entries this cycle.`);
          }
        } catch (e) {
          logError(`[${accountState.name}] LIVE sizing balance fetch error:`, e);
        }
      }

      if (!onlyExits && !paused) {
        for (const spread of uniqueTopSpreads) {
          // Live accounts need a valid per-position margin part to size safely.
          if (liveArmed && partMargin == null) continue;
          const bStrike = Number(spread.buyLeg.strike);
          const sStrike = Number(spread.sellLeg.strike);
          const spreadType = spread.buyLeg.type;

          // Expiry buffer guard
          const minutesToExpiry = (new Date(spread.buyLeg.symbol?.includes(config.expiry) ? config.expiry : config.expiry).getTime() - Date.now()) / 60000;
          const expiryCheck = (new Date(config.expiry).getTime() - Date.now()) / 60000;
          if (expiryCheck < 5) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: too close to expiry (${expiryCheck.toFixed(1)} mins remaining)`);
            continue;
          }

          // Days to expiry guard
          const daysRemaining = (new Date(config.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < (config.daysToExpiry || 0)) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: days to expiry (${daysRemaining.toFixed(2)}) is less than min required (${config.daysToExpiry})`);
            continue;
          }

          // Buy strike conflict check
          const buyConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === bStrike
          );

          // Sell strike conflict check (ignore long-only held positions — their short leg is gone)
          const sellConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && p.sellQty > 0 && Number(p.sellLeg.strike) === sStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
          );

          if (buyConflictPos) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Buy strike conflict with active/new position ${buyConflictPos.id} (${buyConflictPos.buyLeg.strike}/${buyConflictPos.sellLeg.strike})`);
            continue;
          }
          if (sellConflictPos) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Sell strike conflict with active/new position ${sellConflictPos.id} (${sellConflictPos.buyLeg.strike}/${sellConflictPos.sellLeg.strike})`);
            continue;
          }

          // Portfolio cap — count only full spreads (positions with an active short leg).
          // Long-only held positions (sellQty === 0) free up a slot for new entries.
          let count = remaining.filter(p => p.underlying === underlying && p.type === spreadType && p.sellQty > 0).length +
            newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
          const typeCap = spreadType === 'call' ? effectiveConfig.numberOfCalls : effectiveConfig.numberOfPuts;
          if (count >= typeCap) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Portfolio cap of ${typeCap} reached for type ${spreadType}`);
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

          const entryAtmRatio = computeEntryAtmRatio(buyIntrinsic, sellIntrinsic);
          const ratioToUse = computeScaledSellQty(spread.sellQty, entryAtmRatio, spreadType, effectiveConfig);

          const originalLotSize = spread.buyLeg.lotSize || 1;
          const sellLotSize = spread.sellLeg.lotSize || originalLotSize;

          let adjustedLotSize = originalLotSize;
          let adjustedSellQty = ratioToUse;
          let scale = 1;

          if (liveArmed) {
            // LIVE: cap this position's margin at 1 "part" of allocated balance.
            const baseMargin = calcMargin(entryBuyPrice, originalLotSize, spotPrice, ratioToUse, sellLotSize);
            if (baseMargin > partMargin && baseMargin > 0) {
              scale = partMargin / baseMargin;
              adjustedLotSize = Number((originalLotSize * scale).toFixed(4));
              adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
            }
            const finalMargin = calcMargin(entryBuyPrice, adjustedLotSize, spotPrice, adjustedSellQty, sellLotSize);
            log(`[${accountState.name}] 💰 LIVE size ${spreadType.toUpperCase()} ${bStrike}/${sStrike}: baseMargin $${baseMargin.toFixed(2)} vs part $${partMargin.toFixed(2)} → scale ${scale.toFixed(3)} | long ${adjustedLotSize} short ${adjustedSellQty} | est margin $${finalMargin.toFixed(2)}`);
          } else {
            // PAPER (unchanged): $200,000 / 200x notional cap.
            let shortValue = spotPrice * ratioToUse * sellLotSize;
            if (shortValue >= 200000) {
              scale = 200000 / shortValue;
              adjustedLotSize = Number((originalLotSize * scale).toFixed(2));
              adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
              shortValue = 200000;
            }
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
          // Idempotent: trade_id is the stable position id, so a concurrent
          // evaluator's duplicate is silently ignored (ON CONFLICT DO NOTHING).
          const { error: histError } = await supabase.from('trade_history').upsert([{
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
          }], { onConflict: 'trade_id', ignoreDuplicates: true });
          if (histError) logError(`[${accountState.name}] History insert error:`, histError.message);

          // LIVE: close remaining legs. Skip on expiry — Delta cash-settles expired
          // options exchange-side, and orders that close to expiry are rejected.
          const isExpirySettlement = /expiry/i.test(t.exitReason || '');
          if (!isExpirySettlement) {
            if (t.buyLeg?.lotSize > 0) {
              await live.closeLeg({
                symbol: t.buyLeg.symbol, side: 'sell',
                contracts: longContracts(t.buyLeg),
                price: t._latestBuy, tag: `${t.id}-XB`,
              });
            }
            if (t.sellQty > 0) {
              await live.closeLeg({
                symbol: t.sellLeg.symbol, side: 'buy',
                contracts: shortContracts(t.sellQty),
                price: t._latestSell, tag: `${t.id}-XS`,
              });
            }
          }

          // Delete from active
          await supabase.from('active_positions').delete().eq('id', t.id);

          log(`[${accountState.name}] 📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (err) { logError(`[${accountState.name}] Exit persistence error:`, err); }
      }

      // Process entries
      if (!onlyExits) {
        for (const t of newEntries) {
          try {
            // DB-level count guard per account — count only full spreads (active short leg).
            // Long-only held positions (sell_qty === 0) don't count toward the cap.
            const { data: activeOfType, error: countError } = await supabase
              .from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .gt('sell_qty', 0);
            const typeCap = t.type === 'call' ? effectiveConfig.numberOfCalls : effectiveConfig.numberOfPuts;
            if (!countError && (activeOfType?.length ?? 0) >= typeCap) {
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

            // Sell strike uniqueness per account (ignore long-only held positions)
            const { data: sellConflict } = await supabase.from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .eq('sell_strike', t.sellLeg.strike).gt('sell_qty', 0).limit(1);
            if (sellConflict && sellConflict.length > 0) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Sell strike conflict on DB.`);
              continue;
            }

            // LIVE: place real orders before persisting. Paper/dry-run/disarmed
            // returns ok immediately; armed-live only persists if the orders succeed.
            // Live entry limit prices carry a premium-$ offset to fill marketable:
            // buy at ask + entryBuyOffset, sell at bid - entrySellOffset. The stored
            // entryBuyPrice/entrySellPrice (used for bookkeeping) are left as-is.
            const buyOff = config.entryBuyOffset ?? 5;
            const sellOff = config.entrySellOffset ?? 2;
            const liveEntry = await live.openSpread(t, {
              long: longContracts(t.buyLeg),
              short: shortContracts(t.sellQty),
              buyPrice: t.entryBuyPrice + buyOff,
              sellPrice: Math.max(0.05, t.entrySellPrice - sellOff),
            });
            if (!liveEntry.ok) {
              logError(`[${accountState.name}] LIVE entry aborted (${liveEntry.legFailed} leg: ${liveEntry.error}) — not persisting ${t.buyLeg.strike}/${t.sellLeg.strike}`);
              continue;
            }

            // LIVE: punch the short-leg SL (resting, index-triggered) at entry.
            // Its trigger level is persisted so the exit handler uses the same value.
            if (liveArmed && t.sellQty > 0) {
              const triggerLevel = computeIndexTriggerLevel(t.type, t.buyLeg.strike, effectiveConfig);
              const slRes = await live.placeStop({
                symbol: t.sellLeg.symbol, side: 'buy',
                contracts: shortContracts(t.sellQty), stopPrice: triggerLevel, tag: `${t.id}-SL`,
              });
              t.sellLeg = { ...t.sellLeg, slOrderId: slRes?.order?.id ?? null, slTriggerLevel: triggerLevel };
              log(`[${accountState.name}] 🛑 LIVE SL armed: short ${t.sellLeg.strike} @ index ${triggerLevel}`);
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
                logWarn(`[${accountState.name}] DB Guard: Duplicate strike entry blocked for ${t.buyLeg.strike}/${t.sellLeg.strike}`);
              } else {
                logError(`[${accountState.name}] Insert error:`, insertError.message);
              }
            } else {
              const originalLotSize = t.sellLeg.lotSize || 1;
              const ratioLong = t.buyLeg.lotSize / originalLotSize;
              log(`[${accountState.name}] 📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: ${ratioLong.toFixed(2)}:${t.sellQty} | Net: $${(t.sellQty * t.entrySellPrice - t.entryBuyPrice * ratioLong).toFixed(2)}`);
            }
          } catch (err) { logError(`[${accountState.name}] Entry persistence error:`, err); }
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

  async function reloadConfigAndSync() {
    try {
      const oldUnderlying = config.underlying;
      const oldExpiry = config.expiry;
      await fetchConfig();

      if (config.underlying !== oldUnderlying || config.expiry !== oldExpiry) {
        log(`[${accountState.name}] Config changed (underlying/expiry): ${oldUnderlying}/${oldExpiry} → ${config.underlying}/${config.expiry}`);
        await refreshProducts();
        await fetchActivePositions();
        tickerData = {};
        startWebSocket();
        tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
      }
    } catch (e) {
      logError(`[${accountState.name}] Error during config reload:`, e);
    }
  }

  function subscribeConfigChanges() {
    const channel = supabase
      .channel(`paper_config_changes_${accountState.id}`)
      .on(
        'postgres_changes',
        // Server-side filter on account_id keeps Realtime egress scoped to this
        // engine's account (avoids cross-account fan-out when multiple engines run).
        { event: '*', schema: 'public', table: 'paper_trading_config', filter: `account_id=eq.${accountState.id}` },
        async () => {
          log(`[${accountState.name}] Config change detected — reloading...`);
          await reloadConfigAndSync();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_schedules', filter: `account_id=eq.${accountState.id}` },
        async () => {
          log(`[${accountState.name}] Schedules change detected — reloading...`);
          await fetchSchedules();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'active_positions', filter: `account_id=eq.${accountState.id}` },
        (payload) => {
          // The engine is the authoritative writer of active_positions — entries, exits
          // and scaling are applied to the in-memory `positions` array directly by the
          // evaluation loop, so its own INSERT/UPDATE echoes need no DB refetch. The only
          // external mutation is a UI manual exit (DELETE); patch that out of memory
          // instead of re-downloading the whole position set (with JSON legs) on every
          // change. The periodic positionsTimer remains the drift safety net.
          if ((payload.eventType || payload.type) !== 'DELETE') return;
          const deletedId = payload.old?.id;
          if (!deletedId || !positions.some(p => p.id === deletedId)) return;
          positions = positions.filter(p => p.id !== deletedId);
          heartbeat.update({ active_positions: positions.length });
          log(`[${accountState.name}] Active position DELETE via Realtime: ${deletedId}. Removed from memory (no refetch).`);
        }
      )
      .subscribe();

    return channel;
  }


  // ── Main startup sequence ─────────────────────────────────────────────

  log(`[${accountState.name}] ═══════════════════════════════════════════`);
  log(`[${accountState.name}] Paper Trading Engine starting...`);
  log(`[${accountState.name}] ═══════════════════════════════════════════`);

  // 1. Load config + schedules
  await fetchConfig();
  await loadCredentials();
  await fetchSchedules();
  log(`[${accountState.name}] Schedules loaded: ${schedules.length} window(s)`);

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
    dry_run: isLiveDryRun(), // publish execution mode so the UI can show real vs simulated
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

  // Active positions, config and schedules refresh — every 5 minutes. This is only a
  // drift safety net now that Realtime reliably delivers account-scoped changes (config,
  // schedules and external position deletes), so a longer interval cuts redundant egress
  // (each cycle reads config + schedules + all positions-with-legs, per account).
  const positionsTimer = setInterval(async () => {
    try {
      await reloadConfigAndSync();
      await fetchSchedules(); // Refresh schedules periodically
      await fetchActivePositions();
      // LIVE: log-only drift check against the exchange (no-op unless armed + live).
      await live.reconcile(positions.length);
    } catch (e) {
      logError(`[${accountState.name}] Error in positionsTimer:`, e);
    }
  }, 300000);

  // Live wallet balance poll — every 60s for armed live accounts, surfaced to the
  // dashboard via the heartbeat (Wallet / Allocated / per-position figures).
  const balanceTimer = setInterval(async () => {
    try {
      if (accountState.mode === 'live' && accountState.live_enabled) {
        const bal = await live.walletBalance();
        if (bal != null) heartbeat.update({ wallet_balance: bal });
      } else {
        heartbeat.update({ wallet_balance: null });
      }
    } catch (e) { /* non-fatal */ }
  }, 60000);

  // Live exchange snapshot — every 20s for armed live accounts, READS real Delta
  // state (positions, resting/stop orders, fills, balances) and upserts it to
  // `live_exchange_state` so the UI's Positions/Open Orders/Stop Orders/Fills/Risk
  // tabs show exchange truth. Read-only w.r.t. the exchange; runs in dry-run too.
  const publishLiveSnapshot = async () => {
    if (!(accountState.mode === 'live' && accountState.live_enabled)) return;
    try {
      const snap = await live.snapshot();
      if (!snap) return;
      const { error } = await supabase.from('live_exchange_state').upsert({
        account_id: accountState.id,
        updated_at: new Date().toISOString(),
        positions: snap.positions,
        orders: snap.orders,
        stop_orders: snap.stopOrders,
        fills: snap.fills,
        balances: snap.balances,
        wallet: snap.wallet,
      }, { onConflict: 'account_id' });
      if (error) logError(`[${accountState.name}] live_exchange_state upsert error:`, error.message);
    } catch (e) {
      logWarn(`[${accountState.name}] live snapshot publish failed: ${e.message}`);
    }
  };
  const liveSnapshotTimer = setInterval(() => { publishLiveSnapshot(); }, 20000);
  publishLiveSnapshot(); // prime immediately so the UI isn't blank until the first tick


  log(`[${accountState.name}] Paper Trading Engine is LIVE`);

  // ── Return cleanup function ───────────────────────────────────────────
  return {
    async stop(isDeleted = false) {
      log(`[${accountState.name}] Paper Trading Engine shutting down... (isDeleted: ${isDeleted})`);
      clearInterval(evalTimer);
      clearInterval(spotTimer);
      clearInterval(productTimer);
      clearInterval(positionsTimer);
      clearInterval(balanceTimer);
      clearInterval(liveSnapshotTimer);
      if (wsHandle) { wsHandle.close(); wsHandle = null; }
      supabase.removeChannel(configChannel);

      await heartbeat.stop(isDeleted);

      log(`[${accountState.name}] Paper Trading Engine stopped.`);
    },
    updateAccount(newAccount) {
      const prevMode = accountState.mode;
      accountState = newAccount;
      log(`[${accountState.name}] Account state updated (mode: ${accountState.mode}, live_enabled: ${accountState.live_enabled})`);
      // Reload credentials if the account switched into live mode or lost them.
      if (accountState.mode === 'live' && (prevMode !== 'live' || !liveCreds)) {
        loadCredentials().catch(e => logError(`[${accountState.name}] updateAccount credential reload failed:`, e));
      } else if (accountState.mode !== 'live') {
        liveCreds = null;
      }
    }
  };
}

// ── Multi-Account Engine Manager ──────────────────────────────────────

export async function startPaperTradingEngine() {
  const runningEngines = {}; // accountId -> engineHandle
  const startingEngines = new Set(); // accountIds with an in-flight start (race guard)

  async function startAccountEngine(account) {
    const accountId = account.id;
    // Reserve the slot SYNCHRONOUSLY before the await below. Without this, a
    // concurrent trigger (initial fetch, 30s fallback sync, Realtime account
    // event) could pass the `runningEngines` check while a start is mid-flight
    // and spawn a SECOND engine — the loser gets overwritten in the map and
    // becomes an unstoppable zombie that double-books every exit forever.
    if (runningEngines[accountId] || startingEngines.has(accountId)) {
      logWarn(`Account engine ${accountId} (${account.name}) is already running or starting.`);
      return;
    }
    startingEngines.add(accountId);
    log(`Starting engine for account ${accountId} (${account.name})...`);
    try {
      const handle = await startSingleAccountEngine(account);
      runningEngines[accountId] = handle;
    } catch (e) {
      logError(`Failed to start engine for account ${accountId}:`, e);
    } finally {
      startingEngines.delete(accountId);
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
    log(`Starting ${accounts.length} account engines in parallel...`);
    await Promise.allSettled(accounts.map(acc => startAccountEngine(acc)));
    log(`All account engines started.`);
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

  // ── Credential verification watcher ───────────────────────────────────
  // The browser drops encrypted verify requests into delta_verify_requests; we
  // run the balance check from THIS server's whitelisted IP and write the result
  // back. Requires the service_role key (to decrypt); no-op otherwise.
  async function processVerifyRequests() {
    if (!hasServiceRole) return;
    try {
      const { data: pending, error } = await supabase
        .from('delta_verify_requests')
        .select('id')
        .eq('status', 'pending')
        .limit(5);
      if (error) { logError('Verify watcher fetch error:', error.message); return; }

      for (const row of pending || []) {
        let status = 'error';
        let errMsg = null;
        let balanceVal = null;
        try {
          const { data: creds, error: dErr } = await supabase
            .rpc('get_delta_verify_request_decrypted', { p_id: row.id });
          if (dErr || !creds || !creds[0]) {
            errMsg = dErr?.message || 'Could not decrypt request';
          } else {
            try {
              const balances = await getBalance({ apiKey: creds[0].api_key, apiSecret: creds[0].api_secret });
              balanceVal = extractBalance(balances);
              status = 'verified';
            } catch (e) {
              status = 'error';
              errMsg = e.message;
            }
          }
        } catch (e) {
          errMsg = e.message;
        }
        await supabase.from('delta_verify_requests')
          .update({ status, error: errMsg, balance: balanceVal, api_secret_enc: null, processed_at: new Date().toISOString() })
          .eq('id', row.id);
        log(`Delta verify request ${row.id}: ${status}${balanceVal != null ? ` (USDT ${balanceVal})` : ''}${errMsg ? ` (${errMsg})` : ''}`);
      }

      // Purge processed/stale requests older than 1 hour (they hold no secret once processed).
      const cutoff = new Date(Date.now() - 3600000).toISOString();
      await supabase.from('delta_verify_requests').delete().lt('created_at', cutoff);
    } catch (e) {
      logError('Verify watcher exception:', e);
    }
  }
  const verifyTimer = setInterval(processVerifyRequests, 4000);

  return {
    async stop() {
      log('Shutting down all running account engines...');
      clearInterval(syncTimer);
      clearInterval(verifyTimer);
      supabase.removeChannel(accountsChannel);
      for (const accountId of Object.keys(runningEngines)) {
        await stopAccountEngine(accountId);
      }
      log('All account engines shut down.');
    }
  };
}
