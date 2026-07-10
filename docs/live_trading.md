# Live Trading — Linking a Delta Exchange Account

OptionScope started as a paper-trading-only workspace. This document describes the
work to link a **real Delta Exchange account** to an existing account so the engine
can eventually place **real orders**, mirroring the strategy that already runs in
paper mode.

The work is deliberately split into stages so real money is never at risk before the
whole path has been validated.

- **Stage 1 (implemented): credential linking.** An account can be flagged `live`,
  Delta API credentials can be attached and verified, and they are stored encrypted.
- **Stage 2 (implemented, dry-run by default): order execution.** The engine reads
  the decrypted credentials and places real limit orders at entry/exit, behind a
  global dry-run flag (`DELTA_LIVE_DRYRUN`, default ON) and the per-account
  `live_enabled` kill-switch. Until you set `DELTA_LIVE_DRYRUN=false` **and** arm an
  account, no real orders are sent.

---

## Account model

A `paper_trading_accounts` row now carries two extra columns:

| Column         | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `mode`         | `'paper'` (simulated, default) or `'live'` (linked to Delta Exchange).  |
| `live_enabled` | Kill-switch. Real orders stay OFF until this is explicitly `true`.      |

Switching an account back to `paper` in the UI also forces `live_enabled = false`.

## Credential storage & security model

Credentials live in a dedicated `delta_credentials` table (one row per account):

- `api_key` — the public identifier (sent in a header on every Delta request).
- `api_secret_enc` — the secret, encrypted at rest with `pgcrypto`
  (`pgp_sym_encrypt`) using a key held in **Supabase Vault**.
- `key_last4`, `status` (`unverified` / `verified` / `invalid`), `verified_at`.

Guarantees:

1. **The browser never reads the raw secret back.** Direct table access is denied to
   `anon`/`authenticated` by RLS. Clients write credentials only through the
   `SECURITY DEFINER` RPC `upsert_delta_credentials`, which checks account ownership
   and encrypts the secret server-side.
2. **Only the engine can decrypt.** `get_delta_credentials_decrypted` is the single
   decrypt path and is granted to `service_role` **only** — the headless engine uses
   it in Stage 2.
3. Owners can read non-secret metadata (api_key, last-4, status) via
   `get_delta_credentials_meta` for display in the Edit modal.

### One-time setup (run once in the Supabase SQL editor)

Apply the migration, then create the Vault encryption key:

```sql
-- 1. Apply schema (fresh installs: supabase_schema.sql already includes section 8;
--    existing DBs: run supabase_migrations/001_delta_live_accounts.sql)

-- 2. Create the encryption key (replace with a long random string, store it safely):
select vault.create_secret('REPLACE-WITH-LONG-RANDOM-STRING', 'delta_cred_encryption_key');
```

Without the Vault secret, `upsert_delta_credentials` raises
`Encryption key not configured` and no credentials can be stored.

## Verify flow (Stage 1)

When creating or editing a **live** account, the modal exposes API key + secret
inputs and a **Verify Connection** button. Verification
(`src/deltaAuth.js → verifyDeltaCredentials`) signs a test request **in the browser**
using the just-entered secret (Web Crypto HMAC-SHA256) and hits a lightweight
authenticated endpoint (`GET /v2/wallet/balances`) through the existing `/api` proxy.

The secret used for verification is the one the user just typed — nothing is read
back from storage, so verification introduces no exposure. On submit, the verified
flag is passed to `upsert_delta_credentials` so the stored row's `status` reflects it.

> Delta rejects signatures older than 5 seconds, so the request is signed immediately
> before sending.

## Delta Exchange auth reference

- **Base URL:** `https://api.india.delta.exchange` (same host used for market data).
- **Auth headers:** `api-key`, `signature`, `timestamp`.
- **Signature:** `HMAC_SHA256(secret, method + timestamp + requestPath + query + body)`,
  hex-encoded. `timestamp` is Unix seconds.
- **Order placement (Stage 2):** `POST /v2/orders` with `product_id`/`product_symbol`,
  `size`, `side` (`buy`/`sell`), `order_type` (`limit_order`), `limit_price` (string),
  `time_in_force`, `reduce_only`, `client_order_id`.

---

## Stage 2 — order execution (implemented)

**Engine components**

