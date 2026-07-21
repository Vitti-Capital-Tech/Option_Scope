# Low Level Design — OptionScope

This document is the authoritative implementation reference for every module, engine, data pipeline, and safety guard in OptionScope.

---

## 1) Project Structure & Codebase Map

| File | Responsibility |
|---|---|
| `main.jsx` | Root bootstrap and routing shell. Mounts the app modules simultaneously using `display: none/block` to preserve state across navigation. Owns the shared `page` and `theme` state and the `BroadcastChannel` sync instance. |
| `RatioSpreadScanner.jsx` | Standalone option-chain scanner. Computes premium-to-delta-notional ratio deviation pairs, publishes top-3 results via `BroadcastChannel` and `localStorage`. Configuration is managed locally in `localStorage` independent of Paper Trading accounts. |
| `PaperTrading.jsx` | React UI Dashboard for Paper Trading. Reads `active_positions`, `trade_history`, and heartbeat from Supabase. Connects to multi-account creation/management modals and controls configuration updates via a local draft buffer (Apply/Reset buttons). |
| `ConfirmExitModal.jsx` | Front-end confirmation modal for manual position liquidation. Displays live exit pricing, estimated exit fees, and net realized P&L. |
| `engine/paperTradingEngine.js` | Headless Node.js engine. Handles entries, dynamic exits (ATM, ITM, OTM with points-based thresholds), rotation, IV tracking, fee calculations, and Supabase persistence. |
| `ResultTable.jsx` | Reusable grouped table renderer for ratio spread candidates. |
| `api.js` | Network abstraction: Delta REST calls, `createTickerStream` (WS with auto-reconnect), `createWS` (raw WS), `getTickers` (REST backfill). |
| `scannerUtils.js` | Shared helpers: `normalizeIv`, `toFiniteNumber`, `matchesOptionType`, `formatTime`, `formatDateTime`. |
| `supabase.js` | Supabase client singleton. |
| `useTabSync.js` | `BroadcastChannel` sync hook (`useTabSync` for root, `useTabListener` for children). |
| `engine/lib/deltaApi.js` | Backend API adapter for Delta Exchange. Implements WebSockets with auto-reconnect, ticker stream parsing, REST endpoints, and unconfirmed (timestamp = 0) REST ticker backfills. |
| `engine/lib/utils.js` | Shared backend algorithmic logic including candidate spread scanning (`scanTickers` with quote freshness validation), rotation target selection, and margin calculations. |
| `engine/lib/heartbeat.js` | Helper module executing the continuous status update ticks for the backend engines to Supabase. |
| `engine/lib/supabase.js` | Supabase client initialization wrapper for backend VPS engines. Prefers `SUPABASE_SERVICE_ROLE_KEY` (needed to decrypt credentials and satisfy admin/live RLS). |
| `engine/lib/deltaTradeApi.js` | Signed Delta Exchange REST client for live trading: `placeOrder`, `placeBracketOrder` (`POST /v2/orders/bracket`), `editOrder`, `editBracket`, `cancelOrder`, `getLivePositions`, `getLiveOrders`, `getFills`, `getOrderHistory`, `getBalance`. HMAC-SHA256 signing. |
| `engine/lib/liveExecution.js` | Dry-run-gated live executor wrapping `deltaTradeApi`: `openSpread`, `closeLeg`, `editOrder`, `changePositionBracket`, `placeStop`, `cancelStop`, `positions`, `orders`, `fills`, `recentFillOrderIds`, `snapshot`, `walletBalance`, `reconcile`. Centralises price sanitisation (`cleanLimitPrice`) and integer contract mapping (`longContracts`/`shortContracts`). |
| `engine/lib/telegram.js` | Fire-and-forget `notifyLiveFailure` Telegram alerts for armed-real failures (deduped). |
| `engine/proxyServer.js` | Optional engine-hosted proxy forwarding `/v2/*` from a whitelisted IP (credential-verification Option B). |
| `src/deltaAuth.js` | Browser-side `verifyDeltaCredentials` — Web Crypto HMAC-SHA256 test-signs `GET /v2/wallet/balances` (front-end verification path). |
| `src/components/PaperTrading/ControlPanel.jsx` | Global-filter Control Panel (Apply/Reset over global filters + Trading Days toggle). |
| `src/components/PaperTrading/SchedulePanel.jsx` | Per-window schedule editor (timeline, per-window overrides, upsert-prune auto-save). |
| `src/components/PaperTrading/TradingWorkspace.jsx` | Exchange-style tabbed panel: Positions / Open Orders / Stop Orders / Fills / Order History / Risk & Margin. |
| `src/components/PaperTrading/TradeHistoryTable.jsx` | Trade history table + Window Capacity row. |
| `ecosystem.config.cjs` | PM2 config pinning the engine to a single process (`exec_mode: 'fork'`, `instances: 1`, long `kill_timeout`). |

---

## 2) Real-Time Data & Connectivity Layer (`src/api.js`)

### WebSocket Telemetry & Auto-Reconnect Engine (`createTickerStream`)

Used by `RatioSpreadScanner` and `PaperTrading`. Subscribes to the Delta Exchange `v2/ticker` channel and self-heals on unexpected drops.

**Reconnect Lifecycle:**

- **`alive` flag**: Set to `true` on creation, `false` only on a deliberate `.close()` call. Prevents reconnects after intentional shutdown.
- **`reconnectTimer`**: On `onclose` (if `alive` is still `true`), a 3-second `setTimeout` schedules a fresh `new WebSocket()`. Any previous timer is always cleared before setting a new one to prevent ghost reconnect loops.
- **Error Handling**: If the `WebSocket` constructor throws (e.g., bad URL), the catch block also schedules a reconnect if `alive` is true.
- **Clean Shutdown**: `.close()` sets `alive = false`, clears the timer, nullifies `ws.onclose` to suppress the reconnect trigger, then calls `ws.close()`.

**Message Parsing:**

Incoming frames are filtered to only process `type === 'v2/ticker'`. All other message types (e.g., `subscriptions` ack) are silently ignored to prevent noise.

### Key Network Subsystems

1. **Auto-Reconnect**: Self-heals on network drops with a 3-second backoff. Critical for VPS unattended operation.
2. **REST Backfill (`refreshAllTickers` / `backfillTickers`)**: Triggered on algo start or manual page refresh. Calls `/v2/tickers` and merges results into the local ticker cache without zeroing existing data — prevents the "PnL = 0" glitch before the first WebSocket frame arrives. **Backfill timestamp behavior**: If a valid bid or ask price is present in the REST response, `bidUpdatedAt`/`askUpdatedAt` is now set to `Date.now()`, allowing the first entry scan after startup to use backfill data immediately. Tickers with no bid/ask price still receive `timestamp = 0` and are rejected by the freshness guard as unconfirmed. Live WS quotes overwrite these timestamps as they arrive.
3. **Redundant Connection Guard (`lastWsSymbolsRef`)**: Hashes the current symbol list. Skips WebSocket teardown/recreate if the symbol set has not changed, avoiding the "WebSocket closed before established" race condition during periodic 5-minute product refreshes.
4. **50ms Buffered Flush**: All incoming ticker frames are written to `tickerBufferRef` (a plain object). A `setTimeout(flushTickerBuffer, 50)` timer batches and flushes them into `latestTickerDataRef` and triggers a single React state update. This limits render pressure under volatile data bursts.

### Spot Price Streaming & Redundancy

To ensure zero-latency spot prices:
1. **WebSocket Ticker Subscription**: The frontend UI (`PaperTrading.jsx`) and backend engine (`paperTradingEngine.js`) subscribe to the underlying perpetual future contract (e.g., `BTCUSD` or `ETHUSD`) directly over the WebSocket ticker stream. Spot price ticks are processed immediately upon receipt, updating the UI and engine states with zero latency.
2. **REST Polling & Tab Visibility Pause**: Spot price REST polling continues every **10 seconds** via `setInterval` as a safety net. To minimize egress, tab visibility listeners pause this interval when the tab goes to the background, performing a single update check when the tab is focused again.

---

## 3) Directional Implied Volatility (IV) & ATM Ratio/Price Tracking

All IV metrics across the platform use a **directional execution model** — buy legs use Ask IV, sell legs use Bid IV — to reflect the true cost of crossing the spread.

### Field Mapping from Delta Exchange `v2/ticker`

| Metric | Field Path | Use |
|---|---|---|
| Bid IV | `msg.quotes.bid_iv` | Short (sell) leg IV |
| Ask IV | `msg.quotes.ask_iv` | Long (buy) leg IV |
| Mark Vol | `msg.mark_vol` or `msg.quotes.mark_iv` | Fallback generic IV |
| Legacy IV | `msg.greeks.iv` | Last-resort fallback |

### `normalizeIv` Logic (`scannerUtils.js`)

Converts Delta's raw decimal fractions to display percentages and screens invalid values:

1. Returns `null` if value is `null`, `NaN`, or `<= 0`.
2. If value is `< 5.0` (i.e., a decimal like `0.72`), multiplies by 100 to yield `72.0%`.
3. Otherwise returns the value as-is (already a percentage like `72.0`).

### IV Tracking in PaperTrading

- **Entry IVs** (`entryBuyIv`, `entrySellIv`): Captured at the moment of entry from live ticker. Stored on the position object and persisted to Supabase via `buy_leg` / `sell_leg` JSON blobs.
- **Current IVs** (`currentBuyIv`, `currentSellIv`): Updated every second in Phase 1 of the evaluation loop. Buy leg uses `ticker.bidIv` (liquidation side), sell leg uses `ticker.askIv` (buy-back side).
- **Exit IVs** (`exitBuyIv`, `exitSellIv`): Captured at the moment of trade close and written to `trade_history`.
- **UI Columns**: Active Positions and Trade History tables display `IV In (B/S)`, `IV Cur (B/S)`, and `IV Out (B/S)` as separate columns.

### ATM Ratio & Price Tracking in PaperTrading

- **Entry ATM Metrics**: Sourced using the ATM option chain quotes (`buyIntrinsic` and `sellIntrinsic` at ATM strike) during candidate selection. Stored as `entryAtmRatio`, `entryBuyAtmPrice`, and `entrySellAtmPrice` inside the `buyLeg` JSON metadata within `active_positions`.
- **Exit ATM Metrics**: Captured similarly using live quotes at the moment of exit (both full and partial exits). Saved as `exitAtmRatio`, `exitBuyAtmPrice`, and `exitSellAtmPrice` inside the `buyLeg` JSON metadata within `trade_history`.
- **UI Table Rendering**: `PaperTrading.jsx` reads these values from the parsed `buyLeg` JSON object of each historical trade. Renders **Entry ATM Ratio (Prices)** and **Exit ATM Ratio (Prices)** columns displaying the ratio and underlying intrinsic prices in stacked formats (e.g. `0.75` and `(150.00 / 200.00)`). Shows `—` for legacy database rows.
- **CSV Export Support**: Included as `Ratio`, `Original Ratio`, `Entry ATM Ratio`, `Entry ATM Buy Price`, `Entry ATM Sell Price`, `Exit ATM Ratio`, `Exit ATM Buy Price`, and `Exit ATM Sell Price` columns in the exported CSV.

