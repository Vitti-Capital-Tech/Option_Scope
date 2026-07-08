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
  `cancelOrder`, `getLivePositions`, `getBalance`, `getLiveOrders`, `getFills`.
- `engine/lib/liveExecution.js` — the gated executor: `openSpread`, `closeLeg`,
  `placeStop`, `cancelStop`, `positions`, `orders`, `fills`, `snapshot`,
  `walletBalance`, `reconcile`. Reads the `DELTA_LIVE_DRYRUN` flag and the
  per-account arm state.
- `engine/lib/supabase.js` — now prefers `SUPABASE_SERVICE_ROLE_KEY` so the engine
  can decrypt credentials.

**Execution hooks** in `engine/paperTradingEngine.js` — all gated on
`mode === 'live' && live_enabled`, added alongside the existing DB writes so paper
logic is byte-for-byte unchanged when paper/disarmed:

| Point | Live order |
| --- | --- |
| Entry (before `active_positions` insert) | Buy long @ ask + sell short @ bid (limit, `+entryBuyOffset`/`−entrySellOffset`). Each leg carries a **spot-triggered bracket** at the exit level (long → TP, short → SL). **A failed live send aborts the insert.** |
| Entry (resting short-exit, armed real) | Resting reduce-only **limit BUY** on the short @ `shortExitPrice` (`${id}-SEX`) — the short buy-back (profit), sitting in Open Orders |
| Short-leg exit | Active model: buy-to-close @ ask. Resting model: the `-SEX` limit fills on its own → book + place ladder (short SL bracket auto-cancels) |
| Long laddered exit | Active model: sell reduce_only @ bid per level. Resting model: fixed-ladder resting **limit SELLs** fill on their own |
| Partial ratio scale-down | Sell-to-close the reduced buy lot (`reduce_only`) @ bid (active model only) |
| Risk exit (spot hits exit level) | **Brackets** close the whole spread exchange-side; engine's spot-cross catch-all (if up) also market-closes + books (reduce-only guards double-close) |
| **Expiry / zombie exit** | **No leg order** — Delta cash-settles expired options; brackets auto-cancel, resting orders cancelled |