- `engine/lib/deltaTradeApi.js` — signed (HMAC-SHA256) client: `placeOrder`,
  `cancelOrder`, `editOrder`, `editBracket`, `changeBracketOrder` (position-level
  `POST /v2/positions/change_bracket_order`), `getLivePositions`, `getBalance`,
  `getLiveOrders`, `getFills`, `getOrderHistory`.
- `engine/lib/liveExecution.js` — the gated executor: `openSpread`, `closeLeg`,
  `editOrder`, `changePositionBracket`, `placeStop`, `cancelStop`, `positions`,
  `orders`, `fills`, `recentFillOrderIds`, `snapshot`, `walletBalance`, `reconcile`.
  Reads the `DELTA_LIVE_DRYRUN` flag and the per-account arm state.
- `engine/lib/supabase.js` — now prefers `SUPABASE_SERVICE_ROLE_KEY` so the engine
  can decrypt credentials.

**Execution hooks** in `engine/paperTradingEngine.js` — all gated on
`mode === 'live' && live_enabled`, added alongside the existing DB writes so paper
logic is byte-for-byte unchanged when paper/disarmed:

| Point | Live order |
| --- | --- |
| Entry (before `active_positions` insert) | Buy long @ ask + sell short @ bid (limit, `+entryBuyOffset`/`−entrySellOffset`). Each leg carries a **spot-triggered bracket** at the exit level (long → TP, short → SL). **A failed live send aborts the insert.** |
| Entry (resting short-exit, armed real) | Resting reduce-only **limit BUY** on the short @ `shortExitPrice` (`${id}-SEX`) — the short buy-back (profit), sitting in Open Orders |
| Short-leg exit | Active model: buy-to-close @ ask. Resting model: the `-SEX` limit fills **fully** (order-id in fills **and** short position size 0) → book + place ladder (short SL bracket auto-cancels) |
| Long laddered exit | Active model: sell reduce_only @ bid per level. Resting model: fixed-ladder resting **limit SELLs** fill on their own |
| Partial ratio scale-down | Sell-to-close the reduced buy lot (`reduce_only`) @ bid (active model only) |
| Risk exit (spot hits exit level) | **Brackets** close the whole spread exchange-side; engine's spot-cross catch-all (if up) also market-closes + books (reduce-only guards double-close) |
| **Expiry / zombie exit** | **No leg order** — Delta cash-settles expired options; brackets auto-cancel, resting orders cancelled |

All orders use limit orders at the engine's computed price and carry a
`client_order_id` derived from the position id + leg + stage (idempotency).

> [!NOTE]
> **Price sanitization (`cleanLimitPrice`).** Every limit/stop price is rounded to 4
> decimals and stringified before it is sent to Delta. Computed prices carry
> float-representation noise (e.g. `2.7 − 2 === 0.7000000000000002`); sending that raw
> makes Delta reject the order with **`bad_schema`** — a silent failure that, on the
> entry SELL leg, could leave an **orphan long** (the BUY filled, the SELL rejected).
> Inputs are already tick-aligned (exchange bid/ask/mark ± integer offsets), so rounding
> only strips the noise (`0.7000000000000002 → "0.7"`, `0.05 → "0.05"`). Applied
> centrally in `liveExecution.js` to entry buy/sell, the resting short buy-back
> (`closeLeg`), order edits (`editOrder`), and stops (`placeStop`).

**Safety layer**

- `DELTA_LIVE_DRYRUN` (default **true**): intended orders are logged (`🧪 DRY-RUN…`)
  but never sent.
- Per-account `live_enabled` kill-switch (schema + UI).
- Missing service_role key or missing credentials ⇒ live trading disabled; paper
  trading unaffected.
- `getLivePositions()` reconciliation runs on the 5-minute sync (log-only) and warns
  on drift between engine and exchange.

### ⚠ Open item — contract size mapping (validate in dry-run)

The paper engine sizes positions as **fractional notional lots** (contract_size
scaled). Delta orders take an **integer number of contracts**. The current mapping
(`longContracts` / `shortContracts` in `liveExecution.js`) is **best-effort**
(≈1 contract per long unit, rounded `sellQty` for the short) and rounds fractional
scale-downs up to a minimum of 1 contract.