---

## 4) Cross-Tab Synchronization (`src/useTabSync.js`)

The workspace uses a single `BroadcastChannel` named `option-scope-sync` to synchronize state across multiple open browser tabs.

### Channel Architecture

- **`useTabSync`** (used in `main.jsx`): Creates and owns the persistent channel. Broadcasts `THEME_CHANGE` automatically on theme changes. Accepts a `handlers` map for custom message types.
- **`useTabListener`** (used in child components): Opens a short-lived channel per call for listening and one-shot broadcasting. Each instance has a unique `tabId` (random base-36 string) to prevent self-echo.

### Message Types

| Type | Direction | Payload | Effect |
|---|---|---|---|
| `THEME_CHANGE` | Any tab → All | `{ theme }` | Applies light/dark theme to all tabs |
| `SCANNER_TOP_SPREADS_SYNC` | Scanner → PaperTrading | `{ underlying, expiry, callTop3, putTop3, timestamp }` | Delivers live scanner results to the Paper Trading engine |
| `CONFIG_SYNC` | PaperTrading → Scanner | `{ underlying, expiry, config }` | Propagates filter/expiry changes (such as underlying, expiry, `atmRatioScaling`, `atmRatioPctCall`, `atmRatioPctPut`) from Paper Trading to Scanner |
| `ACCOUNTS_SYNC` | Any tab → All | `{ accounts }` | Syncs the updated accounts list instantly to keep all dropdown selectors updated |

### `localStorage` Persistence

The Scanner also writes the top-3 results to `localStorage` under the key `vitti_scanner_top_spreads_v1`. This allows Paper Trading to bootstrap its candidate pool even if it was opened after the scanner already ran.

---

## 5) Ratio Spread Scanner (`RatioSpreadScanner.jsx`)

### Configuration (persisted to `localStorage` key `vitti_algo_config`)

| Parameter | Default | Description |
|---|---|---|
| `minStrikeDiff` | 800 | Minimum distance (pts) between buy and sell strikes |
| `minIvDiff` | 5 | Minimum IV spread (%) between buy and sell legs |
| `maxRatioDeviation` | 0.25 | Max allowed deviation between premium ratio and delta-notional ratio |
| `minSellPremium` | 10 | Minimum sell leg premium required to avoid illiquid pairs |
| `maxNetPremium` | 20 | Maximum net premium (debit cap): spreads with `netPremium > maxNetPremium` are filtered out |
| `minLongDist` | 500 | Minimum spot distance (pts) the buy strike must be from current spot |
| `maxSellQty` | 10 | Maximum allowed sell quantity (ratio cap) |
| `atmRatioScaling` | `true` | Whether to scale quantity based on ATM ratio |
| `atmRatioPctCall` | `50` | Scale percentage for Call option scaling |
| `atmRatioPctPut` | `25` | Scale percentage for Put option scaling |
| `minAtmPnl` | `0` | **ATM Edge Floor** — hide rows whose projected at-ATM P&L (USD) `< minAtmPnl` (only while `atmRatioScaling` is on; applied at display time in `ResultTable`) |
| `minAtmRoi` | `0` | **ATM Edge Floor** — hide rows whose projected at-ATM ROI (%) `< minAtmRoi` (only while `atmRatioScaling` is on; applied at display time in `ResultTable`) |

### Market Ingestion Flow

1. Load products from REST for the selected underlying.
2. Extract all strikes for the selected expiry and build a `symbolMeta` map: `symbol → { strike, lotSize, type }`.
3. Subscribe all symbols to `createTickerStream`. Each incoming frame updates `tickerBufferRef`.
4. A 50ms debounce timer batches the buffer into `latestTickerDataRef` and triggers a `setTickerData` re-render.

### Pair Evaluation (`computeSpreads` / `scanTickers`)

The scanner runs an O(N²) pair search within each option type (calls and puts separately):

1. **Directional Filtering**: Universe is split at ATM — Calls at strike `>= atmStrike`, Puts at strike `<= atmStrike`.
2. **Leg Assignment**: For calls, the lower strike is the buy (long) leg; for puts, the higher strike is the buy leg.
3. **Strict Execution-Realistic Pricing & Freshness Check**: `buyPrice = buyLeg.ask`, `sellPrice = sellLeg.bid`. The pair is skipped immediately if either active quote is missing. No fallback to `markPrice` or `lastPrice` is allowed for entries. Quotes must be WS-confirmed and fresh: both legs are checked to ensure their `bidUpdatedAt` and `askUpdatedAt` timestamps are less than 120,000 milliseconds old (`Date.now() - updatedAt < 120000`), preventing stale entries on illiquid strikes. After engine startup, REST-backfilled tickers with a valid price get `timestamp = Date.now()` (not 0), so the first scan can use backfill data. Tickers with no price still get `timestamp = 0` and are rejected. **Rejection Tracking**: `scanTickers` returns `{ pairs, rejected }` where `rejected` maps each filter name to a count of rejected pairs, enabling diagnostic logging when 0 candidates are found.
4. **Directional IV**: `buyIv = buyLeg.askIv ?? iv`, `sellIv = sellLeg.bidIv ?? iv`. Pair is skipped if either IV is null.
5. **Filter Gauntlet** (all must pass):
   - `strikeDiff >= minStrikeDiff`
   - `ivDiff > minIvDiff`
   - `spotDist >= minLongDist` (buy strike to spot)
   - `sellPrice >= minSellPremium`
   - `ratioDeviation <= maxRatioDeviation`
   - `sellQty <= maxSellQty` — checked on the **base** (delta-neutral) `sellQty`, before ATM scaling.
   - `netPremium >= -maxNetPremium` (**Max Debit** cap) — checked **last, on the scaled short quantity** (see step 6): `scaledSellQty × sellPrice - buyPrice >= -maxNetPremium`. Because scaling up the short raises the net credit, this ordering lets a candidate that would fail on its natural ratio survive once scaled.
6. **`sellQty` Calculation & ATM scaling (inside `scanTickers`)**: base `rawQty = buyDN / sellDN`, rounded to nearest 0.25 with minimum of 1 (checked against `maxSellQty`). If `atmRatioScaling` is on, the scaling is computed **inside the scanner** (not in `ResultTable`): `atmRatio = atmBuyPrice / atmSellPrice`, `ratioDiff = max(0, atmRatio − sellQty)`, `scaledSellQty = round((sellQty + (pct/100)·ratioDiff)/0.25)·0.25` (`pct` = `atmRatioPctCall`/`atmRatioPctPut`). The base `sellQty` is preserved alongside `scaledSellQty`; the Max Debit filter then runs on the scaled value. `ResultTable` consumes `scaledSellQty` directly and no longer recomputes the scaling.
7. **Sorting**: Closest buy strike to ATM first; ties broken by descending `netPremium` (highest credit/lowest debit first).

### `pickTopUniqueStrikes`

Greedy selection algorithm ensuring each buy strike appears at most once in the output. Scans the sorted pair list and adds spreads whose buy strike has not been seen yet, up to the requested `limit` (default 3).

### Refresh Cadence

- **Initial**: Scan runs immediately when ticker data arrives (fast-track: 2 seconds after first data).
- **Normal**: Aligned to clock-minute boundary via `currentMinute > lastMinute` check.
- **Manual**: Refresh button triggers `computeSpreads(true)` immediately.
- **Product Refresh**: Dedicated background `useEffect` interval runs every 5 minutes in all active modules (`RatioSpreadScanner`, `PaperTrading`) independently of trading or scanning status. If the currently selected expiry is no longer present in the active list (e.g., daily rollover occurs), the engine automatically switches to the nearest active expiry, updates the configuration, and syncs/saves the new state to the database.

### Publishing Results

After every scan, `publishTopSpreads` packages the top-3 calls and puts into a payload containing symbol pairs, buy strikes, and sell quantities. This payload is:
1. Written to `localStorage` (`SCANNER_TOP_KEY`).
2. Broadcast to all tabs via `BroadcastChannel` (`SCANNER_TOP_SPREADS_SYNC`).

---

## 6) Supabase Schema & Persistence

### Table Reference

| Table | Engine | Key Fields | Notes |
|---|---|---|---|
| `paper_trading_accounts` | Supervisor | `id`, `name`, `user_id`, `mode` (`paper`/`live`), `live_enabled`, `paused`, `close_all_requested`, `balance_allocation_pct` (90), `entry_buy_offset` (10), `entry_sell_offset` (3), `default_config` (JSONB) | One row per account. `mode`/`live_enabled`/`paused` gate live execution; switching back to paper forces `live_enabled=false`. `default_config` is the Reset target. |
| `paper_trading_config` | PaperTrading | `underlying`, `expiry`, filter thresholds, `exit_type`, `exit_points`, `strategy_version` (1), `trade_days` (JSONB, all-7), `short_exit_price` (1.1), `long_exit_slices` (10), `spot_diff`, `initial_balance` (3000), `max_combined_positions` (4), `combined_split_pct` (70) — last three **paper only**, migration `027` | One row per account (id = account id), upserted on config change. `strategy_version` gates paper(2)/live(1) logic. Paper sizing = (`initial_balance` + realized P&L) × `balance_allocation_pct` ÷ active window's `max_combined_positions`. |
| `paper_trading_schedules` | PaperTrading | per-window overrides (see §12) incl. `max_net_premium`, `exit_type`, `exit_points`, `min_days_to_expiry`, `trade_days`, hedge columns, and (paper, migration `027`) `max_combined_positions` + `combined_split_pct` | Permanent, undeletable **Window 1** per account, seeded from base config. |
| `active_positions` | PaperTrading | `id`, `buy_strike`, `sell_strike`, `buy_leg` (JSON), `sell_leg` (JSON), `hedge_leg` (JSON), `accumulated_sell_pnl`, `margin`, `exit_requested` | Account-scoped unique indexes `idx_active_positions_buy_strike_unique` / `..._sell_strike_unique` on `(account_id, underlying, type, expiry, buy_strike/sell_strike)` prevent duplicate inserts (**`expiry` added** so the same strike on different expiries no longer collides). |
| `trade_history` | PaperTrading | `id`, `trade_id`, `realized_net_pnl`, `exit_reason`, `is_partial`, `exit_time`, `lot_size`, `total_fees`, `hedge_leg` (JSON) | `trade_id` has a **UNIQUE constraint**; all writes use `.upsert(rows, { onConflict: 'trade_id', ignoreDuplicates: true })` (= `INSERT … ON CONFLICT DO NOTHING`) so exits are **idempotent** (replaces the old non-atomic select-then-insert, which leaked duplicates because ids embedded `Date.now()`). `id` is a primary-key UUID; `lot_size` tracks trade volume. |
| `delta_credentials` | Live | `account_id`, `api_key`, `api_secret_enc`, `key_last4`, `status`, `verified_at` | Encrypted secret (pgcrypto + Vault). See §6 Live Credential Security. |
| `delta_close_requests` / `delta_cancel_requests` | Live | `account_id`, `product_symbol` / `order_id`, `product_id` | Manual per-leg close / order cancel queues (engine-executed). |
| `delta_verify_requests` | Live | `account_id`, encrypted secret | Engine-mediated credential verification (migration `004`). |
| `live_exchange_state` | Live | `account_id`, `positions`, `orders`, `stop_orders`, `fills`, `balances` (JSONB), `wallet`, `updated_at` | One row/account, change-guarded 20s snapshot for the dashboard (migration `009`). |
| `engine_heartbeat` | Supervisor | `account_id`, `updated_at`, status metadata | Liveness/countdown source for the UI. |
| `profiles` | Auth | `id`, `role` (`client`/`admin`) | RBAC; admin bypass via migration `016`. |

