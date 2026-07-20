/**
 * Live-execution layer for the paper trading engine.
 *
 * Wraps real Delta Exchange order placement behind two gates:
 *   1. Per-account arming:  mode === 'live' && live_enabled  (else: no orders at all)
 *   2. Global dry-run flag:  DELTA_LIVE_DRYRUN (default TRUE) — when on, intended
 *      orders are LOGGED but never sent, so the whole path can be validated against
 *      a real account before any money moves.
 *
 * The engine's paper bookkeeping is unchanged: these helpers are additive
 * side-effects invoked at the same points where positions are written to Supabase.
 *
 * ⚠ SIZE UNITS: the paper engine sizes positions as fractional notional "lots"
 * (contract_size-scaled). Delta orders take an INTEGER number of contracts. The
 * contract counts below are a BEST-EFFORT mapping (≈1 contract per long unit,
 * `sellQty` for the short). Validate the dry-run order log against your intended
 * real sizes BEFORE arming an account.
 */
import { placeOrder, cancelOrder, editOrder, editBracket, placeBracketOrder, closeAllPositions, getLivePositions, getBalance, getLiveOrders, getFills, getOrderHistory } from './deltaTradeApi.js';
import { log, logWarn, logError } from './utils.js';
import { notifyLiveFailure } from './telegram.js';

// Default ON. Only the literal string 'false' (any case) disarms the dry-run.
const DRY_RUN = String(process.env.DELTA_LIVE_DRYRUN ?? 'true').toLowerCase() !== 'false';

export function isLiveDryRun() {
  return DRY_RUN;
}

/** Best-effort integer contract count for a long leg quantity. */
export function longContracts(leg, lotOverride = null) {
  const qty = lotOverride != null ? lotOverride : (leg?.lotSize || 0);
  const base = leg?.originalLotSize || leg?.lotSize || 1;
  return Math.max(1, Math.round(qty / base));
}

/** Best-effort integer contract count for a short leg (sellQty is already a lot ratio). */
export function shortContracts(sellQty) {
  return Math.max(1, Math.round(sellQty || 0));
}

/**
 * Turn a numeric limit price into a Delta-safe string. Computed prices carry
 * float-representation noise (e.g. 2.7 - 2 === 0.7000000000000002); sending that
 * raw makes Delta reject the order with `bad_schema`. Inputs are already
 * tick-aligned (exchange bid/ask/mark ± integer offsets), so rounding to 4
 * decimals only strips the noise: 0.7000000000000002 → "0.7", 0.05 → "0.05".
 * Returns null for non-finite prices so callers can skip.
 */
export function cleanLimitPrice(price) {
  if (price == null || !Number.isFinite(Number(price))) return null;
  return String(Number(Number(price).toFixed(4)));
}

/**
 * Delta caps `client_order_id` length; an over-long tag makes it reject the order with
 * `bad_schema` (hit by adopted-orphan tags like `ADOPT-P-BTC-62400-200726-…-LE-0`, which
 * embed the full symbol). Keep the TAIL so the order-type marker the UI/reason-derivation
 * reads (`…-SE`, `-PEX`, `-LE-0`, `-XB-ATM`, …) always survives, plus enough of the id for
 * uniqueness. Normal tags (~20 chars) pass through untouched.
 */
