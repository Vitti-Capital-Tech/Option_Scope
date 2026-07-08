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
| Entry (before `active_positions` insert) | Buy long @ ask (limit) + sell short @ bid (limit). **A failed live send aborts the insert** — no phantom position. |
| Entry (disaster backstop) | Reduce-only **buy-stop** on the short leg, `stop_trigger_method: mark_price`, stop = `liveBackstopMult`× entry premium (default 4×). See [Live exit model](#live-exit-model--shared-with-paper-option-a--disaster-backstop). |
| Short-leg exit | Buy-to-close short (`reduce_only`) @ ask + cancel the backstop |
| Long laddered exit | Sell-to-close the cycle's long lot (`reduce_only`) @ bid |
| Partial ratio scale-down | Sell-to-close the reduced buy lot (`reduce_only`) @ bid |
| Full ATM/ITM/OTM exit | Sell long + buy short (`reduce_only`) + cancel the backstop |
| **Expiry / zombie exit** | **No leg order** — Delta cash-settles expired options exchange-side; the backstop is still cancelled |

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

### Live exit model — shared with paper (Option A) + disaster backstop

> **History:** an earlier iteration gave armed live accounts a *separate*
> exchange-resting, index-triggered SL/TP model (short-leg SL at the buy strike,
> long-leg TP at the same level, fill-detected by polling `/v2/positions`). **That
> model is retired.** It diverged from paper (it ignored `shortExitPrice` and the
> laddered long exit, only closing when spot reached the buy strike) and its
> spot-triggered stops were direction-ambiguous for puts — a stop placed below spot
> could fire prematurely. The `handleLiveExit` / `computeIndexTriggerLevel` helpers
> remain in the file but are **dormant** (uncalled).

Armed live accounts now run the **exact same exit logic as paper** — the
[premium-based short buy-back](paper_trading_explained.md#short-leg-only-exit)
(`shortExitPrice`, default $1.1), the
[laddered long scale-out](paper_trading_explained.md#long-only-laddered-exit),
[ATM ratio partial scaling](paper_trading_explained.md#partial-exit--scaling-logic),
and the ATM/ITM/OTM / expiry full exit. Every one of those branches already sends
its own `reduce_only` close to Delta via `live.closeLeg()` (see the Execution hooks
table above), so **paper and live now behave identically** — the engine ACTIVELY
manages exits each 1-second cycle instead of resting stops on the exchange. This is
what you test in paper is what runs live.

**Disaster backstop — the one resting stop that remains.** At entry, on the *short
leg only*, the engine arms a single `reduce_only` **buy-stop** that fires only if the
short option's **mark price** blows out to a disaster multiple of its entry premium
(`config.liveBackstopMult`, default **4×**). It protects the naked-short risk even if
the engine is down or slow. It is:

- **Mark-price (option) triggered, not spot** — a buy-stop on a *rising* option price
  is directionally unambiguous for both calls and puts, and (sitting above the current
  price) can never fire the instant it is placed.
- **Auto-cancelled** when the short leg closes normally (premium buy-back or full
  exit) so a stale stop can't later fire against a re-entered position on the same
  symbol. The order id + product id are persisted in `sell_leg`, so cancellation
  survives an engine restart (`safeParseLeg` preserves the fields).

**Trade-offs to know:**

- There is **no hard spot stop-loss** anymore. Normal protection is the engine's
  active 1-second monitoring; the disaster backstop is the *only* exchange-side safety
  net if the engine is down.
- Exits are booked assuming the `closeLeg` limit (sell @ bid / buy @ ask — the
  marketable/taker side) fills. A close that doesn't fill leaves the engine's books
  ahead of the exchange; the 5-minute `reconcile()` flags gross drift.
- If the **backstop itself fires**, the engine does not auto-detect it (this model has
  no fill-detection) — the position lingers in the engine books until its normal exit,
  and `reconcile()` flags the drift. A backstop firing means a catastrophic move →
  manual review.

**Bookkeeping** (`trade_history` / `active_positions`) is identical to paper — same
deterministic `trade_id`s and idempotent upserts. Fills are booked at the engine's
computed option quotes (not the exact exchange fill price); `reconcile()` flags drift.

### Live position sizing — balance allocation (Sub-stage A)

Live accounts size positions from the **live Delta USDT wallet balance**, not the
paper `$200k` notional cap:

- Each account has a **`balance_allocation_pct`** (default **90**, set at creation,
  editable) — the share of wallet balance used for trading; the rest is buffer.
- **max positions** = peak concurrent positions across the base config and all active
  schedule windows (`max(numberOfCalls + numberOfPuts)`).
- **part** = `(balance × allocation%) ÷ max positions`. At entry the spread is scaled
  so its estimated margin is **≤ 1 part**. This replaces the `$200k` cap for live only.

Paper accounts keep the `$200k` / 200× branch **unchanged** — the entire sizing branch
is gated on `mode==='live' && live_enabled`. Dry-run logs the full breakdown
(`💰 LIVE sizing…` and `💰 LIVE size…`) so the numbers can be validated before arming.
The fractional-lot → integer-contract rounding still applies at order time.

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
3. Let it run; watch the `🧪 DRY-RUN live order` lines at real entry/exit events and
   validate sides, symbols, prices, and **sizes**. Confirm exits log **paper-style**
   reasons (`Short Leg Exit @ Ask`, `Long Leg Exit @ level`, `Full Exit`) — *not* the
   retired `Live Short SL/Long TP` — and that a `🛡️ Disaster backstop armed` line
   fires at each entry.
4. When satisfied, set `DELTA_LIVE_DRYRUN=false`, restart, and arm a single account
   (`live_enabled = true`) with small size to confirm real fills before scaling. After
   the first entry, check the **Stop Orders** tab (or Delta directly): the disaster
   backstop should be resting at `4× premium`, state open, **not** triggered.