**Deterministic `trade_id` formats** (never `Date.now()`): full exit `${pos.id}`; short-leg `${pos.id}-SE`; partial/scaling `${pos.id}-PE-${lotsRemaining}`; long ladder slice `${pos.id}-LE-${stage}`; hedge `${pos.id}-HX`. Position id format `T<timestamp36><random>` is effectively unique, so a `23505` is always a strike collision, never an id collision.

**Migration index (selected):** `004` verify requests · `009` live_exchange_state · `012` per-window max-debit/exit-type · `016` admin RLS bypass · `018`–`020` strategy_version · `019`/`023` per-window min DTE · `021` trade_days · `022`/`023` hedge leg.


### Concurrency Safety Guards

**Supabase Realtime Subscription**: On mount (when `trading = true`), the engine subscribes to `postgres_changes` events on `active_positions` (`event: '*'`). Any INSERT, UPDATE, or DELETE triggers an immediate `fetchSupabaseActivePositions()` call, delivering the update to all connected sessions in <1 second.

**Trade History Realtime Optimization**: The `trade_history` INSERT subscription now uses `payload.new` directly instead of triggering a full `fetchSupabaseTradeHistory()` refetch on every trade close. The new trade row is mapped and prepended to local state immediately. This eliminates the largest source of Supabase egress (previously a full-table fetch with JSONB buy_leg/sell_leg on every exit). A full history fetch still occurs on initial load and tab focus restoration.

**DB-Level Count Guard (pre-insert)**: Before inserting any new position, the engine queries `active_positions` for the current `(underlying, type)` pair, counting **full spreads only** (`.gt('sell_qty', 0)`, so held long-only rows from a short-leg exit don't consume a slot — total active rows can exceed the cap). If the live count is `>= config.numberOfCalls` (calls) or `config.numberOfPuts` (puts), the insert is aborted. These pre-order reads are **fail-closed** for live: any query error skips the entry (so a transient read failure can't let a duplicate reach real placement). Uses plain `.select('id')` (not `{ head: true }`) to ensure non-null response data.

**DB-Level Strike Uniqueness (pre-insert)**: After the count check, the engine queries active positions for duplicate `buy_strike` (`buyConflict`) and `sell_strike` (`sellConflict`) values for the same `(underlying, type)` and `account_id`. If any conflict is found, the insert is aborted with a console warning.

**DB Unique Constraint Fallback**: PostgreSQL unique constraints `unique_buy_strike_per_type` and `unique_sell_strike_per_type` (scoped by `account_id`) act as the final safety net. Error code `23505` is caught and logged but does not crash the engine.

### DB Migration: Scoping Strike Constraints by Account
To prevent strike conflicts between different accounts, the database constraints are drop-protected and recreated using unique index constraints:
```sql
-- Drop old global constraints
ALTER TABLE active_positions DROP CONSTRAINT IF EXISTS unique_buy_strike_per_type;
ALTER TABLE active_positions DROP CONSTRAINT IF EXISTS unique_sell_strike_per_type;

-- Drop old constraints/indexes if they exist as separate relations
DROP INDEX IF EXISTS unique_buy_strike_per_type;
DROP INDEX IF EXISTS unique_sell_strike_per_type;
DROP INDEX IF EXISTS idx_active_positions_buy_strike_unique;
DROP INDEX IF EXISTS idx_active_positions_sell_strike_unique;

-- Create new account-scoped unique index constraints (expiry included so the same
-- strike on a different expiry is not treated as a duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique 
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique 
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike);
```

**Write Throttle (`lastDbWriteRef`)**: Tracks Unix timestamp of the last local database write. The Supabase Realtime subscription skips updates if a local write occurred within the last **3 seconds** to prevent a just-written position from being overwritten by a stale re-fetch before the DB has finished committing. (Previously 10 seconds — reduced to minimize the staleness window.)

### RLS Policies & Database Setup Safety

- **Profiles Table Fallback Policy**: Supports client-side profile fallback creation with an `INSERT` policy enabling authenticated users to insert their own profile:
  `CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);`
- **Default Config Fallback**: To prevent `NOT NULL` DB constraint crashes, if no configuration exists for a newly created account, the application and engine initialize a default configuration row (`id: activeAccountId`) populated with standard parameters.
- **Trade History ID & Lot Size Alignment**: The `trade_history` table features a distinct primary key `id` (UUID) alongside the custom `trade_id` string, and includes a `lot_size` column to prevent UI query crashes when displaying realized trades.

### Margin Calculation (`calcMargin` & Live UI Margin)

Applied at entry in both engines and dynamically in the frontend UI:

- **Leverage**: Fixed at **200×**
- **Short Value Cap**: Capped at **$195,000** (`Math.min(195000, shortValue)`)
- **Static Entry Margin**: `margin = (entryBuyPrice × buyLotSize) + (shortValue / leverage)`
- **Dynamic Live UI Margin**: In the frontend UI (`PaperTrading.jsx`), the margin for active positions is calculated in real-time as:
  `liveMargin = (currentBuyPrice × buyLotSize) + (shortValue / leverage)`
  where `currentBuyPrice` is the live option premium quote (falling back to `entryBuyPrice` if unavailable) and `shortValue` uses the live underlying spot price (capped at `$195,000` exposure), allowing the margin to tick dynamically in real-time.

---

## 7) Paper Trading Engine (`engine/paperTradingEngine.js`)

### Multi-Account Supervisor Loop

The engine file (`paperTradingEngine.js`) executes a top-level **Supervisor Manager** (`startPaperTradingEngine`) upon start:
1. **Initial Bootstrap**: Fetches all existing accounts from the `paper_trading_accounts` table.
2. **Parallel Startup**: All account engines are started simultaneously via `Promise.allSettled(accounts.map(acc => startAccountEngine(acc)))`. This reduces startup time from ~30s (sequential `for...await`) to ~3s regardless of account count. `allSettled` is used instead of `Promise.all` so one account's startup failure does not block others.
3. **Database-Driven Hot-Reloading**: Subscribes to Supabase realtime database changes on the `paper_trading_accounts` table:
   - **INSERT**: Automatically triggers creation of a new isolated engine loop for the newly added account ID.
   - **DELETE**: Clears the evaluation intervals for the deleted account, stopping its execution loops immediately.
   - **UPDATE**: Updates the balance and active metadata values in the running account engine context.
4. **Scoped State & Constraints**: Every query, mutation (exits, entries), duplicate position guard, and margin cap check evaluates scoped strictly by `account_id` so that accounts remain completely isolated.
5. **Single-engine-per-account guard**: `startAccountEngine` reserves the account **synchronously** in a `startingEngines` set *before* `await startSingleAccountEngine(...)`, so a concurrent trigger (initial fetch / fallback sync / Realtime event) can't spawn a second (zombie) evaluator that double-books exits. The set entry is cleared in `finally` so a failed start can retry. Process-level, `ecosystem.config.cjs` pins `exec_mode: 'fork'` + `instances: 1` so PM2 never cluster-spawns a second copy.
6. **Live gating**: each account loop reads `mode`, `live_enabled`, and `paused`. All real-order effects are gated on `mode === 'live' && live_enabled`; a global `DELTA_LIVE_DRYRUN` (default ON) logs intended orders instead of sending. `paused` opens no new positions but keeps managing open ones.
7. **Manager-level manual-action poll**: a single `pollAllRequests` timer (every 1.5s) runs ≤4 batched queries (one per request table, filtered to all running account ids) and dispatches to each engine's `processRequests(flags)` only for request types with pending rows. The two live-only tables (`delta_close_requests` / `delta_cancel_requests`) are queried only when ≥1 running account is armed-live, so a paper-only deployment issues just 2 queries/tick. This replaced per-engine 1.5s×4 polling (≈`4×N` — ~4.6M queries/day at ~19 accounts) with a flat ~230K/day.

### Strategy Versioning (Paper v2 vs Live v1)

`paper_trading_config.strategy_version` (default `1`, migrations `018`–`020`) gates experimental logic in the single shared codebase: `if (config.strategyVersion >= 2) { …experimental… } else { …stable… }`. **Live accounts run v1** (validated), **paper accounts run v2** (the experimental testbed). Both engine behaviour and which UI controls appear branch on this value. Fleet policy (migration `020`): all paper = v2, all live = v1; new accounts inherit from `mode`. The column is kept (rather than a raw `mode` check) so a single live account can be promoted to v2 for a staged rollout. v2-gated features to date: the hedge leg (022/023); Trading Days (021) and per-window Min DTE (019) were **promoted to the shared path** and now run on paper AND live.

### Evaluation Loop & Execution Decoupling

Called every second by `setInterval`. Uses the `isEvaluating` mutex to prevent re-entrant execution. Four background timers run in parallel:

| Timer | Interval | Purpose |
|-------|----------|---------|
| **Evaluation loop** | 1 second | Core brain — exits every tick, entries on minute boundaries |
| **Spot price poll** | 10 seconds | REST-based fallback spot price update |
| **Product refresh** | 5 minutes | Refreshes available option contracts from Delta Exchange |
| **Positions fallback sync** | 2 minutes | Re-fetches active positions from Supabase as a safety net against missed Realtime events (reduced from 30s) |

* **Exit Evaluation (every 1 second)**: The engine runs `evaluateStrategy(true)` (Exit-Only) on intermediate seconds. It iterates over active positions, calculates real-time liquidation value P&L and fees, and checks exit triggers (ATM, expiry, rotations) against streaming WebSocket ticker quotes and polled spot prices. If no exits occur, it does not query or write to Supabase.
* **Full Evaluation (every minute boundary)**: The engine runs `evaluateStrategy(false)` (Full Run) when a new clock-minute crosses (`currentMinute > lastMinute` or on startup). In addition to checking exits, it scans for new spread candidates, filters them by ATM P&L >= $50, sorts them to pick the best ROI candidate per buy strike, checks DB-level count/strike restrictions, and inserts new positions into Supabase.

* **Spot Price Staleness Guard**: If the polled spot price hasn't updated in 120 seconds (`120000` ms), the evaluation is skipped as a safety measure against dead pricing feeds.

Steps: A → B → C → D → E → F (detailed in sections below).

### A. Candidate Pool Construction