**Before arming any account:** run in dry-run and confirm the logged `size` on each
`🧪 DRY-RUN` line matches the real contract quantity you intend to trade. If your
intended sizing differs (e.g. you trade fixed contract counts), the mapping needs to
be adjusted to your convention first.

### Live exit model — two paths

> **History:** the very first live iteration used a separate exchange-resting,
> index-triggered SL/TP model (short SL at the buy strike, long TP at the same level,
> fill-detected by polling `/v2/positions`). **Retired** — it diverged from the paper
> strategy and its spot-triggered stops fired prematurely for puts. The
> `handleLiveExit` / `computeIndexTriggerLevel` helpers remain **dormant** (uncalled).

Exit handling now depends on whether the engine is actually sending real orders:

| Account state | Exit model |
| --- | --- |
| **Paper**, or **dry-run live** (`DELTA_LIVE_DRYRUN=true`) | **Active model** — the exact paper exit logic (premium short buy-back @ `shortExitPrice`, laddered long, ATM partials, ATM/ITM/OTM / expiry). `live.closeLeg()` logs the intended orders in dry-run. |
| **Armed REAL live** (`live_enabled` + `DELTA_LIVE_DRYRUN=false`) | **Resting-order model** (`handleLiveRestingExit`) — exits rest in the exchange order book and fill on their own. |

#### Resting-order model (armed real)

Two mechanisms run together — **resting profit exits** (engine-detected) and
**exchange-native bracket risk exits** (fire even if the engine is down):

- **At entry:** the long buy and short sell each carry an exchange **bracket** (see
  below), and a resting reduce-only **limit BUY** rests on the short leg @
  `shortExitPrice` (default $1.1), tag `${id}-SEX` — the short buy-back (profit),
  sitting in Open Orders.