All orders use limit orders at the engine's computed price and carry a
`client_order_id` derived from the position id + leg + stage (idempotency).

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
- **When the resting @1.1 fills** (detected by its `order_id` in recent `/v2/fills` —
  restart-safe, id persisted in `sell_leg`): book the short exit (`${id}-SE` @ the
  limit price), convert to long-only, and place the **fixed long ladder** as resting
  **limit SELL** orders. (The short's SL bracket auto-cancels once the short is flat.)
- **Fixed ladder** = 5 levels — `[10,20,30,40,50]` if the long bid < 25, else
  `[25,50,75,100,125]` — with **integer-contract** slices split `[1,1,1,1,S-4]`
  (remainder on the highest level; `S` = long contracts). Small longs degrade
  gracefully: `S ≤ 5` → one contract per level, fewer levels; `S = 1` → a single
  order (no ladder). Each slice books `${id}-LE-${stage}` @ its level as it fills.
- **Risk exit:** the brackets close the whole spread at the exit level exchange-side.
  The engine ALSO runs a redundant spot-cross / expiry catch-all (cancel resting +
  market-close + book `${id}`) for when it is up — reduce-only prevents double-close.
- **Fill-fetch guard:** the recent-fills fetch failing (null) makes the engine **hold**
  all positions that cycle — it never infers a fill from a missing/empty result.

**Bookkeeping** uses the same deterministic `trade_id`s and idempotent upserts as
paper. Slice PnL maps integer contracts back to fractional lots
(`lot = baseLot × contracts / S`); fills are booked at the resting limit price (fills
at that price or better), and `reconcile()` flags gross drift.

#### Exit-level brackets (the exchange-side risk exit)

At entry, `openSpread` attaches a **spot-triggered bracket** to each leg's order at the
shared exit-type level (`computeIndexTriggerLevel` — ATM = buy strike, ITM/OTM = ±
points), so the spread is protected even if the engine is down:

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

Live accounts size positions from the **live Delta USDT wallet balance**, not the
paper `$200k` notional cap:

- Each account has a **`balance_allocation_pct`** (default **90**) — the share of
  wallet balance used for trading; the rest is buffer.
- **max positions** = peak concurrent positions across the base config and all active
  schedule windows (`max(numberOfCalls + numberOfPuts)`).
- **part** = `(balance × allocation%) ÷ max positions`.

**Integer-ratio sizing (replaces fractional scaling).** The old model scaled the lot
by `part ÷ margin`, producing *fractional* lots that then rounded to `1:1` integer
contracts on the exchange — destroying the ratio. Now:

1. Reduce the (0.25-stepped) ratio to **minimal integer contracts** via GCD, e.g.
   `2.5 → 2L:5S`, `2.75 → 4L:11S`, `4.25 → 4L:17S`.
2. **unitMargin** = `calcMargin(buyPrem, unitLong×cs, spot, unitShort, cs)` =
   `buyPrem×unitLong×cs + unitShort×spot×cs/200` (cs = `contract_size`, leverage 200).
3. Take the largest whole multiple `k` where `k × unitMargin ≤ part`; open
   `k·unitLong` long / `k·unitShort` short contracts. **If `k < 1` (even the minimal
   unit exceeds the part) the entry is skipped** (`⏭ LIVE skip …`).

The ratio is thus **locked in whole contracts at entry** — no fractional scaling, no
partial-exit drift, and the ladder splits cleanly on the integer long count.

Paper accounts keep the `$200k` / 200× branch **unchanged** (the sizing branch is
gated on `mode==='live' && live_enabled`). Dry-run logs the full breakdown
(`💰 LIVE int-ratio …` with `unitMargin`, `part`, `k`, and `cs`) so the numbers —
especially that `cs` and the margins match Delta's actual figures — **must be
validated before arming**.

### Account controls — Start / Pause (live only)

Live accounts show controls in the account strip (paper accounts are unaffected):

- **Start Live** → sets `live_enabled=true` (arms the account). Real sends are still
  gated by the engine's `DELTA_LIVE_DRYRUN`. **Disarm** clears it.
- **Pause** → sets `paused=true`. The engine then opens **no new positions** but
  keeps managing open ones (active exits continue; the short-leg disaster backstop
  stays in place). **Resume** clears it. A `PAUSED` badge shows on the account.

Both flags live on `paper_trading_accounts`; the engine picks them up via Realtime.

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

- **Engine** — `live.snapshot()` upserts into `live_exchange_state` every **20s** for
  armed accounts. It reads `/v2/positions/margined`, `/v2/orders` (split into resting
  limit orders vs stop orders by `stop_order_type`), `/v2/fills`, and
  `/v2/wallet/balances` via `Promise.allSettled` (one failing endpoint doesn't blank
  the rest). **Read-only w.r.t. the exchange** — publishing places no orders, and it
  runs in dry-run too.
- **Table** — `live_exchange_state` (migration `009_live_exchange_state.sql`): one row
  per account (`positions`, `orders`, `stop_orders`, `fills`, `balances` JSONB +
  `wallet` numeric + `updated_at`). RLS: authenticated read, `service_role` write;
  `ON DELETE CASCADE` with the account.
- **UI** — `PaperTrading.jsx` fetches + Realtime-subscribes to the row;
  `TradingWorkspace.jsx` renders Delta data in each tab **only when** the account is
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
   - **Sizing:** the `💰 LIVE int-ratio …` log shows whole-contract lots that hold the
     ratio, and `unitMargin`/`cs` match Delta's real figures (not 1000× off).
   - **Open Orders:** the resting short buy-back `@ shortExitPrice` (`-SEX`).
   - **Positions/Stop Orders:** the long-TP and short-SL **brackets** at the exit
     level. Confirm the **PUT bracket does not fire immediately** on entry, and that
     Delta accepts both the @1.1 resting buy and the short SL bracket at once.
   - After the short @1.1 fills → **Open Orders** shows the fixed **ladder** SELLs;
     **Fills** shows executions; Order History logs `Short Leg Exit @ …` /
     `Long Leg Exit @ level …`. Only scale up once this full cycle is confirmed.