1. **Self-Contained Local Scan**: The headless engine runs its own `scanTickers` (same algorithm as `RatioSpreadScanner`) on calls and puts separately, filtered by option type and ATM direction. Unlike the browser-based version, the headless engine does **not** merge results from the `RatioSpreadScanner` `BroadcastChannel` — it is fully self-contained.
2. **Unique Ranking List (`uniqueTopSpreads`)**: A deduplicated and filtered view of candidate spreads. Grouped by buy strike: we keep the highest-ROI candidate and, if it conflicts with active positions, also append the next best non-conflicting fallback candidate (to prevent entry lockouts as slots free up after two-phase exits). The lists of candidates are sorted by distance to ATM (closest first) and sliced to `Math.max(10, numberOfCalls/numberOfPuts)` dynamically. Used for ranking and entry decisions.

### B. Sorted Position Processing (Worst-First)

All active positions are sorted by descending `|buyStrike - spotPrice|` (farthest OTM first). This ensures the weakest positions are evaluated for exits before the stronger ones.

### Dynamic ATM Ratio-Based Scaling

For each active position, before evaluating its full exit triggers (such as expiry or ATM exit), the engine checks whether the position qualifies for a partial scale-down based on profitability, trailing PnL threshold, and ATM ratio drift:

1. **Profitability Guard**: The position's unrealized `currentGrossPnl` (including accumulated sell PnL) must be **greater than zero**. This prevents scaling from triggering immediately at entry when PnL is zero.
2. **Trailing Threshold Check**: Checkpoint values are recovered from `pos.buyLeg` metadata (or initialized from entry values on first evaluation). The trailing threshold is `checkpointAtmPnl * 0.10 + checkpointPnl`. The condition `currentGrossPnl >= threshold` must be met, meaning the position's PnL is at or above the trailing threshold.
3. **Hypothetical Reduction & Recalculation**: The engine hypothetically reduces the current long lot size by `deltaBuyQty` (10% of the position's fixed initial scaled lot size `pos.buyLeg.initialScaledLotSize`): `hypotheticalLotSize = currentLotSize - deltaBuyQty`. It then recalculates the position's lot ratio under this hypothetical reduction: `recalculatedRatio = pos.sellQty / hypotheticalLotSize`.
4. **ATM Ratio Comparison (1:x comparison)**: The live ATM ratio (`liveAtmRatio`, computed as `buyIntrinsic / sellIntrinsic` rounded to nearest `0.25`) is compared to the `recalculatedRatio`. The condition is: **`liveAtmRatio >= recalculatedRatio + 1`**. This means the market's ATM ratio must be at least **1** point higher than the recalculated position ratio before the exit is triggered.
5. **Floor Limit**: The hypothetical long lot size must be at or above the dynamic floor limit of 50% of the position's fixed initial scaled lot size (`pos.buyLeg.initialScaledLotSize * 0.5`).
6. **Execution**: If all conditions are met (while loop):
   - Record a **partial exit** to `trade_history` with `is_partial: true`, the closed buy lot size as `deltaBuyQty`, and the closed sell lot size and sell quantity as `0`. The `exit_reason` is recorded in a concise format containing the exact initial and live ATM buy/sell prices, live and recalculated ratios, and original net debit/credit at entry of the position.
   - Update `pos.buyLeg.lotSize = hypotheticalLotSize`.
   - Update `pos.buyLeg.maxAtmRatio` in metadata to reflect the new ratio of the position (`recalculatedRatio`).
   - `entryAtmRatio` is **preserved** (never modified — it is a historical entry-time value).
   - Save checkpoint values: `pos.buyLeg.lastCheckpointPnl = currentGrossPnl` and `pos.buyLeg.lastCheckpointAtmPnl = liveAtmPnl`.
   - **`sellQty` remains unchanged**.
   - Recalculate checkpoints, threshold, `currentGrossPnl`, `hypotheticalLotSize`, and `recalculatedRatio` for the next iteration check of the loop.
6. **State Persistence**: After the loop completes, if any scaling occurred, recalculate remaining position margin using `calcMargin` and update columns (`buy_leg`, `entry_fee`, `margin`, `accumulated_sell_pnl`) in the `active_positions` table.

> ⚠️ **Misleading DB Column Name**: The `accumulated_sell_pnl` column in `active_positions` does **not** track sell-leg PnL. It actually stores the accumulated **buy leg** partial exit gross PnL. This naming is a legacy artifact — the column tracks the total buy-side profit realized through partial exits so that the remaining position's live PnL calculation remains correct.

### C. Exit Priority Tree

Each position is evaluated in strict priority order:

**Priority 1 — Data Gap Guard:**
- If `latestTickerDataRef` has no `bid` or `ask` for a position's legs, the position is skipped (kept in `remaining`) rather than exited with stale data.

**Priority 2 — Expiry Settlement (Hard Exit):**
- Condition: `Date.now() >= expiryTs - 120,000ms` (2 minutes before expiry).
- Action: 100% exit, `exitReason = 'Expiry Reached (2min Early)'`.
- **Zombie guard**: If the position is more than **10 minutes** past expiry (`Date.now() > expiryTs + 600,000ms`), its `exit_time` is back-dated to the exact expiry timestamp (`new Date(expiryTs).toISOString()`) for accurate reporting — ensuring trade history records reflect the true expiry moment rather than when the engine discovered the stale position.
- **Bypasses all other guards.**

**Priority 3 — Dynamic Exit (ATM, ITM, OTM):**

Evaluated only if no expiry exit was triggered.
- Condition: Spot price crosses the target price defined by the exit type and points offset relative to the buy strike:
  - **ATM**:
    - Call: `spotPrice >= buyStrike`
    - Put: `spotPrice <= buyStrike`
    - Exit Reason: `Full Exit @ ATM`
  - **ITM**:
    - Call: `spotPrice >= buyStrike + exitPoints`
    - Put: `spotPrice <= buyStrike - exitPoints`
    - Exit Reason: `Full Exit @ ITM (+{exitPoints}pts)` for calls / `(-{exitPoints}pts)` for puts
  - **OTM**:
    - Call: `spotPrice >= buyStrike - exitPoints`
    - Put: `spotPrice <= buyStrike + exitPoints`
    - Exit Reason: `Full Exit @ OTM (-{exitPoints}pts)` for calls / `(+{exitPoints}pts)` for puts
- Action: 100% exit.

**Priority 4 — Short-Leg-Only Exit ($1.1):**

> The former Priority-4 **Rotation & Leg Swap** logic has been **removed** (see §E). A full spread is now unwound in two phases; this is phase one. In actual code order the short-leg exit and the long-ladder exit (§D) are checked **before** the expiry / ATM-ITM-OTM catch-alls above — those remain the catch-alls for the held long.

- Config: `shortExitPrice` (default `1.1`). For full spreads (`sellQty > 0`), each cycle reads the short leg's **live ask**; if `liveAsk <= shortExitPrice` the engine buys back **only** the short at the ask (gap-safe — fires even if the ask jumped past the threshold) and **holds** the long.
- Fires **once** per position — setting `sellQty → 0` blocks re-trigger.
- Booked in `trade_history` as a partial (`is_partial = true`, `exit_reason = "Short Leg Exit @ Ask $…"`, `trade_id = ${pos.id}-SE`). The short's entry-fee share is apportioned (`calculateFee(entrySellPrice, entrySpotPrice, sellQty, sellLotSize)`, capped to the remaining entry fee).
- Position becomes long-only: `sellQty = 0`, `sellLeg.lotSize = 0`, margin recomputed `calcMargin(entryBuyPrice, buyLot, spot, 0, 1)`; the long lot is snapshotted as `buyLeg.longExitBaseLot` (`longExitStage = 0`) and persisted in `buy_leg`. The row is **kept** (not deleted).

### D. Long-Only Laddered Exit

Once a position is long-only, the held long is scaled out as its own **bid** recovers. Config: `longExitSlices` (default `10`) + a "Variable Exit Slices" toggle.

- **Constant Mode (toggle OFF):** exactly 5 slices — if current bid `< 25` → levels `[10,20,30,40,50]`; if bid `>= 25` → `[25,50,75,100,125]`.
- **Variable Mode (toggle ON):** `longExitSlices` equidistant levels from the current bid up to `pastHigh` = the max candle high over the last 4h (`getOptionHigh(symbol, 4)`, falling back to the entry buy price if candles are unavailable). First slice exits immediately at the current bid; `step = (upperBound − currentBid) / (longExitSlices − 1)`, level `i = currentBid + i·step`.
- Each slice sells at the **bid** (the same bid is both trigger and exit price); multiple crossed levels exit in one cycle (while loop). Each slice books a partial (`is_partial = true`, `exit_reason = "Long Leg Exit @ level $X (Bid $Y)"`, `trade_id = ${pos.id}-LE-${stage}`). The final level clears the rounding remainder, then the position is **deleted**.
- Progress is persisted in `buy_leg` JSON (`longExitStage`, `longExitBaseLot`, `longExitLevels[]`) so it survives restarts with no recompute. The expiry / ATM-ITM-OTM catch-all still applies to the remainder.

### E. Removed: Rotation, Leg Swap, Full Portfolio Rotation

The former Priority-4 rotation logic — Leg Swap (same sell strike, better buy strike), the "Lost Protected Rank" standard rotation, Target Reservation / 1-for-1 displacement, and Full Portfolio Rotation — has been **removed** from the engine. `legSwapNetPremium` is retained in config only for back-compat (default `0`, unused). Position improvement is now achieved by letting the two-phase exit (§C-P4 + §D) close positions and opening fresh candidates on the next minute boundary.

### E2. Hedge Leg — Per-Spread 3rd Long (paper v2)

Migrations `022` (config columns on `paper_trading_schedules`: `hedge_strike_type`, `hedge_call_price/pct`, `hedge_put_price/pct`) + `023` (leg columns `active_positions.hedge_leg` / `trade_history.hedge_leg`). **`strategy_version >= 2` (paper) only**; v1 hides the UI and ignores it.

- **Type** `none`/`call`/`put`/`both`; **Price** = a premium budget ($) — the engine buys the **OTM** strike (call > spot / put < spot) whose ask is the **highest ≤ budget** (if none qualifies, the hedge is skipped and a plain 2-leg spread is entered, with a warning); **Percentage** — 3rd-long qty = short qty × pct/100, forming a **long / short / long triplet**.
- **Entry gate**: Max Net Debit applies to the combined 3-leg premium `combinedNet = shortQty×sellBid − longAsk − hedgeQty×hedgeAsk`; if it exceeds `maxNetPremium` the whole entry is skipped. Hedge cost is added to margin; the hedge fee is tracked in `hedgeLeg.entryFee` (kept out of `pos.entryFee`).
- **Exit**: the hedge rides the triplet and is closed **only** by the main long's ATM/ITM/OTM spot-cross or expiry catch-all — never short-bought-back, laddered, or scaled. If the main long ladders out first, the row is held "hedge-only" (`lotSize = 0`) until the catch-all. Sold at live bid (fallback entry price), `trade_id = ${pos.id}-HX`, `exit_reason = "Hedge Exit @ <ATM|ITM|OTM|Expiry>"`, logs `🛡️ HEDGE EXIT`. Armed-real uses a `-HB` buy at entry (non-fatal on failure) + a `-HX` reduce-only close.

### F. ATM P&L & ROI Candidate Filtering

Spreads scanned from the options chain are evaluated for their potential At-The-Money payout:
1. **getTickerPrice**: Sourced using live quotes (bid for long leg, ask for short leg) with nearest-strike fallbacks.
2. **ATM P&L Calculation**: `[(ATM_Bid - entryBuyPrice) - (OTM_Ask - entrySellPrice) × sellQty] × lotSize`.
3. **ROI Calculation**: `(ATM_PnL / Margin) × 100`.
4. **Gauntlet Filter**: Candidates with `ATM P&L < $50` are discarded.
5. **Selection**: For each unique buy strike, candidates are sorted by ROI descending, and the one with the highest ROI is chosen.

### G. Entry Logic

New entries are opened from `uniqueTopSpreads` (the deduplicated, ROI-ranked candidate list) after the exit pass.

**Whole-cycle pre-entry gate (`wantEntries`):** before any candidate work, `wantEntries = !onlyExits && !accountState.paused && isTradingDayEnabled()`. If false — an **exits-only** cycle, the account is **paused**, or the current **trading day is disabled** — the engine skips the *entire* candidate-evaluation pass (per-spread ATM P&L/ROI compute, grouping, and the `Evaluating…`/`Candidate…` logs); `processedSpreads` stays empty so all downstream selection is a no-op. Exits and position management always run. This applies to paper AND live.

- **Trading Days** (`isTradingDayEnabled`, migration `021`): `config.tradeDays` is a JSONB array of JS `getDay()` weekdays (`0=Sun…6=Sat`, default all-7). The active trading-day weekday is computed on the **17:30 IST** boundary (`1050` min): `istMin >= 1050 ? (getUTCDay()+1)%7 : getUTCDay()` — i.e. at/after 17:30 IST the active day is *tomorrow's* weekday. A disabled weekday blocks new entries for that trading day only.

Per-candidate guards (when `wantEntries` is true):

1. **Expiry Buffer Guard**: Skip if `minutesToExpiry < 5`.
2. **Min Days to Expiry Guard**: Now driven by the **active schedule window's** `daysToExpiry` (migration `019`, paper v2) rather than an account-level field; the traded expiry is chosen as `current date + window DTE` (see §7 Product Refresh & Expiry). Live (v1) uses the account-level threshold and rolls forward only.
3. **Strike Uniqueness (Local)**: Block if buy or sell strike already active in `remaining` or `newEntries` (same type/underlying).
4. **Portfolio Cap (Local)**: Block if `remaining + newEntries count >= config.numberOfCalls` (for calls) or `config.numberOfPuts` (for puts) for this type.
4. **Execution**: `entryBuyPrice = spread.ask`, `entrySellPrice = spread.bid`. Entry IVs captured: `entryBuyIv = ticker.askIv`, `entrySellIv = ticker.bidIv`. Baseline ATM ratio (`entryAtmRatio`) and unscaled lot size (`originalLotSize`) are computed.
   - **ATM Ratio Entry Scaling**: If `atmRatioScaling` is enabled, the target ratio is scaled using a percentage offset: `targetRatio = originalRatio + (pct / 100) * (atmRatioVal - originalRatio)`, where `pct` is `atmRatioPctCall`/`atmRatioPctPut` and `atmRatioVal` is the live ATM ratio rounded to 0.25. The entry ratio to use is `ratioToUse = Math.max(spread.sellQty, Math.round(targetRatio / 0.25) * 0.25)`. Both long lot size and short quantity are scaled under the 200X leverage limit ($195k cap) using this `ratioToUse`.
   - The final scaled values are written to `buy_leg` JSON metadata and stored inside Supabase `active_positions`.
5. **$195K Short Value Cap**: If `spotPrice × sellQty × sellLotSize >= $195,000`, both lot size and sell qty are scaled down proportionally to bring the short notional to exactly $195K.
6. **Supabase Insert (with three DB-level guards)**:
   - Count guard: `SELECT id WHERE underlying AND type AND account_id` — abort if count `>= config.numberOfCalls` (for calls) or `config.numberOfPuts` (for puts).
   - Buy strike uniqueness: `SELECT id WHERE buy_strike = X AND account_id` — abort if exists (`buyConflict`).
   - Sell strike uniqueness: `SELECT id WHERE sell_strike = Y AND account_id` — abort if exists (`sellConflict`).
   - Unique constraint `23505` is the final net.

### H. State Update Strategy

- **Structural changes** (exits or entries): `setPositions(finalPositions)` — full array replacement.
- **PnL-only updates** (no exits or entries at minute boundary): `setPositions(prev => prev.map(p => byId.get(p.id) ?? p))` — in-place functional update to prevent table re-mount flash.

### I. Config Auto-Creation

When the engine starts for a new account and no `paper_trading_config` row exists (Supabase returns error code `PGRST116`), it **auto-creates** a default configuration row:

| Field | Default Value |
|-------|---------------|
| `underlying` | `BTC` |
| `min_strike_diff` | 800 |
| `min_iv_diff` | 5 |
| `max_ratio_deviation` | 0.25 |
| `min_sell_premium` | 10 |
| `max_net_premium` | 20 |
| `min_long_dist` | 500 |
| `max_sell_qty` | 10 |
| `atm_ratio_scaling` | `true` |
| `atm_ratio_distance_call` | 50 |
| `atm_ratio_distance_put` | 25 |
| `days_to_expiry` | 0 |
| `exit_type` | `'ATM'` |
| `exit_points` | `0` |
| `strategy_version` | `1` for live accounts, `2` for paper (from `mode`) |
| `trade_days` | `[0,1,2,3,4,5,6]` (all days) |
| `short_exit_price` | `1.1` |
| `long_exit_slices` | `10` |
| `initial_balance` | `3000` (paper only, migration `027`) |
| `max_combined_positions` | `4` (paper only, migration `027`) |
| `combined_split_pct` | `70` (paper only, migration `027`) |

### J. Config Hot-Reload via Supabase Realtime

Each account engine subscribes to `postgres_changes` events on the `paper_trading_config` table (filtered by `account_id`). When a config change is detected (e.g., user clicks **Apply** or **Reset** in the UI):

1. The engine re-reads the full config row from the database.
2. If the **underlying** or **expiry** has changed from the previous config:
   - Products are re-fetched from the Delta Exchange API.
   - Active positions are re-loaded from Supabase.
   - The ticker cache is cleared (`tickerData = {}`).
   - The WebSocket is torn down and restarted with the new symbol set.
   - Tickers are backfilled via REST for the new symbols.
3. If only filter parameters changed (e.g., `minStrikeDiff`, `minIvDiff`), the new values are applied in-memory immediately and take effect on the next evaluation cycle — no WS restart needed.

### K. Visual Simulation Mode (ATM Ratio Scaling)

The manual, dollar-based visual "Base/Extra" credit simulation has been completely removed from both the scanner and paper trading screens. 

- **Ratio Spread Scanner Simulation**: Driven directly by the configuration-level ATM Ratio Entry settings (`atmRatioScaling` toggle and `atmRatioPctCall` / `atmRatioPctPut` offsets). When enabled:
  - The **scaled short quantity (`scaledSellQty`) is computed inside `scanTickers`** (before the Max Debit filter); `ResultTable.jsx` **consumes** it and renders the derived margins, net premiums, and projected ATM P&Ls in real-time under the 200X leverage limit ($195k portfolio cap) — it no longer recomputes the scaling itself.
  - Ratios that differ from their default baseline values due to scaling are highlighted in golden text (`var(--accent)`, `#f0b90b`).
- **Paper Trading Interface**: Does not perform local client-side visual simulation; it renders active position metrics (`sellQty`, `lotSize`, `margin`, `PnL`) as-is from the database. The scaled quantity values are computed and locked directly in Supabase by the backend engine at entry-time.

### L. KPIs & History

- **Today's Realized P&L**: Filters `tradeHistory` where `exitTime` (offset by +12h UTC) matches today's settlement-aligned date string. Invalid dates (`isNaN(d.getTime())`) are safely skipped.
- **Today's P&L**: `todayRealizedPnl + totalUnrealizedPnl`.
- **All-Time P&L**: `totalRealizedPnl + totalUnrealizedPnl`.
- **Win Rate**: Closed trades where net PnL > 0 / total trades.
- **Date Navigation**: Prev/Next/Today buttons adjust `historyFilterDate` (UTC-aligned ISO string). All-history mode clears the filter.
- **CSV Export**: Exports all visible history rows with entry/exit prices, IVs, fees, PnL, and exit reason.




## 8) Robustness & Error-Handling Systems

### React Date Parsing Crash Guard

`PaperTrading.jsx` guards all date filtering logic:

- **Threat**: `new Date(invalidString)` creates an `Invalid Date`. Calling `.toISOString()` on it throws `RangeError: Invalid time value`, crashing the entire React component tree.
- **Solution**: `if (isNaN(d.getTime())) return false;` is checked immediately after parsing any `exitTime` from the database before any offset or formatting logic.
- **Scope**: Applied in `filteredTradeHistory` and `todayRealizedPnl` memo hooks in both engines.

### Layout Stability

- Table columns use fixed pixel widths and `font-variant-numeric: tabular-nums` to prevent layout shifts during 1-second PnL updates.
- KPI header containers use fixed-width spans to prevent number-width jitter.

### VPS Resilience

- The 1-second `setInterval` heartbeat drives `evaluateStrategy` continuously, ensuring live calculations are maintained even if WebSocket is quiet.
- `createTickerStream` auto-reconnects every 3 seconds on unexpected close.
- `lastWsSymbolsRef` prevents needless WebSocket churn during product refreshes.
- Margin backfill on load.
- **Supabase Realtime** keeps all open browser sessions in sync with the VPS engine tab within < 1 second of any position change, eliminating the previous 10-15 second cross-device lag.

---

## 9) ATM Projections in ResultTable (`ResultTable.jsx`)

To visualize potential outcomes, the Result Table projects the value of each scanned spread to the At-The-Money (ATM) boundary. This uses direct, live option chain lookups via `tickerData` instead of Greeks (Delta/Gamma) or theoretical calculations:

### 1. True ATM Strike Sourcing
The true market ATM strike is calculated globally in the scanner component (by inspecting the entire unfiltered options chain) and passed as `trueAtmStrike` to `ResultTable.jsx`. This ensures that aggressive filtering in the scanner does not lead to a wrong ATM strike calculation.

### 2. `getTickerPrice` — Expiry-Filtered Bracket-and-Average Fallback

All ATM price lookups go through `getTickerPrice(strike, optType, priceField, expiry)`:

1. **Filter by type and expiry**: Collects all tickers from `tickerData` matching `optType` (case-insensitive) and the requested `expiry`. Returns `null` immediately if no tickers match.
2. **Exact match**: If a ticker at the requested `strike` is found, its `priceField` (or `markPrice` as fallback) is returned — or `null` if the value is missing/zero.
3. **Bracket-and-average fallback**: If no exact match exists (a "weird" `ATM ± strikeDiff` target can land *between* two listed grid strikes, e.g. `±1100` between listed `1000`/`1200`), the scanner takes the **nearest listed strike below** and the **nearest listed strike above** the target and returns the **average** of their prices as a midpoint estimate (equivalent to linear interpolation for the symmetric case). This replaces the old single-nearest **snap**, which biased toward one side and skewed the ATM ratio. If only **one** side exists within tolerance, it falls back to that single strike.
4. **Tolerance** (each side must be within): **`1000`** points for BTC and **`50`** points for ETH.
5. **Returns `null`** (never `0`) when no strike falls within tolerance on either side, so callers can cleanly distinguish "no data" from "priced at zero".

> [!NOTE]
> The bracket-and-average is applied identically in the **scanner** (`scanTickers` getTickerPrice), the **display** (`ResultTable`), **and the live/paper engine** (`getTickerPrice` in `paperTradingEngine.js`) — same tolerance (BTC `1000` / ETH `50`) and midpoint logic — so entry sizing, live ATM-ratio scaling, and ATM-exit pricing match the scanner's shown ATM ratio (no snap-vs-bracket divergence).

### 3. At ATM Ask/Bid Option Chain Shifting & Ratio
- **Long Leg (ATM)**: Option valued at the current Bid price of the option at `atmStrike` (via `getTickerPrice(atmStrike, type, 'bid')`).
- **Short Leg (OTM)**: Option valued at the current Ask price of the option at strike `atmStrike + strikeDiff` (for Calls) or `atmStrike - strikeDiff` (for Puts), with the same bracket-and-average fallback. Because only `sellIntrinsic` is priced at the (possibly missing) target, this fallback mainly moves the **ATM ratio** — and hence the scaled short quantity and ATM P&L that flow from it.
- **At ATM Ratio**: Displayed as `1 : X`, where `X = Math.round((ATM_Bid / OTM_Ask) / 0.25) * 0.25`. If either price is `null`, ratio displays as `—`.
- **Rendering**: Each price cell shows `$XX.XX` when available, or `—` (muted colour) when the ticker returned `null`.

### 4. At ATM P&L & ROI %
- **`hasAtmData` guard**: Both `buyIntrinsic` and `sellIntrinsic` must be non-null for P&L to be computed.
- **At ATM P&L** (when `hasAtmData = true`):
  `P&L = [(ATM_Bid - entryBuyPrice) - (OTM_Ask - entrySellPrice) × sellQty] × lotSize`
- **ROI %**: `(At ATM P&L / Margin) × 100` — only computed when `atAtmPnl != null && margin > 0`.
- **Rendering**: When `hasAtmData` is `true`, renders the signed dollar P&L and the `±ROI%` line. When `false`, renders a muted `—` to clearly signal missing data rather than showing `$0.00 / 0.00%`.

### 5. At ATM Margin
- **Margin Calculation**: Derived from **spread entry prices** (not ATM chain data), so it is always available:
  `shortValue = Math.min(195000, spot × sellQty × sellLotSize)`
  `leverage = 200`
  `margin = (buyPrice × buyLotSize) + (shortValue / leverage)`
- **Always rendered**: Because margin does not depend on ATM quote availability, it is never suppressed.
- **Sorting**: The scanner table groups the spreads by buy strike, sorts the group strikes by their highest candidate ROI descending, and sorts all options/sub-rows within each group by ROI descending. This ensures the most margin-efficient opportunities are ranked at the top.

### 6. ATM Edge Floors (Min ATM P&L / Min ATM ROI)

Two display-time floors let the user hide spreads whose projected at-ATM edge is too small. Unlike the [scanner entry filters](#5-ratio-spread-scanner-ratiospreadscannerjsx) (which run in `scanTickers`), `ATM PnL`/`ROI` are derived from live ATM ticker data and computed only in `ResultTable`, so these floors filter the processed rows right before grouping and re-evaluate live as ATM quotes move.

- **Gated behind `atmRatioScaling`**: the `minAtmPnl` / `minAtmRoi` inputs live in the ATM-scaling section and apply **only while that checkbox is enabled**; with it off, both floors are ignored.
- **Both must pass**: a row is kept only when `ATM PnL >= minAtmPnl` (USD, default `0`) **and** `ROI >= minAtmRoi` (%, default `0`).
- **Missing-ATM-data rows are kept**: a row with no ATM data (shown as `—`) stays visible rather than flickering in and out on a transient missing quote.

### Margin Backfill on Load

On first spot price arrival, `backfillMargins` queries all `active_positions` from Supabase and recalculates each position's margin using the latest spot price and the current leverage tier. This corrects any stale margin values persisted from a prior session.

---

## 10) Multi-Account Management & UI Modals

### 1. Account Dropdown Selectors
- **Location**: Mounted in the navigation headers of both `PaperTrading.jsx` and `RatioSpreadScanner.jsx`.
- **Implementation**: Switches `activeAccountId` state locally. When switched on the scanner tab, it automatically halts the current scan process via `stopScan()` to avoid configuration leaks across accounts.
- **Theme-Friendly Styling**: Bound to responsive theme properties:
  - Background: `var(--bg3)`
  - Border: `1px solid var(--border)`
  - Font Color: `var(--text)`
  - Option items: Explicit styling overrides `style={{ background: 'var(--bg3)', color: 'var(--text)' }}` to guarantee clean contrast on various browsers.

### 2. Custom React Modals
- **Create Account Modal**:
  - Collects Name and initial Strategy Filters (Underlying, Days to Expiry, Min Strike Diff, Min IV Diff, Max Ratio Dev, Min Sell Premium, Max Debit, Min Long Dist, Max Sell Qty, and ATM Ratio Scaling with Call/Put ATM percentages).
  - Pre-fills all strategy filters with the current active filters on the screen as convenient defaults.
  - Utilizes `react-hook-form` for input validation and error feedback.
  - Validations:
    - Account Name: Required, trimmed input must be non-empty.
  - Visual Indicators:
    - Invalid inputs are styled with a red border (`border: 1px solid #f85149`).
    - Validation error messages are rendered in red text directly beneath the corresponding invalid fields.
  - State: `isCreatingAccount` tracks loading state.
  - Buttons: Cancel and Create are disabled when `isCreatingAccount` is true. An inline spinning SVG is rendered inside the Create button.
- **Delete Account Modal**:
  - State: `isDeletingAccount` tracks loading state.
  - Checks if the account has open positions; if yes, displays a prominent warning that positions will be cascaded.
  - Refreshes state instantly by invoking `await fetchAccounts()` immediately post-deletion to avoid stale lists.
  - Buttons: Cancel and Delete are locked during execution with a spinning SVG loader inline.
- **Renaming Account (Edit Account Modal)**:
  - Triggered by clicking a pencil icon next to the active account details (Name displayed in a compact visual pill container).
  - Opens a custom styled React modal allowing the user to update the Account Name.
  - The modal inputs are pre-populated with the active account's current values.
  - Utilizes `react-hook-form` for input validation and error feedback.
  - Validations:
    - Account Name: Required, trimmed input must be non-empty.
  - Visual Indicators:
    - Invalid inputs are styled with a red border (`border: 1px solid #f85149`).
    - Validation error messages are rendered in red text directly beneath the corresponding invalid fields.
  - On submit:
    - Locks input and action buttons (Cancel/Save) by toggling `isSavingAccount`.
    - Renders a spinning inline SVG loader inside the Save button.
    - Performs an optimistic local state update to `accounts` for immediate visual responsiveness.
    - Updates name in a database update query against `paper_trading_accounts`.
    - Refreshes account list using `fetchAccounts()` to sync changes globally, then closes the modal.

---

## 11) Paper Trading Filter State Buffering (Apply & Reset)

To prevent continuous writes to Supabase during filter updates, editing filter values in `ControlPanel.jsx` is buffered in a local React draft state.

> **Control Panel vs Schedule Panel split.** The Control Panel now shows only **global filters** — Min IV Edge, Max Delta Deviation, Min Short Premium, Max Net Debit, Max Short Ratio, Min DTE, Exit Type/Points, Short Exit Price, Variable/Long Exit Slices, and the Trading Days toggle. The **8 sizing/scaling fields** (open calls/puts, spread width, spot distance, ATM scaling + call/put %, re-entry step) were **removed from it** — they are set at account creation and configured **per window** in the Schedule Panel (§12). Apply/Reset/dirty-tracking operate only on the global filters.

### 1. State Management
- `draftConfig`: A copy of the configuration currently active in the UI inputs.
- `updateDraftConfig(keyOrObj, value)`: Modifies the `draftConfig` object without changing `config`.
- `FILTER_KEYS`: the **global-only** buffered set (Min IV Edge, Max Delta Deviation, Min Short Premium, Max Net Debit, Max Short Ratio, Min DTE, Exit Type, Exit Points, Short Exit Price, Long Exit Slices + variable-slices flag, Trading Days). The sizing/scaling fields are no longer buffered here.

### 2. Button Enablement & Actions
- **Apply Button**:
  - Bound to `isFiltersDirty` selector which checks if any properties in `FILTER_KEYS` differ between `draftConfig` and `config`.
  - When clicked, calls `handleApplyFilters` which updates `config` state, writes the configuration to Supabase, and broadcasts `CONFIG_SYNC` to synchronize tabs.
- **Reset Button**:
  - When clicked, calls `handleResetFilters` which restores filters from the account's **`default_config` JSONB column** (falling back to factory defaults for legacy accounts), saves them to Supabase immediately, and broadcasts `CONFIG_SYNC` across tabs.

### 3. Cross-Device Config Sync
Beyond `BroadcastChannel` (per-origin, one machine), `PaperTrading.jsx` subscribes to `paper_trading_config` **Supabase Realtime** and refetches on a foreign change so a config edit on one device reflects on another. The refetch is skipped while the tab's own save is in flight and while `isFiltersDirty` (debounced), so it never clobbers an in-progress edit.

---

## 12) Time-Based Filter Schedules

Time-Based Filter Schedules are implemented as a per-account configuration that allows overriding core entry/portfolio parameters based on a schedule. The database stores these times directly in Indian Standard Time (IST) format using `TIME` data type columns, and the back-end engine evaluates matches based on current IST minutes.

### 1. Database Schema
Table: `paper_trading_schedules`
- `id` (UUID, primary key, default: `gen_random_uuid()`)
- `account_id` (UUID, foreign key referencing `paper_trading_accounts(id)`, on delete cascade)
- `label` (TEXT, user-defined name for the window)
- `start_time` (TIME, e.g., `"17:30:00"`, stored in IST)
- `end_time` (TIME, e.g., `"22:29:00"`, stored in IST)
- `number_of_calls` (INTEGER, max concurrent calls override — **live** cap)
- `number_of_puts` (INTEGER, max concurrent puts override — **live** cap)
- `max_combined_positions` (INTEGER, default `4`, migration `027`, **paper only**) — cap on total open full spreads (calls + puts); also the per-position-margin divisor
- `combined_split_pct` (NUMERIC, default `70`, migration `027`, **paper only**) — derives the per-type cap `ceil(split% × combined)` for both calls and puts
- `min_long_dist` (INTEGER, override for minimum long strike distance)
- `min_strike_diff` (INTEGER, override for minimum strike difference)
- `atm_ratio_scaling`, `atm_ratio_pct_call`, `atm_ratio_pct_put`, `spot_diff` (per-window sizing/scaling + re-entry step)
- `max_net_premium` (Max Net Debit, migration `012`)
- `exit_type` (`ATM`/`ITM`/`OTM`), `exit_points` (migration `012`, **active-window-governs** open positions)
- `min_days_to_expiry` (migration `019`, **paper v2** — the traded expiry follows the active window)
- `hedge_strike_type`, `hedge_call_price`, `hedge_call_pct`, `hedge_put_price`, `hedge_put_pct` (Hedge Leg, migration `022`)
- `is_active` (BOOLEAN, default `true`, permanently active — the Enabled checkbox was removed)
- `created_at` (TIMESTAMPTZ, default `now()`)

> **Window 1** is permanent per account: auto-created and seeded from the base `paper_trading_config`, **cannot be deleted** (Windows 2, 3… are), and defaults to a full-day `17:30`→`17:29` IST range so the schedule normally has no gaps. The account base config remains the **gap fallback**.

RLS Policies:
- Enable select/view and insert operations for authenticated users (`auth.uid() = user_id`) to support client-side fallback insertion.
- Enable public `SELECT` read access (`Allow public read on schedules` policy using `true` check) to allow the unauthenticated background engine process (which uses `SUPABASE_ANON_KEY`) to load schedules successfully.

### 2. Engine Evaluation Loop Overrides
- **State management**: The engine maintains a local `schedules = []` array.
- **Fetch & Refresh**: `fetchSchedules()` queries the database for schedules belonging to the active account on startup, and refreshes them dynamically upon real-time Postgres updates or every 2 minutes as fallback.
- **Time Comparison (`getActiveSchedule()`)**:
  - The current server time is converted to **IST minutes since midnight** (`istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440`).
  - For each active schedule, start/end minutes are parsed from the `"HH:mm"` IST time values loaded from the database.
  - Overnight windows are supported in IST: if `startMin > endMin` (e.g., `22:29` to `06:30` IST), a match occurs if `istMin >= startMin || istMin < endMin`. Otherwise, a match occurs if `istMin >= startMin && istMin < endMin`.
  - The first matching active schedule window is returned.
  - On overlap, the window with the **smallest DTE** wins; in an uncovered gap the last-ended window carries forward before dropping to the base config.
- **`effectiveConfig` Generation**:
  - If a schedule window matches, the engine creates an `effectiveConfig` by spreading the account's base configuration and overriding the scheduled properties: `numberOfCalls`, `numberOfPuts`, `minLongDist`, `minStrikeDiff`, the ATM-ratio scaling fields, `spotDiff`, `maxNetPremium`, `exitType`, `exitPoints`, `minDaysToExpiry` (v2), and the hedge fields.
  - If no schedule window matches, `effectiveConfig` falls back to the base account config.
  - All scanner candidate matching, position-limit evaluations, and the **exit-type check** (paper) / spot-cross catch-all (live) inside `evaluateStrategy()` utilize this `effectiveConfig` — so an open position's exit level follows the active window. (Live SL/TP brackets are placed at entry from the then-active window and are re-synced, not auto-moved, on a window flip — see §13.)

### 3. Frontend Schedule Configuration UI (`SchedulePanel.jsx`)
- **Layout & Style**: Designed as a compact, horizontal, inline-editable list, rather than heavy collapsible cards.
- **Visual Schedule Timeline**: A 24-hour visual bar is rendered at the top of the schedule panel, representing the daily trading cycle starting and ending at `17:30` IST (the Delta Exchange daily rollover/settlement boundary = `12:00` UTC). The bar renders colored blocks indicating configured schedule windows and gaps (hashed fallback/base configuration). Empty slots naturally display at the end of the bar, and calculations wrap around the `17:30` IST boundary.
- **Timezone Serialization**: Frontend inputs and the timeline visualization operate in Indian Standard Time (IST) for user convenience. Times are loaded and saved directly as raw IST time strings without UTC offset translations. trailing seconds (`:00`) added by database `TIME` columns are cleaned using `.substring(0, 5)` on fetch.
- **CRUD Operations**:
  - Users edit schedule labels, time inputs (in IST), and strategy override parameters (`numberOfCalls`, `numberOfPuts`, `minLongDist`, `minStrikeDiff`) directly in inline-editable fields.
  - The "Enabled" checkbox has been removed, making all schedule windows permanently active (`isActive = true`).
  - **Add Window**: Appends a new default window to the state.
  - **Delete Window**: Removes the window from the state (Window 1 is not deletable).
  - **Live Auto-Sync**: Updates are automatically saved to Supabase after a 1.2-second debounce, provided there are no active time overlaps. The "Save Schedules" button acts as a live sync indicator showing `✓ Live Synced`, `Syncing...`, or `Overlap Detected`.
  - **Upsert-then-prune (never DELETE-all)**: each window carries a stable UUID; the save **upserts** all windows (`onConflict:'id'`) and only **after success prunes** removed windows (`delete … where id not in (keptIds)`). This fixes the old failure mode where a failed post-DELETE insert left zero rows and reseeded a lone Window 1 from base config ("filters changed by themselves"). A `paper_trading_schedules` Realtime subscription re-syncs across devices, skipped while the local save is in flight / edits are dirty.

---

## 13) Live Trading Execution

The live engine is the **same** `paperTradingEngine.js` with real-order effects layered in and gated on `mode === 'live' && live_enabled`; paper logic is unchanged. Full narrative: [live_trading.md](live_trading.md).

### 13.1 Credential Security (Stage 1)

- **Table `delta_credentials`** (one row/account): `api_key` (public, sent in header), `api_secret_enc` (encrypted with pgcrypto `pgp_sym_encrypt` under a Supabase **Vault** key), `key_last4`, `status` (`unverified`/`verified`/`invalid`), `verified_at`.
- **RLS + RPCs**: `anon`/`authenticated` can never read the secret. Clients write only via `SECURITY DEFINER` RPC **`upsert_delta_credentials`** (checks ownership, encrypts server-side); owners read metadata via **`get_delta_credentials_meta`**; only **`service_role`** decrypts via **`get_delta_credentials_decrypted`**. One-time: `select vault.create_secret('…','delta_cred_encryption_key')` (else `upsert_delta_credentials` raises `Encryption key not configured`).
- **Verification (IP-whitelisted)**: Delta keys are IP-whitelisted, so verification is engine-mediated — the browser calls RPC `request_delta_verification` (encrypts the secret with the Vault key) → engine polls `delta_verify_requests`, runs the balance check from the whitelisted IP, writes the result back (`get_delta_verification_status`); rows purged after 1 hour (migration `004`). Alternatively `engine/proxyServer.js` (`DELTA_PROXY_PORT`) forwards `/v2/*`.
- **Delta auth reference**: base URL `https://api.india.delta.exchange`; headers `api-key`, `signature`, `timestamp`; `signature = HMAC_SHA256(secret, method + timestamp + path + query + body)` hex, `timestamp` in Unix seconds.

### 13.2 Safety Layer (dry-run / kill-switch / arming)

- **`DELTA_LIVE_DRYRUN`** (default **true**): intended orders logged `🧪 DRY-RUN…`, never sent. **`live_enabled`** per-account kill-switch (Start/Disarm). **`paused`** opens no new positions but keeps managing open ones. Missing `service_role` key or credentials ⇒ live disabled, paper unaffected.
- **`mode`** on `paper_trading_accounts` (`paper`/`live`); switching back to paper forces `live_enabled = false`. All flags propagate via Realtime.

### 13.3 Dual exit model

- **Paper OR dry-run live** → the **active model** (the exact paper exit tree of §C/§D; each branch also sends a `reduce_only` close via `live.closeLeg()` when armed, logged in dry-run).
- **Armed real live** (`DELTA_LIVE_DRYRUN=false`) → the **resting-order model** (`handleLiveRestingExit`): exits rest in the exchange book and fill on their own. Dry-run cannot exercise this (needs a real exchange). The old index-triggered SL/TP model (`handleLiveExit`/`computeIndexTriggerLevel` for exits) is retired.

### 13.4 Resting-order model mechanics

- At entry a reduce-only **limit BUY** rests on the short at `shortExitPrice` (default `$1.1`), tag `${id}-SEX`. When it **fully** fills — detected by `order_id` in `/v2/fills` (id persisted in `sell_leg`, restart-safe) **AND** short size = 0 — the engine books `${id}-SE`, converts to long-only, and places the **fixed long ladder** (5 levels: `[10,20,30,40,50]` if long bid < 25 else `[25,50,75,100,125]`; `S` contracts split evenly via `splitContracts`; `S≤5` → fewer levels). Each slice books `${id}-LE-<stage>`; slice PnL maps integer contracts back to fractional lots (`lot = baseLot × contracts / S`).
- **ATM-ratio scale-down** while still a full spread uses the shared `applyAtmRatioScaling` helper and fires a **reduce-only MARKET close** (`live.closeSymbol`, IOC — immediate fill; `${id}-PEX-…`, book `${id}-PE-<lots>`). It market-closes rather than resting a limit because the trigger is dynamic — a GTC limit at the bid would sit unfilled once the price moved, leaving the engine's book ahead of the real position. The filled `-PEX` order lands in Order History where the UI derives "Partial Exit". **Whole-contract sizing**: the real order size = `round(lotBefore/base) − round(lotAfter/base)` (not per-chunk rounding), so sub-contract steps accumulate and the exchange position stays exactly `round(lotSize/base)`.

### 13.5 Exchange brackets (engine-down risk backstop)

- `openSpread` attaches a **spot-triggered bracket** per leg at the exit-type level (`computeIndexTriggerLevel`; ATM = buy strike, ITM/OTM = ± points): long → `bracket_take_profit_price`, short → `bracket_stop_loss_price`, `bracket_stop_trigger_method: spot_price`. Delta auto-cancels it when the leg closes.
- `syncExitBrackets` is idempotent and computed-level-driven, storing two levels per leg: `brkComputed` (drives drift detection) vs `brkLevel` (effective level on Delta). When `exitType`/`exitPoints` change (base or window), brackets are moved by **cancel-then-recreate** (`changePositionBracket`) because Delta has no "edit position bracket" call. `resyncRestingOrders` re-prices the short buy-back via `editOrder`.
- Bracket-set rejections handled without false alarms: `no_open_position` (leg already closed — skip quietly), `bracket_order_immediate_execution` (level already breached — market-close immediately via reduce-only IOC), `bracket_order_exists` (already protected).

### 13.6 Balance-allocation sizing

- Live accounts size from the **live Delta USDT wallet balance** (not the paper `$195k`). `part = (balance × balance_allocation_pct) ÷ maxPositions`, `maxPositions = max(numberOfCalls + numberOfPuts)` across base + all windows. Unit margin via `calcMargin` using real per-contract `contractValue` + current spot; `scale = part ÷ unitMargin` (floored at 1); `longC = round(scale)`, `shortC = round(longC × ratioToUse)`. Then capped so short notional (`spot × shortC × contractValue`) ≤ **$195,000**. Missing `contractValue` for either leg ⇒ **skip the entry** (never guess). Logs `💰 LIVE size…` / `🧢 LIVE qty capped…`.
- **Long-only margin** uses the contract-value basis (`longOnlyMargin`, `buyLeg.contractValue` persisted at entry). A per-cycle **margin self-heal** recomputes each open live position's margin on that basis (preferring `symbolMeta.contractValue`), persisting only on material change (contractValue fix or drift past `max($0.50, 2%)`).

### 13.7 Entry robustness

- **Price offsets**: buy @ ask + `entry_buy_offset` (10), sell @ bid − `entry_sell_offset` (3) — affect only the sent limit price; the stored entry price stays ask/bid.
- **Chase-fill (all-or-nothing)**: `openSpread`/`submitChase` chase each leg to a full fill (`editOrder` re-price, up to `ENTRY_CHASE_ATTEMPTS`=3 every `ENTRY_CHASE_POLL_MS`=5000 with `ENTRY_CHASE_BUMP`=1); if still unfilled → **unwind + abort**, no insert.
- **Same-product collision guard** (Fix B): skip any candidate whose leg symbol already holds a position (`live.positions()` ∪ tracked book). **Dangling-short recovery** (Fix A): `sellQty>0`, short open, long gone → reduce-only market close `${id}-DANGX`. **Benign `no_position_for_reduce_only`** (Fix D): treated as `{ok:true, alreadyClosed:true}`.
- **Atomic-ish insert**: orders placed first, row written last; a failed insert unwinds via `${id}-ORPHX`; the in-memory book is rebuilt only from `persistedEntryIds`. **Long residual sweep** (`-LSWEEP`) reduce-only market-closes any long contracts left open after the laddered exit deletes the row.
- **Price sanitization** (`cleanLimitPrice`): every limit/stop price rounded to 4 dp and stringified before send (raw float noise causes Delta `bad_schema`).
- **`client_order_id` length clamp** (`clampClientOrderId`, applied in `submit`/`marketClose`/`placeStop`): Delta caps `client_order_id` length — an over-long tag also triggers `bad_schema`. The clamp keeps the **tail** (so `…-SE`/`-LE-0`/`-PEX`/`-XB-ATM` markers survive for reason-derivation) up to `MAX_COID` (36). Root cause was the **adopted-orphan id**, which embedded the full symbol (`ADOPT-P-BTC-62400-200726-…-LE-0`, 38 chars) → now a short `A<ts36><rand>` id (mirrors the normal `T…` entry id; the `_adopted` flag, not the id string, marks adopted rows).

### 13.8 Exchange reconciliation (exchange is source of truth)

- `reconcileOrphans` handles **book→exchange** (tracked row gone from Delta → book + remove). `protectOrphanExchangePositions` handles **exchange→book**: a **long orphan** (known symbol, buy strike free) → `adoptLongOrphan` (build from Delta's real `entry_price`, insert first, **arm a TP bracket only — NO scale-out ladder**; a manually-added / standalone long has no short to justify a ladder, so it's managed by the TP bracket + the ATM/ITM/OTM spot-cross and expiry catch-alls. The laddered exit is reserved for the pair short-exit flow — `handleLiveRestingExit` / `externalShortExitToLongLadder`); a **naked short orphan** → reduce-only market close + alert; can't adopt → protect + alert.
- **Stale `-PEX` cleanup**: any resting `-PEX` limit found on Delta is a leftover from the older build that rested the partial scale-down (now market-closed, §13.4) — the engine already booked it as sold, so the exchange holds long the book thinks is gone. Each sweep reduce-only **market-closes** its remaining size (`PEXCLEAN-<symbol>`) **then cancels** the redundant limit (close-first is retry-safe — a transient close failure leaves the resting order for the next sweep). A successful reconcile fires a **Telegram** trade alert (`🧹 PARTIAL EXIT (reconcile)` via `notifyTrade`); a failure fires `notifyLiveFailure`. Self-heals to a no-op once none remain.
- **Manual changes on Delta**: full close → book + delete; **short-only close** → `externalShortExitToLongLadder` (dangling-long recovery: `sellQty>0`, short 0, long>0, age>90s, `_shortEverOpen`; books `${id}-SE`, converts to long-only, places `${id}-LE-*`, latched); **TP/SL change** → `adoptManualBrackets` (into `brkLevel` only); **bracket cancel** → `armMissingBrackets`; **partial reduction** → `reconcilePartialReductions` (book `${id}-XPR-L|S-<remaining>`). Guards: armed-real only, reuses the sweep's snapshot, 120s grace (`orphanSeenAt`), once-per-orphan latch.

> Known race (benign): the resting-fill handler and the dangling-long reconciler can both fire for one short-flat event across the two timers; the shared `${id}-SE` idempotent write and deterministic `${id}-LE-*` tags (Delta rejects the duplicate) prevent any double PnL or double ladder.

### 13.9 `client_order_id` tag taxonomy

`-SE` (short exit book) · `-SEX` (resting short buy-back) · `-LE-<stage>` (ladder slice) · `-LEX-…` (active-model bid-cross ladder) · `-PE-<lots>` (partial book) · `-PEX-…` (partial reduce-only MARKET close) · `PEXCLEAN-<symbol>` (stale `-PEX` limit reconcile) · `-HB`/`-HX`/`-HDX` (hedge buy / exit / drain) · `-DANGX` (dangling-short flatten) · `-ORPHX` (orphan unwind) · `-LSWEEP` (long residual sweep) · `-XPR-L|S-<remaining>` (external partial reconcile) · `-XB|XS-<ATM|ITM|OTM|EXP>` (strategy exit) · `-CAXB|CAXS` (Close All) · `MX*`/`MLC`/`CX` (manual exit / leg close / close).

### 13.10 Live exchange data pipeline (dashboard)

- `live.snapshot()` reads `/v2/positions/margined`, `/v2/orders` (split resting vs stop by `stop_order_type`), `/v2/fills`, `/v2/wallet/balances` via `Promise.allSettled` every **20s** (read-only; runs in dry-run too). **Change-guarded upsert** to `live_exchange_state` (migration `009`): writes only on structural-signature change, else ≤1/60s keepalive; immediate republish after a manual action.
- `TradingWorkspace.jsx` renders real Delta tabs only when live + `engineDryRun === false` + a fresh snapshot; otherwise tabs are engine-derived. **Live-fresh unrealized PnL** recomputed from the WS mark feed (`livePnlOf() = size × contract_value × (mark − entry)`). **Exit Reason** derived from `stop_order_type` + `client_order_id` tag.
- **Positions tab — spread grouping + toolbar** (`DeltaPositionsTable`). Each Delta leg is grouped under its owning engine position (`posBySymbol`, matched by leg symbol) so the buy (long) and sell (short) legs of one spread render adjacently under a group header showing `<TYPE> · Buy/Sell <strikes> · <expiry>`, the spread **entry time** (`ep.entryTime`), and the **combined Net P&L** (`g.pnl = Σ livePnlOf(leg).pnl`). Orphan legs (no engine row) form their own group. A toolbar sorts/filters at the **group level** (`useState` for `sortKey`/`sortDir`/`pnlFilter`/`typeFilter`): **Sort** = Entry Time / Net P&L / Near TP/SL (`triggerDist` = min `|spot − TP/SL level|` across the group's legs; nearest first); **Filter** = P&L (all/win/loss) and Type (all/call/put). Per-key default direction (entry→newest, pnl→winners, trigger→nearest); default view is entry-time newest-first.

### 13.11 Telegram failure alerts

`engine/lib/telegram.js` (`notifyLiveFailure`), fire-and-forget, armed-real only. Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (both required, else disabled), `TELEGRAM_DEDUPE_MS` (60000). Triggers: order/close/stop/bracket failure (benign codes suppressed), protective close failure, entry aborted, orphan reconcile failure, armed-but-no-credentials. Each message: account, failure, Delta error, UTC timestamp; deduped.

---

## 14) Manual Actions & Diagnostics

### 14.1 Manual actions (consolidated poll)

UI writes a row/flag; the engine executes on Delta and books idempotently:
- `active_positions.exit_requested = true` → cancel resting + market-close + book **Manual Exit** (`exit_reason='Manual Exit'`). `ConfirmExitModal.jsx` also does the paper path directly (INSERT `trade_history` + DELETE `active_positions`; the Realtime DELETE filters it from engine memory).
- `delta_close_requests` (`account_id`, `product_symbol`) → reduce-only market-close that leg (incl. untracked orphans) + delete row.
- `delta_cancel_requests` (`order_id`, `product_id`) → cancel + delete.
- `paper_trading_accounts.close_all_requested = true` → native `close_all` flatten (per-position fallback); `processCloseAll` reads the flag straight from the DB every tick (the 30s fallback sync omits the column).

All four are dispatched by the manager-level `pollAllRequests` (see §7); migration `016` grants admin RLS bypass on these tables.

### 14.2 Diagnostic logging (0 candidates)

`scanTickers()` returns `{ pairs, rejected }`, where `rejected` counts per-filter drops: `strikeDiff, noPrice, staleQuote, noIv, ivDiff, longDist, sellPremium, noDelta, ratioDev, maxSellQty, netPrem`. When a full run yields 0 candidates the engine logs the **top rejecting filter** — e.g. `0 candidates — top filter: minSellPremium rejected 171 pairs` or `stale WS quote (>120s) rejected 83 pairs`, plus pool diagnostics (`Ticker pool: N total, 0 match expiry — WS may not have started yet`). The same top filter across all accounts at once indicates a market condition (theta decay), not a bug.

---

## 15) Auth & RBAC

- **Email-only login**: the dashboard derives the Supabase password deterministically (`OptionScope_${cleanEmail}_Secure123!`); first login auto-creates a `profiles` row with `role:'client'`.
- **Roles**: `client` sees only its own `user_id` accounts; `admin` sees all accounts and can assign an owner at creation and write to any account.
- **Migration `016`** (`016_admin_manage_accounts.sql`) adds an admin bypass (`OR EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin')`) to the RLS policies on `paper_trading_accounts`, `paper_trading_config`, `paper_trading_schedules`, `active_positions`, `trade_history`, `delta_close_requests`, and `delta_cancel_requests` — previously admin writes silently no-op'd (an RLS-filtered UPDATE affects 0 rows with no error).

### UI details (heartbeat / capacity / date filter)

- **Heartbeat thresholds** (`engine_heartbeat`, polled 30s, paused when tab hidden): Online `age<60s` (green `#0ecb81`), Stale `60–120s` (yellow `#f0b90b`), Offline `≥120s` (red `#f85149`).
- **Window Capacity row** (`TradeHistoryTable.jsx`): a chip per schedule window showing name + `C:`/`P:` caps and a color dot matching the Schedule Panel timeline palette; hover shows the time range.
- **Live Utilized %** (SchedulePanel): `(min(numberOfCalls,activeCalls)+min(numberOfPuts,activePuts))/(numberOfCalls+numberOfPuts)×100`, full spreads only, account-wide.
- **Trade-History "today" filter** uses a **UTC+12h** offset (`d.setUTCHours(d.getUTCHours()+12)`) so the day flips at noon UTC = **17:30 IST**, matching Delta's settlement rollover.