- **When the resting @1.1 fully fills** — detected by its `order_id` in recent
  `/v2/fills` (restart-safe, id persisted in `sell_leg`) **and** confirmed by the short
  leg's exchange position size reaching **0**: book the short exit (`${id}-SE` @ the limit
  price), convert to long-only, and place the **fixed long ladder** as resting **limit
  SELL** orders. (The short's SL bracket auto-cancels once the short is flat.)
  - **Why the size-0 confirmation:** an `order_id` appears in `/v2/fills` on the **first
    partial fill**, not only a full one. Laddering on a partial would drop long exit slices
    while the short is still partly bought back ("lot qty not full but exit slices appear").
    On a partial the engine **holds** until the remaining short contracts fill. A confirmed
    fill (order id in fills) means the reduce-only buy-back genuinely traded, so size 0 is a
    real close — a never-opened phantom short can't fill, so no separate open-latch is
    needed.
- **Fixed ladder** = 5 levels — `[10,20,30,40,50]` if the long bid < 25, else
  `[25,50,75,100,125]` — with the `S` long contracts split **evenly** across the levels
  (`≈ S/5` each; any remainder placed on the **highest** levels for a better price). Small
  longs degrade gracefully: `S ≤ 5` → one contract per level, fewer levels; `S = 1` → a
  single order (no ladder). Each slice books `${id}-LE-${stage}` @ its level as it fills.
- **Risk exit:** the brackets close the whole spread at the exit level exchange-side.
  The engine ALSO runs a redundant spot-cross / expiry catch-all (cancel resting +
  market-close + book `${id}`) for when it is up — reduce-only prevents double-close.
- **Fill-fetch guard & egress gating:** the exit loop runs ~1×/second. To keep Delta API
  load minimal, `/v2/fills` is fetched **only when this account holds a position for the
  current underlying** (an idle account polls nothing); a failed fetch (null) still makes
  the engine **hold** all positions that cycle rather than infer a fill from a missing
  result. The `/v2/positions` snapshot (for the size-0 short-close confirmation above) is
  fetched **only** while a short buy-back is mid-fill — i.e. its exit order id is already
  in `/v2/fills` — not every cycle. So steady state is: idle → no calls; positions open →
  fills only; short mid-exit → fills + positions for the brief close window.

**Bookkeeping** uses the same deterministic `trade_id`s and idempotent upserts as
paper. Slice PnL maps integer contracts back to fractional lots
(`lot = baseLot × contracts / S`); fills are booked at the resting limit price (fills
at that price or better), and `reconcile()` flags gross drift.

#### Exit-level brackets (the exchange-side risk exit)

At entry, `openSpread` attaches a **spot-triggered bracket** to each leg's order at the
shared exit-type level (`computeIndexTriggerLevel` — ATM = buy strike, ITM/OTM = ±
points), so the spread is protected even if the engine is down:

> [!NOTE]
> **Exit Type / Exit Points are now per-schedule-window** (`effectiveConfig`, migration
> `012`) with **active-window-governs** semantics. The bracket level is computed from the
> **window active at entry**. When the window later flips, the engine's own spot-cross
> catch-all follows the new active window (it market-closes at the new level while the
> engine is up); the exchange bracket for a window flip is **not** auto-moved and stays
> at the entry level as an engine-down backstop.
>
> **Changing `exitType` / `exitPoints` in the filters now MOVES the brackets** on
> already-open positions. `resyncRestingOrders` calls the **position-level** endpoint
> `POST /v2/positions/change_bracket_order` (via `live.changePositionBracket`) — long leg
> → TP, short leg (while still open) → SL — at the new exit level (using the active
> window's exit rule if one governs, else base config). Each leg stores its current
> bracket level (`buyLeg.brkLevel` / `sellLeg.brkLevel`, set at entry) so resync skips
> legs already at the target and only edits real drift. Idempotent; positions opened
> before this feature have no `brkLevel` and resync on the first change.
>
> This replaces the earlier removed `editBracket` path, which used the **order-level**
> `PUT /v2/orders/bracket` — that needs the parent order id + a matching limit price and
> only ever failed with `bad_schema`. The position-level endpoint targets the open leg
> directly. `resyncRestingOrders` also still re-syncs the **short buy-back limit price**
> (`shortExitPrice` → `editOrder`). The startup sync passes an all-`null` old config, so
> the bracket branch is skipped there (no edit spam) — brackets were already correct at
> entry.

- **Long buy** → `bracket_take_profit_price = exitLevel`
- **Short sell** → `bracket_stop_loss_price = exitLevel`
- both `bracket_stop_trigger_method: spot_price`.

A bracket **closes the whole leg** on trigger and is **auto-cancelled by Delta when its
position closes** (so a profit exit via the resting @1.1 / ladder clears the brackets;
no manual cancellation). This replaces the old mark-price disaster backstop.

**Trade-offs / verify on the first real trade:**
- **Spot-trigger direction for PUTs** — a spot bracket must fire only when spot
  *reaches* the level, not on placement. Brackets are attached to the position (so
  Delta knows the side), which should handle direction correctly — but confirm the put
  bracket does **not** fire immediately on entry.
- **Two orders rest on the short** (the @1.1 buy-back + the SL bracket) — confirm Delta
  accepts both simultaneously.

> **⚠ Dry-run cannot exercise the resting model** — resting orders need a real
> exchange to sit on, so dry-run live uses the active model. The first **small real**
> trade is the validation.

### Live position sizing — balance allocation (Sub-stage A)

Live accounts size positions from the **live Delta USDT wallet balance** (the paper
`$195k` figure is not the *budget*), while still honouring `$195k` as a **short-notional
ceiling** on the resulting quantity (see the max-qty cap below):

- Each account has a **`balance_allocation_pct`** (default **90**) — the share of
  wallet balance used for trading; the rest is buffer.
- **max positions** = peak concurrent positions across the base config and all active
  schedule windows (`max(numberOfCalls + numberOfPuts)`).
- **part** = `(balance × allocation%) ÷ max positions`.

**"1 unit" scale sizing (fill one part, keep the ratio).** The base unit is
**1 long : `ratioToUse` short** (`ratioToUse` = the ATM-scaled sell quantity). The unit
is scaled up to fill one part and both legs move together so the ratio is preserved:

1. **unit margin** = margin of ONE unit, using the **real per-contract underlying amount**
   (`contractValue`, e.g. 0.001 BTC) and the **current spot** —
   `calcMargin(entryBuyPrice, longCV, spot, ratioToUse, shortCV)`. Using the real contract
   value (not the paper `lotSize = 1`) makes the estimate match Delta's actual margin
   instead of blowing past the notional cap and pinning the size to 1.
2. **scale** = `part ÷ unit margin`, floored at **1** (min one unit).
3. **longC** = `round(scale)`; **shortC** = `round(longC × ratioToUse)` — the short follows
   the rounded long at the base ratio, so `1:ratio` stays exact. `adjustedLotSize =
   longLot × longC`, `adjustedSellQty = shortC`.

**Ratio-spread max-qty cap (`$195k` short notional).** A large wallet balance would
otherwise scale the spread past what the ratio spread itself supports. So after the
balance scale, the quantity is capped so the **short notional**
(`spot × short contracts × contract value`) never exceeds **`$195,000`** — the same
ceiling paper applies. Effectively **final qty = `min(balance-allocated qty, notional-cap
qty)`**:

- `maxShort = floor($195k ÷ (spot × shortCV))`, `maxLong = floor(maxShort ÷ ratioToUse)`.
- `longC` is capped to `maxLong` (min 1), `shortC` re-derived from it, with a final clamp
  so integer rounding can't push the short notional back over the cap.
- Balance funds **less** than the cap → the balance size wins unchanged. Balance funds
  **more** → the cap wins (logged `🧢 LIVE qty capped by ratio-spread max …: long X → Y`).

**Minimum one unit (no skip):** if even one unit's margin exceeds the part, `scale` stays
`1` and the engine trades that single unit anyway (warning `LIVE size: one unit … exceeds
1 part …`) — it does **not** skip the entry. The `$195k` clamp still applies to that unit.

> [!NOTE]
> The scaled lots are what the paper bookkeeping stores (and may be fractional). The
> **integer contract count sent to Delta** is `longContracts = longC` and
> `shortContracts = round(adjustedSellQty)` — since `adjustedSellQty` (`shortC`) is already
> a whole number, the on-exchange ratio matches the sized ratio (see the **contract-size
> mapping** open-item note above).

Paper accounts keep the `$195k` / 200× branch **unchanged** (the balance-sizing branch is
gated on `mode==='live' && live_enabled`; only live adds the balance scale on top of the
shared `$195k` notional ceiling). Dry-run logs the full breakdown
(`💰 LIVE size <TYPE> <buy>/<sell>: unit margin $… | part $… → scale …× | long … short …
(base 1:…) | est margin $… | cv …/…`) so the numbers — especially that the contract sizes
and margins match Delta's actual figures — **must be validated before arming**.

### Account controls — Start / Pause (live only)

Live accounts show controls in the account strip (paper accounts are unaffected):

- **Start Live** → sets `live_enabled=true` (arms the account). Real sends are still
  gated by the engine's `DELTA_LIVE_DRYRUN`. **Disarm** clears it.
- **Pause** → sets `paused=true`. The engine then opens **no new positions** but
  keeps managing open ones (active exits continue; the short-leg disaster backstop
  stays in place). **Resume** clears it. A `PAUSED` badge shows on the account.

Both flags live on `paper_trading_accounts`; the engine picks them up via Realtime.

### Manual actions — Close All, per-leg close, order cancel

The dashboard requests exchange-side actions by writing a row/flag; the engine (never
the browser) executes them on Delta and cleans up:

| Action | UI writes | Engine does |
| --- | --- | --- |
| **Per-leg close (✕)** | inserts `delta_close_requests` (`account_id`, `product_symbol`) | reduce-only market-close of exactly that leg (incl. orphans the engine no longer tracks), books, deletes the row |
| **Order cancel (✕)** | inserts `delta_cancel_requests` (`order_id`, `product_id`) | cancels that order on Delta, deletes the row |
| **Close All** | sets `paper_trading_accounts.close_all_requested = true` | one-shot native `close_all` flatten (falls back to per-position closes), books + deletes all |
| **Manual exit** | sets `active_positions.exit_requested = true` | cancel resting + market-close the legs, books Manual Exit, deletes the row |

> [!IMPORTANT]
> **Close All is DB-polled, not Realtime-only.** It used to fire only when a Realtime
> `close_all_requested` event reached the engine's in-memory `accountState`. The 30s
> fallback account-sync omits that column (and replaces `accountState` with a partial
> row), so a **missed Realtime event silently dropped the Close All** — the flag stayed
> `true` in the DB and nothing happened. `processCloseAll` now **reads the flag straight
> from the DB every tick** (like the per-leg close), so it's reliable regardless of
> Realtime delivery. Per-leg close / cancel / manual-exit were already DB-polled.

> [!NOTE]
> **Consolidated request poll (multi-account egress).** These four request types are no
> longer polled per-account (which was 4 queries × N accounts every 1.5s). A single
> **manager-level** poll (`pollAllRequests`) runs 4 **batched** queries across all
> running accounts every 1.5s and dispatches only to the accounts with pending work — so
> idle request-poll load stays flat as the account count grows (4 queries/tick instead
> of 4×N). Manual-action responsiveness is unchanged (~1.5s). After executing, each
> handler republishes the live snapshot immediately (see [the data pipeline](#live-exchange-data-pipeline-dashboard-tabs)).

> [!NOTE]
> **Admins can now run these on managed accounts (migration `016`).** The `delta_close_requests`,
> `delta_cancel_requests`, `active_positions`, and `paper_trading_accounts` RLS policies
> only allowed the account **owner** (`user_id = auth.uid()`) — so an admin acting on a
> client's account had its insert/update silently rejected (`new row violates row-level
> security policy`, or a 0-row no-op for the flag updates). Migration `016` adds an
> **admin bypass** to those client policies (matching the admin model the credential RPCs
> already use), so admins can close/cancel/exit/Close-All and edit config/schedules on
> any account they manage.

### Live entry price offsets

Live entry orders are placed as marketable limits with a premium-$ offset so they
fill: **buy at ask + `entry_buy_offset`** (default 5), **sell at bid −
`entry_sell_offset`** (default 2), editable per account in the live section of the
Create/Edit modal. The offsets affect only the order limit price sent to Delta — the
stored entry price (used for PnL/margin) remains the ask/bid. Paper ignores them.

### Live exchange data pipeline (dashboard tabs)

For armed live accounts the engine publishes a **read-only snapshot** of the real
Delta account state so the workspace tabs (**Positions, Open Orders, Stop Orders,
Fills, Risk & Margin**) can show exchange truth instead of engine-internal
bookkeeping.

- **Engine** — `live.snapshot()` reads `/v2/positions/margined`, `/v2/orders` (split
  into resting limit orders vs stop orders by `stop_order_type`), `/v2/fills`, and
  `/v2/wallet/balances` via `Promise.allSettled` (one failing endpoint doesn't blank
  the rest) every **20s** for armed accounts. **Read-only w.r.t. the exchange** —
  publishing places no orders, and it runs in dry-run too.
  - **Change-guarded upsert (egress optimization):** it only writes to
    `live_exchange_state` when a **structural signature** changed (position set + size,
    resting/stop orders, fills, wallet — deliberately ignoring tick-by-tick
    mark/unrealized-PnL noise), else at most once per **60s keepalive** to refresh
    `updated_at` (liveness; UI marks stale after 120s). Quiet markets therefore emit a
    Realtime broadcast + UI refetch roughly every 60s instead of every 20s, while a
    real fill/order/position change still publishes immediately.
  - **Immediate republish after a manual action:** the engine republishes the snapshot
    **right after** it processes a per-leg close, Close All, order cancel, or manual
    exit — so the closed row clears from the UI within ~1s instead of lingering until
    the next 20s tick. (Without this, the UI's optimistic removal was undone by a
    refetch of the still-stale snapshot, making the position visibly **reappear then
    vanish** — the "close glitch".)
- **Table** — `live_exchange_state` (migration `009_live_exchange_state.sql`): one row
  per account (`positions`, `orders`, `stop_orders`, `fills`, `balances` JSONB +
  `wallet` numeric + `updated_at`). RLS: authenticated read, `service_role` write;
  `ON DELETE CASCADE` with the account.
- **UI** — `PaperTrading.jsx` is **Realtime-driven** (instant refetch on each Realtime
  change + on tab focus), backed by a **30s safety-net poll** for a missed Realtime
  message. The old every-**5s** snapshot refetch (which re-pulled the heavy
  positions/orders/fills payload 12×/min per tab) was throttled to this 30s net — a
  large egress cut with no visible staleness, since Realtime still drives immediacy.
  `TradingWorkspace.jsx` renders Delta data in each tab
  **only when** the account is
  live **and** the engine is placing real orders (`engineDryRun === false`) **and**
  the snapshot is fresh. Otherwise the tabs fall back to their engine-derived views —
  in dry-run the exchange has no real orders/positions, so the paper/engine views are
  the truth. **Order History** always stays engine-sourced (`trade_history`), not raw
  exchange fills. After entry the disaster backstop should appear here under **Stop
  Orders** at `4× premium`, state open, not triggered — a quick way to confirm it.

### IP whitelisting & the Verify proxy

Delta API keys are IP-whitelisted. There are two distinct egress points:

- **Engine (orders, balance, positions, stops):** calls Delta directly from the
  server. Give that box a **static Elastic IP** and whitelist it. Done.
- **Browser "Verify Connection":** by default routes through the Vercel `/api`
  rewrite, so Delta sees **Vercel's dynamic egress IP** — an IP-locked key rejects
  it (`ip_not_whitelisted_for_api_key`) and the IP keeps changing. This cannot be
  fixed by whitelisting.

**Active approach — engine-mediated verify (no public endpoint).** The browser
does NOT call Delta for Verify. It calls `request_delta_verification` (encrypts the
secret with the Vault key), and the **engine** — running on the whitelisted server
with the service_role key — polls `delta_verify_requests`, runs the balance check
from that IP, and writes the result back (`get_delta_verification_status`, which the
UI polls). The secret is cleared once processed; rows are purged after 1 hour.
Requires the engine running with `SUPABASE_SERVICE_ROLE_KEY`, and migration 004.
This is what `verifyDeltaCredentials` uses today — no AWS exposure needed.

**Alternative — HTTPS proxy (Option B), if you prefer the browser to call through
the server directly:**

1. Run the engine with **`DELTA_PROXY_PORT`** set (e.g. `8787`). `engine/proxyServer.js`
   then forwards `/v2/*` to Delta verbatim from the server's IP. Set
   `DELTA_PROXY_ALLOW_ORIGIN=https://trade.vitticapital.ai`.
2. Put **TLS + a stable hostname** in front of it (nginx/Caddy on the Elastic IP),
   e.g. `https://delta-proxy.vitticapital.ai`. Caddy gives automatic HTTPS.
3. Set the frontend env **`VITE_DELTA_PROXY_URL=https://delta-proxy.vitticapital.ai`**
   (no path suffix) and redeploy. Verify now goes browser → your server → Delta,
   egressing from the whitelisted IP. Leaving the var unset keeps the old Vercel path.

The proxy only relays `/v2/*` to `api.india.delta.exchange` (not an open proxy) and
forwards the signed headers unchanged, so the browser's HMAC stays valid.

### Rollout checklist

1. Set `SUPABASE_SERVICE_ROLE_KEY` in the engine env; keep `DELTA_LIVE_DRYRUN=true`.
2. Restart the engine; confirm the log shows `Delta credentials loaded … Dry-run: ON`.
3. Let it run in dry-run; watch the `🧪 DRY-RUN live order` lines at real entry/exit
   events and validate sides, symbols, prices, and **sizes**. Note: dry-run uses the
   **active** exit model, so this validates entry sizing but **not** the resting-order
   exit flow (that needs a real exchange — step 4).
4. When satisfied, set `DELTA_LIVE_DRYRUN=false`, restart, and arm a single account
   (`live_enabled = true`) with **tiny** size. On the first entry, verify in the
   dashboard (or Delta directly):
   - **Sizing:** the `💰 LIVE size …` log shows the `unit margin`, `part`, and `scale`,
     with the scaled `long`/`short` holding the ratio and the margins matching Delta's real
     figures (not 1000× off); if balance is large, confirm the `🧢 … capped by ratio-spread
     max` line keeps the short notional ≤ `$195k`.
   - **Open Orders:** the resting short buy-back `@ shortExitPrice` (`-SEX`).
   - **Positions/Stop Orders:** the long-TP and short-SL **brackets** at the exit
     level. Confirm the **PUT bracket does not fire immediately** on entry, and that
     Delta accepts both the @1.1 resting buy and the short SL bracket at once.
   - After the short @1.1 fills → **Open Orders** shows the fixed **ladder** SELLs;
     **Fills** shows executions; Order History logs `Short Leg Exit @ …` /
     `Long Leg Exit @ level …`. Only scale up once this full cycle is confirmed.
