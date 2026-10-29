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
import { placeOrder, cancelOrder, editOrder, editBracket, placeBracketOrder, closeAllPositions, getLivePositions, getBalance, getLiveOrders, getFills, getOrderHistory, getOrderHistorySinceFull, getWalletTransactionsSince } from './deltaTradeApi.js';
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
export function marketableChasePrice(side, quote, offset = 0, bump = 0, bumpPct = 0) {
  const q = quote || {};
  const ref = side === 'buy'
    ? (q.ask ?? q.lastPrice ?? q.markPrice)
    : (q.bid ?? q.lastPrice ?? q.markPrice);
  if (ref == null || !Number.isFinite(Number(ref))) return null;
  const r = Number(ref);
  // The cross must SCALE WITH THE PREMIUM, not be a flat dollar amount. A flat $1 bump is
  // 0.5% of a $200 option and 5% of a $20 one, so on expensive legs the escalation was
  // pure noise: an entry chase on a $200 call moved 193 → 201 while the real book had run
  // past 210, filled ZERO contracts, and aborted — then the identical (larger) order filled
  // instantly a minute later at 221. Take whichever cross is LARGER, so cheap legs keep the
  // flat floor and expensive legs actually reach the market.
  // Clamped to half the premium so the FLAT term can never eat a cheap leg alive: with
  // min_sell_premium at 10 and a $2 flat bump, a short leg was being re-priced from a bid
  // of 10 down to 5 — half the premium given away to chase a fill. Never binds on the case
  // this exists for (50% of a $189 call is $94, far past any cross we'd ever need).
  const raw = Math.max(Number(bump) || 0, Math.abs(r) * ((Number(bumpPct) || 0) / 100));
  const cross = Math.min(raw, Math.abs(r) * 0.5);
  return side === 'buy'
    ? r + offset + cross
    : Math.max(0.05, r - offset - cross);
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
 * Total AND free balance of the same wallet extractBalance() picks, from one response.
 * `available` is Delta's available_balance: what is left after the margin Delta itself
 * blocks for open positions and orders (the "Available Margin" on the order ticket).
 * Null when Delta didn't send it, so callers can fall back to the engine's estimate.
 */
export function extractWalletSnapshot(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return null;
  const sym = (b) => String(b.asset_symbol || b.asset?.symbol || '').toUpperCase();
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const amt = (b) => num(b.balance ?? b.available_balance ?? b.wallet_balance) ?? 0;
  const pick =
    balances.find((b) => sym(b) === 'USDT') ||
    balances.find((b) => sym(b) === 'USD') ||
    [...balances].sort((a, b) => amt(b) - amt(a))[0];
  if (!pick) return null;
  return { balance: amt(pick), available: num(pick.available_balance) };
}

/**
 * @param getCtx () => ({ accountName, mode, liveEnabled, creds, telegramChatId })
 *   `creds` = { apiKey, apiSecret } or null.
 *   `telegramChatId` = the account's own Telegram chat id for per-account failure
 *   routing (falls back to the global default when unset).
 */
export function createLiveExecutor(getCtx) {
  let warnedNoCreds = false;

  function armed() {
    const { mode, liveEnabled } = getCtx();
    return mode === 'live' && !!liveEnabled;
  }

  async function submit({ symbol, side, contracts, price, reduceOnly = false, tag, bracket = null }) {
    const { accountName, creds, telegramChatId } = getCtx();
    const size = Math.max(1, Math.round(contracts || 0));
    const priceStr = cleanLimitPrice(price);
    const brkStr = bracket
      ? ` +bracket{${bracket.bracket_take_profit_price ? 'TP@' + bracket.bracket_take_profit_price : ''}${bracket.bracket_stop_loss_price ? ' SL@' + bracket.bracket_stop_loss_price : ''} via ${bracket.bracket_stop_trigger_method || 'mark'}}`
      : '';
    const summary = `${side.toUpperCase()} ${size}x ${symbol} @ ${priceStr ?? '—'}${reduceOnly ? ' reduceOnly' : ''}${brkStr} [${tag}]`;

    if (DRY_RUN) {
      log(`[${accountName}] ⚗ DRY-RUN live order (not sent): ${summary}`);
      return { ok: true, dryRun: true };
    }

    if (!creds?.apiKey || !creds?.apiSecret) {
      if (!warnedNoCreds) {
        logError(`[${accountName}] LIVE armed but no decrypted credentials available — cannot place orders. (Is the engine using the service_role key?)`);
        notifyLiveFailure({ account: accountName, context: 'Armed live but NO Delta credentials — orders cannot be placed', extra: 'Check the engine service_role key / stored credentials.', chatId: telegramChatId });
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
      // A `duplicate_client_order_id` rejection means an order with this exact
      // deterministic tag was ALREADY placed on Delta — so the intended order is in
      // fact resting. This is the idempotency guard working as designed: two reconcilers
      // can react to one short-flat event and both try to place the same `-LE-*` ladder
      // slice (a known, benign race — see docs/LLD.md). The second placement is rejected,
      // which PREVENTS a double ladder. Nothing is wrong on the exchange, so log calmly
      // and treat as success — never fire the "FAILED" alarm.
      if (/duplicate_client_order_id/i.test(msg)) {
        log(`[${accountName}] ℹ️ Duplicate order no-op (${side} ${symbol}) — already placed on Delta [${tag}] (idempotent re-attempt).`);
        return { ok: true, duplicate: true };
      }
      logError(`[${accountName}] ✖ LIVE order FAILED: ${summary}:`, e.message);
      notifyLiveFailure({ account: accountName, context: `Order send FAILED (${side} ${symbol})`, error: e, extra: `[${tag}]`, chatId: telegramChatId });
      return { ok: false, error: e.message };
    }
  }

  // Reduce-only MARKET close of a single leg by symbol. Shared by the public
  // closeSymbol() action and openSpread's abort/unwind paths.
  async function marketClose({ symbol, side, contracts, tag }) {
    if (!armed()) return { ok: true, skipped: true };
    const { accountName, creds, telegramChatId } = getCtx();
    const size = Math.max(1, Math.round(Math.abs(contracts || 0)));
    const summary = `CLOSE ${side.toUpperCase()} ${size}x ${symbol} reduceOnly [${tag}]`;
    if (DRY_RUN) { log(`[${accountName}] ⚗ DRY-RUN close-symbol (not sent): ${summary}`); return { ok: true, dryRun: true }; }
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
      notifyLiveFailure({ account: accountName, context: `Reduce-only CLOSE FAILED (${side} ${symbol}) — leg may still be OPEN on Delta`, error: e, extra: `[${tag}]`, chatId: telegramChatId });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Entry fill by MODIFYING the same limit order (no cancel, no market order):
   *   place the limit (with its bracket) → every `waitMs`, while not fully filled, edit its
   *   price — sell → `sellPx` (default $1, i.e. take any bid), buy → mark + `buyMarkPlus`
   *   (default +50, re-read from the latest mark each time) — `tries` times in all (default
   *   6 → 5s … 30s). Editing keeps the order id AND its bracket.
   * Only if it is STILL not fully filled after the last edit (an empty book) is the rest
   * cancelled, as a last resort: a resting entry order that fills later would open a position
   * the engine doesn't know about (that is how Biswal's untracked short was created).
   * Returns { ok, filled, unfilled, id, productId, order, rejected?, unknown?, lastResortCancel? }.
   */
  async function submitTimed({ symbol, side, contracts, price, tag, bracket = null, timing }) {
    const first = await submit({ symbol, side, contracts, price, reduceOnly: false, tag, bracket });
    if (!first.ok) return { ok: false, error: first.error, filled: 0, rejected: true };
    if (first.dryRun || first.skipped) return { ok: true, order: first.order, filled: contracts };

    const { accountName, creds } = getCtx();
    const total = Math.max(1, Math.round(contracts));
    const id = first.order?.id;
    const productId = first.order?.product_id;
    let unfilled = Number(first.order?.unfilled_size);
    if (!Number.isFinite(unfilled)) unfilled = total;
    if (unfilled === 0 || String(first.order?.state) === 'closed') {
      return { ok: true, order: first.order, id, productId, filled: total, unfilled: 0 };
    }

    const waitMs = Math.max(1000, timing?.waitMs ?? 5000);
    const pollMs = Math.max(250, timing?.pollMs ?? 1000);
    const tries = Math.max(1, Math.round(timing?.tries ?? 6));
    const sellPx = Number(timing?.sellPx ?? 1);
    const buyMarkPlus = Number(timing?.buyMarkPlus ?? 50);

    // Wait `ms`, polling; true as soon as the order is fully filled.
    const waitForFill = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(Math.min(pollMs, Math.max(0, ms - (Date.now() - t0))));
        const u = await unfilledContracts(creds, id);
        if (u === 0) return true;
        if (u != null) unfilled = u;
      }
      return false;
    };

    for (let k = 1; k <= tries; k++) {
      if (await waitForFill(waitMs)) return { ok: true, order: first.order, id, productId, filled: total, unfilled: 0 };
      let target;
      if (side === 'sell') {
        target = sellPx;
      } else {
        const q = timing?.quote?.(symbol) || {};
        const mark = Number(q.markPrice ?? q.lastPrice ?? q.ask ?? price);
        target = (Number.isFinite(mark) ? mark : Number(price)) + buyMarkPlus;
      }
      const newPx = cleanLimitPrice(Math.max(0.05, target));
      if (!newPx) continue;
      try {
        // Original total size: Delta keeps the filled part and re-rests the rest.
        await editOrder(creds, { id, product_id: productId, limit_price: newPx, size: total });
        log(`[${accountName}] ➤ ENTRY ${side} ${symbol}: ${unfilled} unfilled → modify ${k}/${tries} to ${newPx}${side === 'buy' ? ` (mark + ${buyMarkPlus})` : ''} [${tag}]`);
      } catch (e) {
        logWarn(`[${accountName}] entry modify ${k}/${tries} failed for ${symbol} [${tag}]: ${e.message}`);
      }
    }
    // A last short wait for the final modify to land.
    if (await waitForFill(Math.min(waitMs, 3000))) return { ok: true, order: first.order, id, productId, filled: total, unfilled: 0 };

    // LAST RESORT (empty book after every modify): cancel the rest so it can't fill later as
    // an untracked position, and read what DID fill.
    let filled = null;
    try {
      const c = await cancelOrder(creds, { id, product_id: productId });
      const sz = Number(c?.size);
      const uf = Number(c?.unfilled_size);
      if (Number.isFinite(sz) && Number.isFinite(uf)) filled = Math.max(0, Math.round(sz - uf));
    } catch { /* already closed (filled), or a transient failure — fall through */ }
    if (filled == null) {
      const u = await unfilledContracts(creds, id);
      if (u != null && u > 0) await cancelOrder(creds, { id, product_id: productId }).catch(() => {});
      let rows = null;
      for (let i = 0; i < 3 && rows == null; i++) {
        if (i > 0) await sleep(500);
        try { const r = await getLivePositions(creds); rows = Array.isArray(r) ? r : null; } catch { rows = null; }
      }
      if (rows == null) {
        return { ok: false, unknown: true, id, productId, order: first.order, filled: 0, unfilled: total, error: 'final fill unreadable after cancel' };
      }
      const size = Number(rows.find((r) => r.product_symbol === symbol)?.size) || 0;
      filled = Math.min(total, side === 'buy' ? Math.max(0, size) : Math.max(0, -size));
    }
    logWarn(`[${accountName}] ⏱ ENTRY ${side} ${symbol}: only ${filled}/${total} filled after ${tries} modifies — rest cancelled (last resort, empty book) [${tag}]`);
    return { ok: filled >= total, order: first.order, id, productId, filled, unfilled: total - filled, lastResortCancel: filled < total };
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
    // RATCHET: the chase may only ever move TOWARD the market. Each attempt re-derives the
    // price from the CURRENT quote, so a quote drifting the other way produces a price
    // WEAKER than the previous attempt and silently undoes the escalation. Observed
    // 2026-08-28: attempt 1 priced 110.94 off an ask of 98, attempt 2 priced 110.70 off an
    // ask of 95 — the 3%→6% step went BACKWARDS and that attempt was wasted. A limit is a
    // ceiling (buy) / floor (sell), so holding the more aggressive of the two costs nothing:
    // the fill still happens at whatever is resting in the book, not at our limit.
    let bestPx = Number.isFinite(Number(price)) ? Number(price) : null;
    let readFailures = 0;
    // Did ANY state read succeed? If none ever does we must not pretend to know whether
    // this order filled — see the `unknown` return below.
    let everRead = false;
    for (let a = 1; a <= attempts; a++) {
      await sleep(pollMs);
      const u = await unfilledContracts(creds, id);
      if (u == null) {
        // Read failed (timeout / 429 / transient). This says NOTHING about the order, so
        // it must not consume an escalation step: `a--` keeps the cross where it is and
        // retries the read. Bounded by `readFailures` so a persistently dead endpoint
        // can't spin here forever.
        if (++readFailures <= attempts) { a--; continue; }
        break;
      }
      everRead = true;
      if (u === 0) { unfilled = 0; break; }
      unfilled = u;
      // Re-price toward the market, escalating the cross each attempt. BOTH the flat and
      // the percentage component scale with the attempt number; marketableChasePrice takes
      // whichever is larger (see there).
      const bump = (chase.bump ?? 1) * a;
      const bumpPct = (chase.bumpPct ?? 0) * a;
      const quoted = marketableChasePrice(side, chase.quote?.(symbol), offset, bump, bumpPct);
      if (quoted == null) continue;
      // Ratchet against the best price sent so far (see above) — never step back.
      let stepped = bestPx == null
        ? quoted
        : (side === 'buy' ? Math.max(bestPx, quoted) : Math.min(bestPx, quoted));
      // Optional ceiling on a BUY chase (the hedge: never above its ask + hedge offset).
      const cap = side === 'buy' && Number.isFinite(Number(chase.maxPrice)) ? Number(chase.maxPrice) : null;
      if (cap != null) stepped = Math.min(stepped, cap);
      const newPx = cleanLimitPrice(stepped);
      if (!newPx) continue;
      // Already at the ceiling — nothing better to send; keep polling for the fill.
      if (cap != null && bestPx != null && Number(newPx) === bestPx) continue;
      bestPx = Number(newPx);
      try {
        // Send the ORIGINAL total size: Delta keeps the already-filled portion and
        // re-rests the remainder at the new price (a smaller size would be < filled).
        await editOrder(creds, { id, product_id: productId, limit_price: newPx, size: Math.max(1, Math.round(contracts)) });
        log(`[${accountName}] ➤ CHASE ${side} ${symbol}: ${unfilled} unfilled → reprice ${newPx} (attempt ${a}/${attempts}, cross +${bumpPct ? Math.max(bump, 0).toFixed(2) + '/' + bumpPct.toFixed(2) + '%' : bump}) [${tag}]`);
      } catch (e) {
        logWarn(`[${accountName}] chase reprice failed for ${symbol} [${tag}]: ${e.message}`);
      }
    }
    // Final verdict. Retry the last read a few times: this one decides whether the caller
    // unwinds a real position, so a single transient failure must not settle it.
    let uFinal = null;
    for (let i = 0; i < 3 && uFinal == null; i++) {
      if (i > 0) await sleep(400);
      uFinal = await unfilledContracts(creds, id);
    }
    if (uFinal != null) { everRead = true; unfilled = uFinal; }

    // If NO read ever succeeded, `unfilled` still holds the optimistic starting guess —
    // it is not evidence. Concluding "unfilled" from it made the caller abort and cancel
    // an order that may in fact have FILLED, leaving a live position the engine had no
    // row for (reconcileOrphans then had to adopt it ~30s later). Report the state as
    // UNKNOWN instead and let the caller unwind defensively.
    const unknown = !everRead;
    const filled = unknown ? 0 : Math.max(0, contracts - unfilled);
    return {
      ok: !unknown && unfilled === 0,
      order: first.order, id, productId, filled, unfilled, unknown,
      ...(unknown ? { error: 'order state unreadable after chase (Delta reads failing)' } : {}),
    };
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
    async openSpread(pos, { long, short, buyPrice, sellPrice, longTp = null, shortSl = null, chase = null, timing = null }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();

      // ── Timed entry (see submitTimed): long first, then short, each a limit order that is
      // MODIFIED every 5s (sell → $1, buy → mark + 50), 6 times. Partial long → short sized to
      // it. Partial short → long cut to the ratio. No short at all → exit (close the long).
      // Returns the FINAL contracts.
      if (timing) {
        const buyBracketT = (longTp != null && Number.isFinite(longTp))
          ? { bracket_take_profit_price: String(longTp), bracket_stop_trigger_method: 'spot_price' }
          : null;
        const buy = await submitTimed({
          symbol: pos.buyLeg.symbol, side: 'buy', contracts: long,
          price: buyPrice ?? pos.entryBuyPrice, tag: `${pos.id}-EB`, bracket: buyBracketT,
          timing,
        });
        if (buy.rejected) return { ok: false, legFailed: 'buy', error: buy.error, rejected: true };
        if (buy.unknown) {
          logWarn(`[${accountName}] ⚠ Entry BUY state UNREADABLE for ${pos.id} — cancelling and reduce-only closing ${long} to guarantee flat.`);
          if (buy.id) await cancelOrder(creds, { id: buy.id, product_id: buy.productId }).catch(() => {});
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: long, tag: `${pos.id}-EAB` }).catch(() => {});
          return { ok: false, legFailed: 'buy', error: buy.error };
        }
        const longFilled = Math.min(Math.round(long), buy.filled || 0);
        if (longFilled <= 0) {
          return { ok: false, legFailed: 'buy', error: 'long not filled after modifies' };
        }
        if (!(short > 0)) return { ok: true, buyOrder: buy.order, longContracts: longFilled, shortContracts: 0 };

        // Short sized to the long that actually filled (same 1:ratio).
        const ratio = short / long;
        const shortTarget = longFilled === Math.round(long) ? Math.round(short) : Math.round(longFilled * ratio);
        if (shortTarget < 1) {
          logWarn(`[${accountName}] ⚠ Entry for ${pos.id}: only ${longFilled} long filled — too small for a short at 1:${ratio.toFixed(2)}; closing the long.`);
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: longFilled, tag: `${pos.id}-EAB` }).catch(() => {});
          return { ok: false, legFailed: 'buy', error: 'partial long too small for a short' };
        }
        if (longFilled < Math.round(long)) {
          log(`[${accountName}] ◐ Entry ${pos.id}: long ${longFilled}/${Math.round(long)} filled — short sized to ${shortTarget}.`);
        }

        const sellBracketT = (shortSl != null && Number.isFinite(shortSl))
          ? { bracket_stop_loss_price: String(shortSl), bracket_stop_trigger_method: 'spot_price' }
          : null;
        const sell = await submitTimed({
          symbol: pos.sellLeg.symbol, side: 'sell', contracts: shortTarget,
          price: sellPrice ?? pos.entrySellPrice, tag: `${pos.id}-ES`, bracket: sellBracketT,
          timing,
        });
        if (sell.rejected || sell.unknown || !(sell.filled > 0)) {
          // No short (rejected / nothing filled / unreadable) → exit: close the long.
          if (sell.unknown) {
            if (sell.id) await cancelOrder(creds, { id: sell.id, product_id: sell.productId }).catch(() => {});
            await marketClose({ symbol: pos.sellLeg.symbol, side: 'buy', contracts: shortTarget, tag: `${pos.id}-EAS` }).catch(() => {});
          }
          logError(`[${accountName}] ⚠ Entry SELL ${sell.rejected ? 'rejected' : sell.unknown ? 'state unreadable' : 'not filled'} for ${pos.id} — closing the long (${longFilled}) to exit.`);
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: longFilled, tag: `${pos.id}-EAB` }).catch(() => {});
          return { ok: false, legFailed: 'sell', error: sell.error || 'short not filled', rejected: !!sell.rejected, buyOrder: buy.order };
        }

        // Partial short → cut the long back to the ratio (sell only the excess long).
        let longKeep = longFilled;
        if (sell.filled < shortTarget) {
          longKeep = Math.min(longFilled, Math.max(1, Math.round(sell.filled / ratio)));
          const excess = longFilled - longKeep;
          if (excess > 0) {
            await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: excess, tag: `${pos.id}-EADJ` }).catch(() => {});
          }
          logWarn(`[${accountName}] ◐ Entry ${pos.id}: short ${sell.filled}/${shortTarget} filled — long adjusted ${longFilled}→${longKeep} to keep 1:${ratio.toFixed(2)}.`);
        }
        return { ok: true, buyOrder: buy.order, sellOrder: sell.order, longContracts: longKeep, shortContracts: sell.filled };
      }

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
        if (buy.unknown) {
          // We could not read the order's state at all, so we do not know whether it
          // filled. Do BOTH, in this order, and let each no-op if it doesn't apply:
          // cancel (kills it if still resting, so it can't fill mid-cleanup) then a
          // reduce-only close of the FULL size (flattens it if it did fill; Delta's
          // `no_position_for_reduce_only` is already treated as benign). Cancelling
          // alone was the bug — a filled order has nothing to cancel and was left live.
          logWarn(`[${accountName}] ⚠ Entry BUY state UNREADABLE for ${pos.id} — cancelling and reduce-only closing ${long} to guarantee flat.`);
          if (buy.id) await cancelOrder(creds, { id: buy.id, product_id: buy.productId }).catch(() => {});
          await marketClose({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: long, tag: `${pos.id}-EAB` }).catch(() => {});
        } else if (buy.filled > 0) {
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
          if (sell.unknown) {
            // State unreadable — cancel then reduce-only close the FULL short (see the
            // buy-leg path above for why cancelling alone is not enough).
            if (sell.id) await cancelOrder(creds, { id: sell.id, product_id: sell.productId }).catch(() => {});
            await marketClose({ symbol: pos.sellLeg.symbol, side: 'buy', contracts: short, tag: `${pos.id}-EAB` }).catch(() => {});
          } else if (sell.filled > 0) {
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
     * Open a HEDGED spread with all three entry orders sent AT THE SAME TIME (long `-EB`,
     * short `-ES`, hedge `-HB`), so no leg waits on another and the quotes they were sized on
     * are as fresh as possible. The caller only sends it after every pre-check passed for all
     * three legs (fresh two-sided quotes, top-of-book depth, cross-account depth budget).
     * Long / short fill exactly like openSpread's timed path (modify every waitMs); the hedge
     * is chased but never above `hedgePrice` (its ask + Hedge Offset) and the rest cancelled.
     * Then, all-or-nothing:
     *   • every leg fully filled          → ok.
     *   • any leg filled 0 (or rejected)  → the other legs are market-closed (-EAB / -EAS /
     *                                       -HAB) and the entry aborts; account left flat.
     *   • partial fills                   → all three are cut to the SMALLEST filled fraction
     *                                       (excess closed: -EADJ / -SADJ / -HADJ), so the
     *                                       1 : ratio : hedge proportions hold.
     * A leg whose state can't be read is closed defensively at its full size (reduce-only can
     * only close what exists) — except a hedge on a symbol another pair also holds
     * (`hedgeShared`), which is reported instead (a full-size close could hit that pair's hedge).
     * Returns { ok, longContracts, shortContracts, hedgeContracts, legFailed?, error?, rejected? }.
     */
    async openTriplet(pos, { long, short, hedge, buyPrice, sellPrice, hedgePrice, longTp = null, shortSl = null, hedgeTp = null, hedgeShared = false, timing, hedgeChase }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const L = Math.max(1, Math.round(long));
      const S = Math.max(1, Math.round(short));
      const H = Math.max(1, Math.round(hedge));
      const spotBracket = (k, lvl) => (lvl != null && Number.isFinite(Number(lvl)))
        ? { [k]: String(lvl), bracket_stop_trigger_method: 'spot_price' } : null;

      const [b, s, h] = await Promise.all([
        submitTimed({ symbol: pos.buyLeg.symbol, side: 'buy', contracts: L, price: buyPrice, tag: `${pos.id}-EB`,
          bracket: spotBracket('bracket_take_profit_price', longTp), timing }),
        submitTimed({ symbol: pos.sellLeg.symbol, side: 'sell', contracts: S, price: sellPrice, tag: `${pos.id}-ES`,
          bracket: spotBracket('bracket_stop_loss_price', shortSl), timing }),
        submitChase({ symbol: pos.hedgeLeg.symbol, side: 'buy', contracts: H, price: hedgePrice, reduceOnly: false,
          tag: `${pos.id}-HB`, bracket: spotBracket('bracket_take_profit_price', hedgeTp), chase: hedgeChase }),
      ]);

      // Hedge not fully filled: cancel what still rests and read what DID fill.
      let hFilled = h.ok ? H : (Number(h.filled) || 0);
      if (!h.ok && !h.rejected && h.id != null) {
        try {
          const c = await cancelOrder(creds, { id: h.id, product_id: h.productId });
          const sz = Number(c?.size); const uf = Number(c?.unfilled_size);
          if (Number.isFinite(sz) && Number.isFinite(uf)) hFilled = Math.max(0, Math.round(sz - uf));
        } catch { /* already closed / gone — keep the chase's own count */ }
      }

      const legs = [
        { name: 'long', res: b, want: L, filled: b.ok ? L : Math.min(L, Number(b.filled) || 0), symbol: pos.buyLeg.symbol, close: 'sell', ab: 'EAB', adj: 'EADJ' },
        { name: 'short', res: s, want: S, filled: s.ok ? S : Math.min(S, Number(s.filled) || 0), symbol: pos.sellLeg.symbol, close: 'buy', ab: 'EAS', adj: 'SADJ' },
        { name: 'hedge', res: h, want: H, filled: Math.min(H, hFilled), symbol: pos.hedgeLeg.symbol, close: 'sell', ab: 'HAB', adj: 'HADJ' },
      ];
      const closeLeg = (leg, n, tagSuffix) => (n > 0
        ? marketClose({ symbol: leg.symbol, side: leg.close, contracts: n, tag: `${pos.id}-${tagSuffix}` }).catch(() => {})
        : Promise.resolve());

      const unknown = legs.filter(l => l.res.unknown);
      const failed = legs.find(l => l.res.rejected || l.res.unknown || l.filled <= 0);
      if (failed) {
        // Abort: flatten every leg that filled (unknown → its full size, unless a shared hedge).
        await Promise.all(legs.map(l => {
          if (l.res.unknown) {
            if (l.name === 'hedge' && hedgeShared) return Promise.resolve();
            return closeLeg(l, l.want, l.ab);
          }
          return closeLeg(l, l.filled, l.ab);
        }));
        const fills = legs.map(l => `${l.name} ${l.res.unknown ? '?' : l.filled}/${l.want}`).join(', ');
        logError(`[${accountName}] ⚠ Triplet entry ${pos.id} aborted — ${failed.name} ${failed.res.rejected ? 'rejected' : failed.res.unknown ? 'state unreadable' : 'not filled'} (${fills}); filled legs closed.`);
        return {
          ok: false,
          legFailed: failed.name,
          rejected: !!failed.res.rejected,
          error: failed.res.rejected ? (failed.res.error || 'rejected') : `${failed.name} not filled${failed.name === 'long' ? ' after modifies' : ''}`,
          unknownSharedHedge: unknown.some(l => l.name === 'hedge') && hedgeShared,
        };
      }

      // Partial fills → cut all three to the smallest filled fraction.
      const frac = Math.min(...legs.map(l => l.filled / l.want));
      if (frac < 1) {
        const keep = legs.map(l => Math.min(l.filled, Math.max(1, Math.round(l.want * frac))));
        await Promise.all(legs.map((l, i) => closeLeg(l, l.filled - keep[i], l.adj)));
        logWarn(`[${accountName}] ◐ Triplet entry ${pos.id}: filled ${legs.map(l => `${l.name} ${l.filled}/${l.want}`).join(', ')} — all cut to ${(frac * 100).toFixed(0)}%: long ${keep[0]}, short ${keep[1]}, hedge ${keep[2]}.`);
        return { ok: true, buyOrder: b.order, sellOrder: s.order, longContracts: keep[0], shortContracts: keep[1], hedgeContracts: keep[2] };
      }
      return { ok: true, buyOrder: b.order, sellOrder: s.order, longContracts: L, shortContracts: S, hedgeContracts: H };
    },

    /**
     * Open the triplet's 3rd leg — a stand-alone LONG-ONLY hedge — after the main
     * spread is open. Kept separate from openSpread so its client tag (`-HB`) never
     * collides with the main long's `-EB`, and so a fill failure is NON-fatal: unlike
     * entry, the caller drops the hedge leg and keeps the 2-leg position rather than
     * unwinding. No bracket — the hedge is engine-managed and exits with the triplet
     * (reduce-only `-HX` close). No-op for paper / unarmed.
     */
    // `tp`: the first long's TP (spot level) — attached as the hedge's own spot-triggered TP
    // bracket, so on Delta the hedge exits with its pair. null = no bracket (a hedge bought
    // onto a symbol another pair's hedge already holds: the engine sets that symbol's single
    // bracket to the farthest pair's level instead — syncSharedHedgeBrackets).
    async openHedge(pos, { contracts, price, chase = null, tp = null }) {
      if (!armed()) return { ok: true, skipped: true };
      const bracket = (tp != null && Number.isFinite(Number(tp)))
        ? { bracket_take_profit_price: String(tp), bracket_stop_trigger_method: 'spot_price' }
        : null;
      return submitChase({
        symbol: pos.hedgeLeg.symbol, side: 'buy', contracts,
        price: price ?? pos.hedgeLeg.entryPrice, reduceOnly: false, tag: `${pos.id}-HB`,
        bracket, chase,
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
     * A manual order punched from the dashboard's Trade tab (delta_order_requests).
     * `orderType` 'limit' (GTC at `price`) or 'market' (IOC). Unlike submit(), a rejection is
     * the user's own order, so it is returned for the UI to show — no Telegram alarm.
     * Returns { ok, order?, dryRun?, error? }.
     */
    async manualOrder({ symbol, side, contracts, orderType, price, reduceOnly = false, tag }) {
      if (!armed()) return { ok: false, error: 'Account is not armed for live trading.' };
      const { accountName, creds } = getCtx();
      const size = Math.round(Number(contracts) || 0);
      const isMarket = orderType === 'market';
      const priceStr = isMarket ? null : cleanLimitPrice(price);
      const summary = `MANUAL ${side.toUpperCase()} ${size}x ${symbol} ${isMarket ? '@ market' : `@ ${priceStr ?? '—'}`}${reduceOnly ? ' reduceOnly' : ''} [${tag}]`;
      if (size < 1) return { ok: false, error: 'Size must be at least 1 contract.' };
      if (!isMarket && !priceStr) return { ok: false, error: 'A limit order needs a valid price.' };
      if (DRY_RUN) { log(`[${accountName}] ⚗ DRY-RUN manual order (not sent): ${summary}`); return { ok: true, dryRun: true }; }
      if (!creds?.apiKey || !creds?.apiSecret) return { ok: false, error: 'No Delta credentials available to the engine.' };
      try {
        const order = await placeOrder(creds, {
          product_symbol: symbol, size, side,
          order_type: isMarket ? 'market_order' : 'limit_order',
          ...(isMarket ? { time_in_force: 'ioc' } : { limit_price: priceStr, time_in_force: 'gtc' }),
          reduce_only: !!reduceOnly,
          client_order_id: clampClientOrderId(tag),
        });
        log(`[${accountName}] ✅ LIVE manual order: ${summary} → id ${order?.id ?? '?'} state ${order?.state ?? '?'}`);
        return { ok: true, order };
      } catch (e) {
        logWarn(`[${accountName}] ✖ LIVE manual order rejected: ${summary}: ${e.message}`);
        return { ok: false, error: e.message };
      }
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
      if (DRY_RUN) { log(`[${accountName}] ⚗ DRY-RUN edit order (not sent): ${summary}`); return { ok: true, dryRun: true }; }
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
      if (DRY_RUN) { log(`[${accountName}] ⚗ DRY-RUN edit bracket (not sent): ${summary}`); return { ok: true, dryRun: true }; }
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
      const { accountName, creds, telegramChatId } = getCtx();
      const stopStr = cleanLimitPrice(stopPrice);
      const legObj = { order_type: 'market_order', stop_price: stopStr };
      const summary = `BRACKET ${String(side).toUpperCase()} ${symbol}${productId != null ? ` (pid ${productId})` : ''} @stop ${stopStr ?? '—'} via ${triggerMethod} [${tag}]`;
      if (DRY_RUN) { log(`[${accountName}] ⚗ DRY-RUN bracket set (not sent): ${summary}`); return { ok: true, dryRun: true }; }
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
          notifyLiveFailure({ account: accountName, context: `Exit bracket (${String(side).toUpperCase()}) set FAILED on ${symbol} — risk exit may be unprotected`, error: e, extra: `[${tag}]`, chatId: telegramChatId });
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
      const { accountName, creds, telegramChatId } = getCtx();
      const size = Math.max(1, Math.round(contracts || 0));
      const stopStr = cleanLimitPrice(stopPrice);
      const summary = `STOP ${side.toUpperCase()} ${size}x ${symbol} trigger@${triggerMethod} ${stopStr ?? '—'} reduceOnly [${tag}]`;

      if (DRY_RUN) {
        log(`[${accountName}] ⚗ DRY-RUN stop order (not sent): ${summary}`);
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
        notifyLiveFailure({ account: accountName, context: `Reduce-only STOP placement FAILED (${side} ${symbol}) — exit stop not resting`, error: e, extra: `[${tag}]`, chatId: telegramChatId });
        return { ok: false, error: e.message };
      }
    },

    /**
     * Cancel a resting order by id (armed accounts only, no-op in dry-run). Used to
     * pull the resting short-exit / ladder orders when a position closes another way,
     * so a stale reduce-only order can't later fire against a re-entered position on
     * the same symbol. `productId` is required by Delta's cancel endpoint.
     */
    /**
     * Cancel a resting order and report how much of it had filled, from Delta's cancel
     * response (size − unfilled_size). { ok: true, filled, unfilled } on a cancel; { ok: false,
     * gone: true } when Delta refuses the cancel (the order is no longer open — fully filled or
     * already cancelled). Armed real only.
     */
    async cancelAndReadFill({ id, productId }) {
      if (!armed() || DRY_RUN) return { ok: true, skipped: true, filled: null, unfilled: null };
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey || id == null) return { ok: false, error: 'no-id-or-creds' };
      try {
        const c = await cancelOrder(creds, { id, product_id: productId });
        const sz = Number(c?.size);
        const uf = Number(c?.unfilled_size);
        log(`[${accountName}] ⌫ Cancelled resting order id ${id}`);
        return {
          ok: true,
          filled: Number.isFinite(sz) && Number.isFinite(uf) ? Math.max(0, Math.round(sz - uf)) : null,
          unfilled: Number.isFinite(uf) ? Math.max(0, Math.round(uf)) : null,
        };
      } catch (e) {
        // A refused cancel means "no longer open" ONLY if the order really is off the book — a
        // timeout / 5xx / rate limit leaves it resting. Check the open orders before saying gone.
        let stillOpen = null;
        try {
          const open = await getLiveOrders(creds, { states: 'open,pending' });
          if (Array.isArray(open)) stillOpen = open.some(o => String(o.id) === String(id));
        } catch { /* unknown */ }
        if (stillOpen === false) return { ok: false, gone: true, error: e.message };
        logWarn(`[${accountName}] cancel of order ${id} failed and it may still be open: ${e.message}`);
        return { ok: false, transient: true, error: e.message };
      }
    },

    async cancelStop({ id, productId }) {
      if (!armed() || DRY_RUN) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey || id == null) return { ok: false, error: 'no-id-or-creds' };
      try {
        await cancelOrder(creds, { id, product_id: productId });
        log(`[${accountName}] ⌫ Cancelled resting order id ${id}`);
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
        log(`[${accountName}] ⚗ DRY-RUN close-all (not sent): POST /v2/positions/close_all`);
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

    /**
     * { balance, available } from one wallet read (armed accounts only), else null.
     * Live entry sizing uses `available` so it never sizes past Delta's real free margin.
     */
    async walletSnapshot() {
      if (!armed()) return null;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return null;
      try {
        return extractWalletSnapshot(await getBalance(creds));
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
     * Order history created since `sinceMs` (armed accounts only, else []). NULL on a fetch
     * failure so the daily report keeps its last known P&L instead of writing a wrong one.
     */
    async orderHistorySince(sinceMs) {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        return (await getOrderHistorySinceFull(creds, sinceMs, { maxPages: 50 })).items;
      } catch (e) {
        logWarn(`[${accountName}] orderHistorySince() fetch failed: ${e.message}`);
        return null;
      }
    },

    /**
     * Wallet-ledger entries since `sinceMs` (armed accounts only, else []). NULL on a fetch
     * failure so the daily report keeps its last known deposit total.
     */
    async walletTransactionsSince(sinceMs) {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        return (await getWalletTransactionsSince(creds, sinceMs, { maxPages: 50 })).items;
      } catch (e) {
        logWarn(`[${accountName}] walletTransactionsSince() fetch failed: ${e.message}`);
        return null;
      }
    },

    /**
     * Recent order history (filled + cancelled orders), newest first — armed accounts only,
     * else []. Returns NULL on a fetch failure so a caller proving a close can hold instead
     * of reading "no orders" as "no close".
     */
    async orderHistory({ maxPages = 3 } = {}) {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        const res = await getOrderHistory(creds, { pageSize: 100, maxPages });
        return Array.isArray(res) ? res : null;
      } catch (e) {
        logWarn(`[${accountName}] orderHistory() fetch failed: ${e.message}`);
        return null;
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
    // historyPages: how many 100-order pages of history to read (the engine reads only the
    // newest few on most refreshes and merges them into its cached list).
    async snapshot({ includeHistory = true, historyPages = 20 } = {}) {
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
      if (includeHistory) calls.push(getOrderHistory(creds, { maxPages: historyPages }));
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
        // null → caller keeps its cached history (not refreshed this time, OR the fetch
        // failed — a failure must not blank the history).
        orderHistory: includeHistory && histR?.status === 'fulfilled' && Array.isArray(histR.value) ? histR.value : null,
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