const MAX_COID = 36;
export function clampClientOrderId(tag) {
  const s = String(tag ?? '');
  return s.length <= MAX_COID ? s : s.slice(s.length - MAX_COID);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fresh marketable limit for an entry chase re-price: cross the spread by `offset`
 * (premium $) plus an escalating `bump` so a quote that has widened/moved still
 * fills. `quote` is the leg's latest ticker ({ bid, ask, markPrice, lastPrice }).
 * Returns null when no usable reference price is available (caller skips the edit).
 */
export function marketableChasePrice(side, quote, offset = 0, bump = 0) {
  const q = quote || {};
  const ref = side === 'buy'
    ? (q.ask ?? q.lastPrice ?? q.markPrice)
    : (q.bid ?? q.lastPrice ?? q.markPrice);
  if (ref == null || !Number.isFinite(Number(ref))) return null;
  return side === 'buy'
    ? Number(ref) + offset + bump
    : Math.max(0.05, Number(ref) - offset - bump);
}

/**
 * Remaining unfilled contracts for a resting order id. Returns 0 when the order is
 * no longer working (during an entry chase we only cancel intentionally at the very
 * end, so "gone" means fully filled), or null when the orders fetch failed so the
 * caller can retry rather than assume a fill.
 */
async function unfilledContracts(creds, id) {
  let orders;
  try { orders = await getLiveOrders(creds, { states: 'open,pending' }); }
  catch { return null; }
  if (!Array.isArray(orders)) return null;
  const o = orders.find((x) => String(x.id) === String(id));
  if (!o) return 0;
  return Math.abs(Number(o.unfilled_size) || 0);
}

/**
 * Extract a usable wallet balance from Delta's /v2/wallet/balances response,
 * tolerant of asset naming/shape: prefer USDT, then USD, else the wallet with the
 * largest balance. Reads balance/available_balance regardless of nesting.
 */
export function extractBalance(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return null;
  const sym = (b) => String(b.asset_symbol || b.asset?.symbol || '').toUpperCase();
  const amt = (b) => {
    const v = parseFloat(b.balance ?? b.available_balance ?? b.wallet_balance ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  const pick =
    balances.find((b) => sym(b) === 'USDT') ||
    balances.find((b) => sym(b) === 'USD') ||
    [...balances].sort((a, b) => amt(b) - amt(a))[0];
  if (!pick) return null;
  const v = amt(pick);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param getCtx () => ({ accountName, mode, liveEnabled, creds })
 *   `creds` = { apiKey, apiSecret } or null.
 */
export function createLiveExecutor(getCtx) {
  let warnedNoCreds = false;

  function armed() {
    const { mode, liveEnabled } = getCtx();
    return mode === 'live' && !!liveEnabled;
  }

  async function submit({ symbol, side, contracts, price, reduceOnly = false, tag, bracket = null }) {
    const { accountName, creds } = getCtx();
    const size = Math.max(1, Math.round(contracts || 0));
    const priceStr = cleanLimitPrice(price);
    const brkStr = bracket
      ? ` +bracket{${bracket.bracket_take_profit_price ? 'TP@' + bracket.bracket_take_profit_price : ''}${bracket.bracket_stop_loss_price ? ' SL@' + bracket.bracket_stop_loss_price : ''} via ${bracket.bracket_stop_trigger_method || 'mark'}}`
      : '';
    const summary = `${side.toUpperCase()} ${size}x ${symbol} @ ${priceStr ?? '—'}${reduceOnly ? ' reduceOnly' : ''}${brkStr} [${tag}]`;

    if (DRY_RUN) {
      log(`[${accountName}] 🧪 DRY-RUN live order (not sent): ${summary}`);
      return { ok: true, dryRun: true };
    }

    if (!creds?.apiKey || !creds?.apiSecret) {
      if (!warnedNoCreds) {
        logError(`[${accountName}] LIVE armed but no decrypted credentials available — cannot place orders. (Is the engine using the service_role key?)`);
        notifyLiveFailure({ account: accountName, context: 'Armed live but NO Delta credentials — orders cannot be placed', extra: 'Check the engine service_role key / stored credentials.' });
        warnedNoCreds = true;
      }
      return { ok: false, error: 'no-credentials' };
    }
    if (!priceStr) {
      logError(`[${accountName}] LIVE order skipped — no valid limit price: ${summary}`);
      return { ok: false, error: 'no-price' };
    }

    try {
      const order = await placeOrder(creds, {
        product_symbol: symbol,
        size,
        side,
        order_type: 'limit_order',
        limit_price: priceStr,
        time_in_force: 'gtc',
        reduce_only: !!reduceOnly,
        client_order_id: clampClientOrderId(tag),
        ...(bracket || {}), // bracket_take_profit_price / bracket_stop_loss_price / bracket_stop_trigger_method
      });
      log(`[${accountName}] ✅ LIVE order sent: ${summary} → id ${order?.id ?? '?'} state ${order?.state ?? '?'}`);
      return { ok: true, order };
    } catch (e) {
      const msg = String(e.message || '');
      // A reduce-only (closing) order that finds nothing to close means the position was
      // already closed exchange-side (e.g. its bracket fired first — a benign double-close
      // race). The leg is flat, so nothing is left unprotected: treat as success and don't
      // alarm. reconcileOrphans books the exit once it sees the flat position.
      if (reduceOnly && /no_position_for_reduce_only/i.test(msg)) {
        log(`[${accountName}] ℹ️ Reduce-only order no-op (${side} ${symbol}) — already closed on Delta [${tag}].`);
        return { ok: true, alreadyClosed: true };
      }
      logError(`[${accountName}] ✖ LIVE order FAILED: ${summary}:`, e.message);
      notifyLiveFailure({ account: accountName, context: `Order send FAILED (${side} ${symbol})`, error: e, extra: `[${tag}]` });
      return { ok: false, error: e.message };
    }
  }

  // Reduce-only MARKET close of a single leg by symbol. Shared by the public
  // closeSymbol() action and openSpread's abort/unwind paths.
  async function marketClose({ symbol, side, contracts, tag }) {
    if (!armed()) return { ok: true, skipped: true };
    const { accountName, creds } = getCtx();
    const size = Math.max(1, Math.round(Math.abs(contracts || 0)));
    const summary = `CLOSE ${side.toUpperCase()} ${size}x ${symbol} reduceOnly [${tag}]`;
    if (DRY_RUN) { log(`[${accountName}] 🧪 DRY-RUN close-symbol (not sent): ${summary}`); return { ok: true, dryRun: true }; }
    if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, error: 'no-credentials' };
    try {
      const order = await placeOrder(creds, {
        product_symbol: symbol, size, side,
        order_type: 'market_order', reduce_only: true, time_in_force: 'ioc',
        client_order_id: clampClientOrderId(tag),
      });
      log(`[${accountName}] ✅ LIVE close-symbol: ${summary} → id ${order?.id ?? '?'}`);
      return { ok: true, order };
    } catch (e) {
      const msg = String(e.message || '');
      // Same benign case as submit(): a reduce-only close found nothing to close → the leg
      // is already flat on Delta (double-close race, e.g. bracket fired first). Not a
      // failure and nothing left unprotected; don't alarm.
      if (/no_position_for_reduce_only/i.test(msg)) {
        log(`[${accountName}] ℹ️ Reduce-only close no-op (${side} ${symbol}) — already closed on Delta [${tag}].`);
        return { ok: true, alreadyClosed: true };
      }
      logError(`[${accountName}] ✖ LIVE close-symbol FAILED: ${summary}:`, e.message);
      notifyLiveFailure({ account: accountName, context: `Reduce-only CLOSE FAILED (${side} ${symbol}) — leg may still be OPEN on Delta`, error: e, extra: `[${tag}]` });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Place a marketable limit and CHASE it to a full fill: if it doesn't fill
   * immediately, re-price it in place (edit — keeps the order id AND any attached
   * bracket) toward the market a few times. Returns
   *   { ok, order, id, productId, filled, unfilled, rejected }
   * where `ok` is true only when fully filled. `rejected` is true only when the initial
   * submit was refused by Delta (submit-time rejection) vs a chase timeout (accepted but
   * unfilled) — so callers can report the real cause. In dry-run, when disarmed, or when no
   * `chase` config is supplied it degrades to a single submit (assumed filled), so
   * the pre-chase behaviour is preserved on every non-armed-real path.
   */
  async function submitChase({ symbol, side, contracts, price, reduceOnly = false, tag, bracket = null, chase = null }) {
    const first = await submit({ symbol, side, contracts, price, reduceOnly, tag, bracket });
    // Submit-time rejection (Delta refused the order outright — e.g. bracket conflict, bad
    // schema) is distinct from a chase timeout (order accepted but never fully filled).
    // Flag it so callers can report the real cause instead of a misleading "chase exhausted".
    if (!first.ok) return { ok: false, error: first.error, filled: 0, rejected: true };
    if (first.dryRun || first.skipped || !chase) return { ok: true, order: first.order, filled: contracts };

    const { accountName, creds } = getCtx();
    const id = first.order?.id;
    const productId = first.order?.product_id;
    let unfilled = Number(first.order?.unfilled_size);
    if (!Number.isFinite(unfilled)) unfilled = contracts; // unknown → assume resting, poll
    // Common case: a marketable limit fills instantly — no polling, no extra calls.
    if (unfilled === 0 || String(first.order?.state) === 'closed') {
      return { ok: true, order: first.order, id, productId, filled: contracts, unfilled: 0 };
    }

    const attempts = Math.max(0, chase.attempts ?? 3);
    const pollMs = Math.max(200, chase.pollMs ?? 1500);
    const offset = side === 'buy' ? (chase.buyOffset ?? 0) : (chase.sellOffset ?? 0);
    for (let a = 1; a <= attempts; a++) {
      await sleep(pollMs);
      const u = await unfilledContracts(creds, id);
      if (u === 0) { unfilled = 0; break; }
      if (u == null) continue;                 // fetch hiccup — retry next loop
      unfilled = u;
      // Re-price toward the market, escalating the cross a little each attempt.
      const bump = (chase.bump ?? 1) * a;
      const newPx = cleanLimitPrice(marketableChasePrice(side, chase.quote?.(symbol), offset, bump));
      if (!newPx) continue;
      try {
        // Send the ORIGINAL total size: Delta keeps the already-filled portion and
        // re-rests the remainder at the new price (a smaller size would be < filled).
        await editOrder(creds, { id, product_id: productId, limit_price: newPx, size: Math.max(1, Math.round(contracts)) });
        log(`[${accountName}] 🏃 CHASE ${side} ${symbol}: ${unfilled} unfilled → reprice ${newPx} (attempt ${a}/${attempts}) [${tag}]`);
      } catch (e) {
        logWarn(`[${accountName}] chase reprice failed for ${symbol} [${tag}]: ${e.message}`);
      }
    }
    const uFinal = await unfilledContracts(creds, id);
    if (uFinal === 0) unfilled = 0;
    else if (uFinal != null) unfilled = uFinal;
    const filled = Math.max(0, contracts - unfilled);
    return { ok: unfilled === 0, order: first.order, id, productId, filled, unfilled };
  }

  return {
    isArmed: armed,
    dryRun: DRY_RUN,

    /**
     * Open a spread: buy the long leg (@ ask), sell the short leg (@ bid).
     * Optionally attaches exchange-native brackets (spot-triggered) to each leg:
     *   longTp → bracket TAKE-PROFIT on the long buy
     *   shortSl → bracket STOP-LOSS on the short sell
     * Both fire at the shared exit level even if the engine is down.
     *
     * CHASE-FILL (armed-real only, when `chase` is supplied): each leg is a
     * marketable limit that is re-priced in place a few times until it fully fills
     * (see submitChase). To guarantee we never carry a naked/mismatched leg, entry
     * is ALL-OR-NOTHING — if a leg can't be fully filled after the chase we unwind
     * whatever filled (reduce-only market) and abort:
     *   • BUY can't fill  → cancel/unwind the partial long, abort (nothing opened).
     *   • SELL can't fill → unwind the full long + any partial short, abort.
     * Returns { ok }. On any abort the caller must NOT persist the position; the
     * account is left flat (no manual reconciliation needed).
     */
    async openSpread(pos, { long, short, buyPrice, sellPrice, longTp = null, shortSl = null, chase = null }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();

      const buyBracket = (longTp != null && Number.isFinite(longTp))
        ? { bracket_take_profit_price: String(longTp), bracket_stop_trigger_method: 'spot_price' }
        : null;
      const buy = await submitChase({
        symbol: pos.buyLeg.symbol, side: 'buy', contracts: long,
        price: buyPrice ?? pos.entryBuyPrice, reduceOnly: false, tag: `${pos.id}-EB`,
        bracket: buyBracket, chase,
      });
      if (!buy.ok) {
        // Long couldn't be fully filled — stay flat: unwind any partial, else cancel.
        if (buy.filled > 0) {
          logWarn(`[${accountName}] ⚠ Entry BUY only ${buy.filled}/${long} filled for ${pos.id} — unwinding to abort cleanly.`);
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: buy.filled, tag: `${pos.id}-EAB` }).catch(() => {});
        } else if (buy.id) {
          await cancelOrder(creds, { id: buy.id, product_id: buy.productId }).catch(() => {});
        }
        return { ok: false, legFailed: 'buy', error: buy.error || 'buy leg unfilled after chase', rejected: !!buy.rejected };
      }

      if (short > 0) {
        const sellBracket = (shortSl != null && Number.isFinite(shortSl))
          ? { bracket_stop_loss_price: String(shortSl), bracket_stop_trigger_method: 'spot_price' }
          : null;
        const sell = await submitChase({
          symbol: pos.sellLeg.symbol, side: 'sell', contracts: short,
          price: sellPrice ?? pos.entrySellPrice, reduceOnly: false, tag: `${pos.id}-ES`,
          bracket: sellBracket, chase,
        });
        if (!sell.ok) {
          // Short couldn't be fully filled — unwind the FILLED long (and any partial
          // short) so we never carry a naked/mismatched leg. All-or-nothing entry.
          logError(`[${accountName}] ⚠ Entry SELL only ${sell.filled}/${short} filled after chase for ${pos.id} — unwinding long + partial short to abort.`);
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: long, tag: `${pos.id}-EAB` }).catch(() => {});
          if (sell.filled > 0) {
            await marketClose({ symbol: pos.sellLeg.symbol, side: 'buy', contracts: sell.filled, tag: `${pos.id}-EAB` }).catch(() => {});
          } else if (sell.id) {
            await cancelOrder(creds, { id: sell.id, product_id: sell.productId }).catch(() => {});
          }
          return { ok: false, legFailed: 'sell', error: sell.error || 'sell leg unfilled after chase', rejected: !!sell.rejected, buyOrder: buy.order };
        }
        return { ok: true, buyOrder: buy.order, sellOrder: sell.order };
      }
      return { ok: true, buyOrder: buy.order };
    },

    /**
     * Open the triplet's 3rd leg — a stand-alone LONG-ONLY hedge — after the main
     * spread is open. Kept separate from openSpread so its client tag (`-HB`) never
     * collides with the main long's `-EB`, and so a fill failure is NON-fatal: unlike
     * entry, the caller drops the hedge leg and keeps the 2-leg position rather than
     * unwinding. No bracket — the hedge is engine-managed and exits with the triplet
     * (reduce-only `-HX` close). No-op for paper / unarmed.
     */
    async openHedge(pos, { contracts, price, chase = null }) {
      if (!armed()) return { ok: true, skipped: true };
      return submitChase({
        symbol: pos.hedgeLeg.symbol, side: 'buy', contracts,
        price: price ?? pos.hedgeLeg.entryPrice, reduceOnly: false, tag: `${pos.id}-HB`,
        bracket: null, chase,
      });
    },

    /** Close (or reduce) a single leg. `side` is the closing side. */
    async closeLeg({ symbol, side, contracts, price, tag }) {
      if (!armed()) return { ok: true, skipped: true };
      return submit({ symbol, side, contracts, price, reduceOnly: true, tag });
    },

    /**
     * Flatten a single leg by symbol with a reduce_only MARKET order (no price) —
     * used for the per-row ✕ close, including orphan legs not tracked by the engine.
     * `side` is the closing side (sell to close a long, buy to close a short).
     */
    async closeSymbol({ symbol, side, contracts, tag }) {
      return marketClose({ symbol, side, contracts, tag });
    },

    /**
     * Edit an existing resting order's price (and size) in place. Used to re-sync a
     * position's resting short buy-back when shortExitPrice changes — no cancel/replace.
     */
    async editOrder({ id, symbol, price, size, tag }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const priceStr = cleanLimitPrice(price);
      const summary = `EDIT order ${id} ${symbol} → @ ${priceStr ?? '—'}${size != null ? ` x${size}` : ''} [${tag}]`;
      if (DRY_RUN) { log(`[${accountName}] 🧪 DRY-RUN edit order (not sent): ${summary}`); return { ok: true, dryRun: true }; }
      if (!creds?.apiKey || !id || !priceStr) return { ok: false, error: 'missing id/price/creds' };
      try {
        const order = await editOrder(creds, { id, product_symbol: symbol, limit_price: priceStr, ...(size != null ? { size: Math.max(1, Math.round(size)) } : {}) });
        log(`[${accountName}] ✅ LIVE order edited: ${summary} → state ${order?.state ?? '?'}`);
        return { ok: true, order };
      } catch (e) {
        logError(`[${accountName}] ✖ LIVE order edit FAILED: ${summary}:`, e.message);
        return { ok: false, error: e.message };
      }
    },

    /**
     * Edit a position's attached bracket (SL and/or TP) in place. Used to re-sync
     * the index SL/TP level when exitType/exitPoints change. Pass only the side(s)
     * you want to change.
     */
    async editBracket({ symbol, stopLoss = null, takeProfit = null, triggerMethod = 'spot_price', tag }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const sl = (stopLoss != null && Number.isFinite(stopLoss)) ? String(stopLoss) : null;
      const tp = (takeProfit != null && Number.isFinite(takeProfit)) ? String(takeProfit) : null;
      const summary = `EDIT bracket ${symbol} →${sl ? ` SL@${sl}` : ''}${tp ? ` TP@${tp}` : ''} via ${triggerMethod} [${tag}]`;
      if (DRY_RUN) { log(`[${accountName}] 🧪 DRY-RUN edit bracket (not sent): ${summary}`); return { ok: true, dryRun: true }; }
      if (!creds?.apiKey || (!sl && !tp)) return { ok: false, error: 'missing creds/levels' };
      try {
        const res = await editBracket(creds, {
          product_symbol: symbol,
          bracket_stop_trigger_method: triggerMethod,
          ...(sl ? { bracket_stop_loss_price: sl } : {}),
          ...(tp ? { bracket_take_profit_price: tp } : {}),
        });
        log(`[${accountName}] ✅ LIVE bracket edited: ${summary}`);
        return { ok: true, res };
      } catch (e) {
        logError(`[${accountName}] ✖ LIVE bracket edit FAILED: ${summary}:`, e.message);
        return { ok: false, error: e.message };
      }
    },

    /**
     * CREATE a bracket on an OPEN POSITION (POST /v2/orders/bracket). Sets ONE side per
     * call — `side: 'tp'` for a long leg's take-profit, `'sl'` for a short leg's stop-loss —
     * as a whole-position MARKET stop at `stopPrice`, triggered on `triggerMethod` (spot by
     * default). `productId` identifies the position (Delta wants it here) and `symbol` is
     * sent alongside.
     *
     * ⚠ This CREATES — Delta rejects it with `bracket_order_exists` if the position already
     * has a bracket. To MOVE an existing bracket the caller must CANCEL the current bracket
     * order first, then call this (see `syncExitBrackets`). Armed real only; dry-run logs
     * the intended call so the payload can be validated before it fires.
     */
    async changePositionBracket({ productId = null, symbol, side, stopPrice, triggerMethod = 'spot_price', tag }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const stopStr = cleanLimitPrice(stopPrice);
      const legObj = { order_type: 'market_order', stop_price: stopStr };
      const summary = `BRACKET ${String(side).toUpperCase()} ${symbol}${productId != null ? ` (pid ${productId})` : ''} @stop ${stopStr ?? '—'} via ${triggerMethod} [${tag}]`;
      if (DRY_RUN) { log(`[${accountName}] 🧪 DRY-RUN bracket set (not sent): ${summary}`); return { ok: true, dryRun: true }; }
      if (!creds?.apiKey || !stopStr || (side !== 'sl' && side !== 'tp')) {
        return { ok: false, error: 'missing creds/stop/side' };
      }
      try {
        const res = await placeBracketOrder(creds, {
          ...(productId != null ? { product_id: productId } : {}),
          product_symbol: symbol,
          bracket_stop_trigger_method: triggerMethod,
          ...(side === 'sl' ? { stop_loss_order: legObj } : {}),
          ...(side === 'tp' ? { take_profit_order: legObj } : {}),
        });
        log(`[${accountName}] ✅ LIVE bracket set: ${summary}`);
        return { ok: true, res };
      } catch (e) {
        const msg = String(e.message || '');
        // Three Delta rejections are EXPECTED here and must NOT raise the generic
        // "unprotected" alarm:
        //   • no_open_position    → the leg is already closed on Delta; nothing to protect.
        //                           reconcileOrphans books + removes it within ~90s.
        //   • *immediate_execution → the trigger level is already breached; a resting
        //                           bracket can't be placed, so the caller market-closes
        //                           the leg instead (the real protective exit).
        //   • bracket_order_exists → the position ALREADY has a bracket, so the leg is in
        //                           fact PROTECTED — the create just collided (e.g. the
        //                           armMissingBrackets safety net acted on a stale orders
        //                           snapshot that missed the existing bracket). Alarming
        //                           "unprotected" here is a FALSE alarm; skip it. (Moving a
        //                           bracket to a new level is syncExitBrackets' job, which
        //                           cancels-then-recreates — this create-only path never
        //                           needs to displace an existing bracket.)
        // Any OTHER error is genuinely unexpected → keep alarming (exit truly unprotected).
        const code = /no_open_position/i.test(msg) ? 'no_open_position'
          : /immediate_execution/i.test(msg) ? 'immediate_execution'
          : /bracket_order_exists/i.test(msg) ? 'bracket_order_exists'
          : 'other';
        if (code === 'other') {
          logError(`[${accountName}] ✖ LIVE bracket set FAILED: ${summary}: ${e.message}`);
          notifyLiveFailure({ account: accountName, context: `Exit bracket (${String(side).toUpperCase()}) set FAILED on ${symbol} — risk exit may be unprotected`, error: e, extra: `[${tag}]` });
        } else {
          // Expected/benign (leg already protected, already closed, or level breached) —
          // log calmly, no "FAILED" and no alarm.
          log(`[${accountName}] ℹ️ LIVE bracket not set (${code}): ${summary} — expected/benign, no action needed.`);
        }
        return { ok: false, error: e.message, code };
      }
    },

    /**
     * Place a resting reduce_only STOP (market) order triggered on the INDEX
     * (spot_price). Used for the short-leg SL and long-leg TP in the live model.
     * `side` is the closing side (buy to close a short, sell to close a long).
     */
    async placeStop({ symbol, side, contracts, stopPrice, tag, triggerMethod = 'spot_price' }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const size = Math.max(1, Math.round(contracts || 0));
      const stopStr = cleanLimitPrice(stopPrice);
      const summary = `STOP ${side.toUpperCase()} ${size}x ${symbol} trigger@${triggerMethod} ${stopStr ?? '—'} reduceOnly [${tag}]`;

      if (DRY_RUN) {
        log(`[${accountName}] 🧪 DRY-RUN stop order (not sent): ${summary}`);
        return { ok: true, dryRun: true };
      }
      if (!creds?.apiKey || !creds?.apiSecret) {
        if (!warnedNoCreds) { logError(`[${accountName}] LIVE armed but no credentials — cannot place stop.`); warnedNoCreds = true; }
        return { ok: false, error: 'no-credentials' };
      }
      if (!stopStr) {
        logError(`[${accountName}] LIVE stop skipped — no valid stop price: ${summary}`);
        return { ok: false, error: 'no-stop-price' };
      }
      try {
        const order = await placeOrder(creds, {
          product_symbol: symbol,
          size,
          side,
          order_type: 'market_order',
          stop_order_type: 'stop_loss_order',
          stop_price: stopStr,
          stop_trigger_method: triggerMethod, // 'spot_price' (index) or 'mark_price' (option price)
          reduce_only: true,
          client_order_id: clampClientOrderId(tag),
        });
        log(`[${accountName}] ✅ LIVE stop placed: ${summary} → id ${order?.id ?? '?'} state ${order?.state ?? '?'}`);
        return { ok: true, order };
      } catch (e) {
        logError(`[${accountName}] ✖ LIVE stop FAILED: ${summary}:`, e.message);
        notifyLiveFailure({ account: accountName, context: `Reduce-only STOP placement FAILED (${side} ${symbol}) — exit stop not resting`, error: e, extra: `[${tag}]` });
        return { ok: false, error: e.message };
      }
    },

    /**
     * Cancel a resting order by id (armed accounts only, no-op in dry-run). Used to
     * pull the resting short-exit / ladder orders when a position closes another way,
     * so a stale reduce-only order can't later fire against a re-entered position on
     * the same symbol. `productId` is required by Delta's cancel endpoint.
     */
    async cancelStop({ id, productId }) {
      if (!armed() || DRY_RUN) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey || id == null) return { ok: false, error: 'no-id-or-creds' };
      try {
        await cancelOrder(creds, { id, product_id: productId });
        log(`[${accountName}] 🧹 Cancelled resting order id ${id}`);
        return { ok: true };
      } catch (e) {
        logWarn(`[${accountName}] cancelStop failed for id ${id}: ${e.message}`);
        return { ok: false, error: e.message };
      }
    },

    /**
     * Flatten the whole account in one Delta call (close_all). Returns { ok, res }
     * on success; callers should fall back to per-position closes on { ok: false }.
     * No-op (skipped) unless armed; dry-run logs only.
     */
    async closeAll() {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      if (DRY_RUN) {
        log(`[${accountName}] 🧪 DRY-RUN close-all (not sent): POST /v2/positions/close_all`);
        return { ok: true, dryRun: true };
      }
      if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, error: 'no-credentials' };
      try {
        const res = await closeAllPositions(creds);
        log(`[${accountName}] ✅ LIVE close-all sent (account flattened)`);
        return { ok: true, res };
      } catch (e) {
        logError(`[${accountName}] ✖ LIVE close-all FAILED (falling back to per-position):`, e.message);
        return { ok: false, error: e.message };
      }
    },

    /**
     * Raw open positions from the exchange. Returns [] when not armed / no creds
     * (legitimately "no live positions"), but returns NULL on a fetch FAILURE so
     * callers can tell an API hiccup apart from a genuinely-flat account. This
     * distinction is safety-critical: the live exit model infers "leg filled" from
     * an absent position, so a failed fetch misread as [] would phantom-exit the
     * entire book at once.
     */
    async positions() {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        const res = await getLivePositions(creds);
        return Array.isArray(res) ? res : [];
      } catch (e) {
        logWarn(`[${accountName}] positions() fetch failed: ${e.message}`);
        return null;
      }
    },

    /**
     * Live USDT wallet balance (armed accounts only). This is a READ, so it runs
     * even in dry-run — the sizing math needs the real balance to be validated.
     * Returns null if not armed, no creds, or the balance can't be read.
     */
    async walletBalance() {
      if (!armed()) return null;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return null;
      try {
        const balances = await getBalance(creds);
        return extractBalance(balances);
      } catch (e) {
        logWarn(`[${accountName}] Wallet balance fetch failed: ${e.message}`);
        return null;
      }
    },

    /** Raw resting orders from the exchange (armed accounts only), else []. */
    async orders() {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        const res = await getLiveOrders(creds);
        return Array.isArray(res) ? res : [];
      } catch (e) {
        logWarn(`[${accountName}] orders() fetch failed: ${e.message}`);
        return [];
      }
    },

    /** Recent fills from the exchange (armed accounts only), else []. */
    async fills() {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        const res = await getFills(creds);
        return Array.isArray(res) ? res : [];
      } catch (e) {
        logWarn(`[${accountName}] fills() fetch failed: ${e.message}`);
        return [];
      }
    },

    /**
     * Set of Delta `order_id`s that have at least one recent fill — used by the
     * resting-exit model to detect when a resting order has executed (its order id
     * appears here). Order ids are matched (not client tags) because Delta fills
     * carry `order_id`; we persist each resting order's id, so detection survives a
     * restart. Returns null on fetch failure so callers hold rather than mis-read an
     * empty result. Not-armed → empty set.
     */
    async recentFillOrderIds() {
      if (!armed()) return new Set();
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return new Set();
      try {
        const res = await getFills(creds, { pageSize: 100 });
        const set = new Set();
        if (Array.isArray(res)) for (const f of res) { if (f.order_id != null) set.add(String(f.order_id)); }
        return set;
      } catch (e) {
        logWarn(`[${accountName}] recentFillOrderIds() fetch failed: ${e.message}`);
        return null;
      }
    },

    /**
     * One combined READ snapshot for the UI: positions, orders (split into resting
     * limit orders vs stop orders), fills, and wallet balances. Armed accounts only
     * (runs in dry-run too — these are reads). Each source is fetched independently
     * so one failing endpoint doesn't blank the whole snapshot. Returns null if not
     * armed / no creds.
     */
    async snapshot({ includeHistory = true } = {}) {
      if (!armed()) return null;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return null;
      // Order history is large and paginates (several sequential round-trips), so
      // it's the slowest part of a snapshot. It's not time-critical, so callers can
      // skip it on most ticks (includeHistory=false) to keep the frequent refresh
      // fast; positions/orders/fills/balance are one parallel call each.
      const calls = [
        getLivePositions(creds),
        getLiveOrders(creds),
        getFills(creds),
        getBalance(creds),
      ];
      if (includeHistory) calls.push(getOrderHistory(creds));
      const results = await Promise.allSettled(calls);
      const [posR, ordR, fillR, balR, histR] = results;
      const arr = (r) => (r && r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
      if (results.some(r => r.status === 'rejected')) {
        const first = results.find(r => r.status === 'rejected');
        logWarn(`[${accountName}] snapshot() partial failure: ${first?.reason?.message || 'unknown'}`);
      }
      const allOrders = arr(ordR);
      const isStop = (o) => !!(o.stop_order_type || o.stop_price != null);
      const balances = arr(balR);
      return {
        positions: arr(posR),
        orders: allOrders.filter(o => !isStop(o)),
        stopOrders: allOrders.filter(isStop),
        fills: arr(fillR),
        orderHistory: includeHistory ? arr(histR) : null, // null → caller keeps cached
        balances,
        wallet: extractBalance(balances),
      };
    },

    /** Log-only reconciliation: compare engine position count with the exchange. */
    async reconcile(enginePositionCount) {
      if (!armed() || DRY_RUN) return;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return;
      try {
        const live = await getLivePositions(creds);
        const openLive = Array.isArray(live) ? live.filter(p => Number(p.size) !== 0).length : 0;
        // Exchange positions are per-leg; the engine counts spreads (1–2 legs each),
        // so this is informational — flag only the clearly-wrong "engine open but
        // exchange flat" case.
        if (enginePositionCount > 0 && openLive === 0) {
          logWarn(`[${accountName}] RECONCILE: engine holds ${enginePositionCount} position(s) but Delta reports 0 open legs — review manually.`);
        } else {
          log(`[${accountName}] Reconcile: engine ${enginePositionCount} spread(s) / Delta ${openLive} open leg(s).`);
        }
      } catch (e) {
        logWarn(`[${accountName}] Reconcile check failed: ${e.message}`);
      }
    },
  };
}
