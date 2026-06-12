# Low Level Design — OptionScope

This document is the authoritative implementation reference for every module, engine, data pipeline, and safety guard in OptionScope.

---

## 1) Project Structure & Codebase Map

| File | Responsibility |
|---|---|
| `main.jsx` | Root bootstrap and routing shell. Mounts all 4 modules simultaneously using `display: none/block` to preserve state across navigation. Owns the shared `page` and `theme` state and the `BroadcastChannel` sync instance. |
| `App.jsx` | Interactive charts, greeks tracking, alert manager, SMA overlay, and support/resistance drawing tools. |
| `RatioSpreadScanner.jsx` | Standalone option-chain scanner. Computes premium-to-delta-notional ratio deviation pairs, publishes top-3 results via `BroadcastChannel` and `localStorage`. Configuration is managed locally in `localStorage` independent of Paper Trading accounts. |
| `PaperTrading.jsx` | React UI Dashboard for Paper Trading. Reads `active_positions`, `trade_history`, and heartbeat from Supabase. Connects to multi-account creation/management modals and controls configuration updates via a local draft buffer (Apply/Reset buttons). |
| `engine/paperTradingEngine.js` | Headless Node.js engine. Handles entries, full ATM exits, rotation, IV tracking, fee calculations, and Supabase persistence. |
| `ResultTable.jsx` | Reusable grouped table renderer for ratio spread candidates. |
| `api.js` | Network abstraction: Delta REST calls, `createTickerStream` (WS with auto-reconnect), `createWS` (raw WS), `getTickers` (REST backfill). |
| `scannerUtils.js` | Shared helpers: `normalizeIv`, `toFiniteNumber`, `matchesOptionType`, `formatTime`, `formatDateTime`. |
| `supabase.js` | Supabase client singleton. |
| `useTabSync.js` | `BroadcastChannel` sync hook (`useTabSync` for root, `useTabListener` for children). |
| `engine/lib/deltaApi.js` | Backend API adapter for Delta Exchange. Implements WebSockets with auto-reconnect, ticker stream parsing, REST endpoints, and unconfirmed (timestamp = 0) REST ticker backfills. |
| `engine/lib/utils.js` | Shared backend algorithmic logic including candidate spread scanning (`scanTickers` with quote freshness validation), rotation target selection, and margin calculations. |
| `engine/lib/heartbeat.js` | Helper module executing the continuous status update ticks for the backend engines to Supabase. |
| `engine/lib/supabase.js` | Supabase client initialization wrapper for backend VPS engines. |

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
2. **REST Backfill (`refreshAllTickers` / `backfillTickers`)**: Triggered on algo start or manual page refresh. Calls `/v2/tickers` and merges results into the local ticker cache without zeroing existing data — prevents the "PnL = 0" glitch before the first WebSocket frame arrives. Crucially, to prevent executing entries on stale/model-derived REST prices, backfilled quotes are tagged with `bidUpdatedAt = 0` and `askUpdatedAt = 0` (marking them as unconfirmed).
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
| `atmRatioScaling` | `false` | Whether to scale quantity based on ATM ratio |
| `atmRatioPctCall` | `50` | Scale percentage for Call option scaling |
| `atmRatioPctPut` | `50` | Scale percentage for Put option scaling |

### Market Ingestion Flow

1. Load products from REST for the selected underlying.
2. Extract all strikes for the selected expiry and build a `symbolMeta` map: `symbol → { strike, lotSize, type }`.
3. Subscribe all symbols to `createTickerStream`. Each incoming frame updates `tickerBufferRef`.
4. A 50ms debounce timer batches the buffer into `latestTickerDataRef` and triggers a `setTickerData` re-render.

### Pair Evaluation (`computeSpreads` / `scanTickers`)

The scanner runs an O(N²) pair search within each option type (calls and puts separately):

1. **Directional Filtering**: Universe is split at ATM — Calls at strike `>= atmStrike`, Puts at strike `<= atmStrike`.
2. **Leg Assignment**: For calls, the lower strike is the buy (long) leg; for puts, the higher strike is the buy leg.
3. **Strict Execution-Realistic Pricing & Freshness Check**: `buyPrice = buyLeg.ask`, `sellPrice = sellLeg.bid`. The pair is skipped immediately if either active quote is missing. No fallback to `markPrice` or `lastPrice` is allowed for entries. Additionally, quotes must be WS-confirmed and fresh: both legs are checked to ensure their `bidUpdatedAt` and `askUpdatedAt` timestamps are greater than `0` (ignoring REST-backfilled data) and less than 120,000 milliseconds old (`Date.now() - updatedAt < 120000`), preventing stale entries on illiquid strikes.
4. **Directional IV**: `buyIv = buyLeg.askIv ?? iv`, `sellIv = sellLeg.bidIv ?? iv`. Pair is skipped if either IV is null.
5. **Filter Gauntlet** (all must pass):
   - `strikeDiff >= minStrikeDiff`
   - `ivDiff > minIvDiff`
   - `spotDist >= minLongDist` (buy strike to spot)
   - `sellPrice >= minSellPremium`
   - `ratioDeviation <= maxRatioDeviation`
   - `netPremium >= -maxNetPremium` (one-sided upper bound debit cap)
   - `sellQty <= maxSellQty`
6. **`sellQty` Calculation**: `rawQty = buyDN / sellDN`, rounded to nearest 0.25 with minimum of 1.
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
| `paper_trading_config` | PaperTrading | `underlying`, `expiry`, all filter thresholds | Single `global` row, upserted on config change |
| `active_positions` | PaperTrading | `id`, `buy_strike`, `sell_strike`, `buy_leg` (JSON), `sell_leg` (JSON), `accumulated_sell_pnl`, `margin` | Unique DB constraints `unique_buy_strike_per_type` and `unique_sell_strike_per_type` scoped by `(account_id, underlying, type, strike)` prevent duplicate inserts |
| `trade_history` | PaperTrading | `trade_id`, `realized_net_pnl`, `exit_reason`, `is_partial`, `exit_time`, `total_fees` | `trade_id` pre-checked before insert to prevent duplicates |


### Concurrency Safety Guards

**Supabase Realtime Subscription**: On mount (when `trading = true`), the engine subscribes to `postgres_changes` events on `active_positions` (`event: '*'`). Any INSERT, UPDATE, or DELETE by any client (engine tab, browser tab) triggers an immediate `fetchSupabaseActivePositions()` call, delivering the update to all connected sessions in < 1 second. The channel is unsubscribed (`supabase.removeChannel`) on component unmount or when `trading` becomes `false`.

**Egress Optimization & Polling Removal**: Standard 10-second fallback polling intervals for positions and trade history are completely removed from the UI. The UI relies on the Realtime channels for updates, reducing PostgREST bandwidth.

**DB-Level Count Guard (pre-insert)**: Before inserting any new position, the engine queries `active_positions` for the current `(underlying, type)` pair. If the live count is `>= 3`, the insert is aborted. Uses plain `.select('id')` (not `{ head: true }`) to ensure non-null response data.

**DB-Level Strike Uniqueness (pre-insert)**: After the count check, the engine queries active positions for duplicate `buy_strike` (`buyConflict`) and `sell_strike` (`sellConflict`) values for the same `(underlying, type)` and `account_id`. If any conflict is found, the insert is aborted with a console warning.

**DB Unique Constraint Fallback**: PostgreSQL unique constraints `unique_buy_strike_per_type` and `unique_sell_strike_per_type` (scoped by `account_id`) act as the final safety net. Error code `23505` is caught and logged but does not crash the engine.

### DB Migration: Scoping Strike Constraints by Account
To prevent strike conflicts between different accounts, the database constraints must be dropped and recreated to include `account_id`:
```sql
-- Drop old global constraints
ALTER TABLE active_positions DROP CONSTRAINT IF EXISTS unique_buy_strike_per_type;
ALTER TABLE active_positions DROP CONSTRAINT IF EXISTS unique_sell_strike_per_type;

-- Drop underlying indexes if they exist as separate relations
DROP INDEX IF EXISTS unique_buy_strike_per_type;
DROP INDEX IF EXISTS unique_sell_strike_per_type;

-- Create new account-scoped constraints
ALTER TABLE active_positions
  ADD CONSTRAINT unique_buy_strike_per_type UNIQUE (account_id, underlying, type, buy_strike);

ALTER TABLE active_positions
  ADD CONSTRAINT unique_sell_strike_per_type UNIQUE (account_id, underlying, type, sell_strike);
```

**Write Throttle (`lastDbWriteRef`)**: Tracks Unix timestamp of the last local database write. The Supabase Realtime subscription skips updates if a local write occurred within the last **3 seconds** to prevent a just-written position from being overwritten by a stale re-fetch before the DB has finished committing. (Previously 10 seconds — reduced to minimize the staleness window.)

### Margin Calculation (`calcMargin` & Live UI Margin)

Applied at entry in both engines and dynamically in the frontend UI:

- **Leverage**: Fixed at **200×**
- **Short Value Cap**: Capped at **$200,000** (`Math.min(200000, shortValue)`)
- **Static Entry Margin**: `margin = (entryBuyPrice × buyLotSize) + (shortValue / leverage)`
- **Dynamic Live UI Margin**: In the frontend UI (`PaperTrading.jsx`), the margin for active positions is calculated in real-time as:
  `liveMargin = (currentBuyPrice × buyLotSize) + (shortValue / leverage)`
  where `currentBuyPrice` is the live option premium quote (falling back to `entryBuyPrice` if unavailable) and `shortValue` uses the live underlying spot price (capped at `$200,000` exposure), allowing the margin to tick dynamically in real-time.

---

## 7) Paper Trading Engine (`engine/paperTradingEngine.js`)

### Multi-Account Supervisor Loop

The engine file (`paperTradingEngine.js`) executes a top-level **Supervisor Manager** (`startPaperTradingEngine`) upon start:
1. **Initial Bootstrap**: Fetches all existing accounts from the `paper_trading_accounts` table.
2. **Parallel Isolation**: For each account, it spawns an independent, self-contained running instance of the strategy engine (`startSingleAccountEngine(account)`). Each account loop executes on its own 1-second interval cadence (`setInterval`).
3. **Database-Driven Hot-Reloading**: Subscribes to Supabase realtime database changes on the `paper_trading_accounts` table:
   - **INSERT**: Automatically triggers creation of a new isolated engine loop for the newly added account ID.
   - **DELETE**: Clears the evaluation intervals for the deleted account, stopping its execution loops immediately.
   - **UPDATE**: Updates the balance and active metadata values in the running account engine context.
4. **Scoped State & Constraints**: Every query, mutation (exits, entries), duplicate position guard, and margin cap check evaluates scoped strictly by `account_id` so that accounts remain completely isolated.

### Evaluation Loop & Execution Decoupling

Called every second by `setInterval`. Uses the `isEvaluating` mutex to prevent re-entrant execution.

* **Exit Evaluation (every 1 second)**: The engine runs `evaluateStrategy(true)` (Exit-Only) on intermediate seconds. It iterates over active positions, calculates real-time liquidation value P&L and fees, and checks exit triggers (ATM, expiry, rotations) against streaming WebSocket ticker quotes and polled spot prices. If no exits occur, it does not query or write to Supabase.
* **Full Evaluation (every minute boundary)**: The engine runs `evaluateStrategy(false)` (Full Run) when a new clock-minute crosses (`currentMinute > lastMinute` or on startup). In addition to checking exits, it scans for new spread candidates, filters them by ATM P&L >= $50, sorts them to pick the best ROI candidate per buy strike, checks DB-level count/strike restrictions, and inserts new positions into Supabase.

* **Spot Price Staleness Guard**: If the polled spot price hasn't updated in 120 seconds (`120000` ms), the evaluation is skipped as a safety measure against dead pricing feeds.

Steps: A → B → C → D → E → F (detailed in sections below).

### A. Candidate Pool Construction

1. **Self-Contained Local Scan**: The headless engine runs its own `scanTickers` (same algorithm as `RatioSpreadScanner`) on calls and puts separately, filtered by option type and ATM direction. Unlike the browser-based version, the headless engine does **not** merge results from the `RatioSpreadScanner` `BroadcastChannel` — it is fully self-contained.
2. **Unique Ranking List (`uniqueTopSpreads`)**: A deduplicated and filtered view (one entry per buy strike, max 10 per type) where candidate spreads are filtered by `ATM P&L >= $50` and sorted by ROI descending to choose the best candidate per buy strike. Used for ranking, rotation, and entry decisions.

### B. Sorted Position Processing (Worst-First)

All active positions are sorted by descending `|buyStrike - spotPrice|` (farthest OTM first). This ensures the weakest positions are evaluated for exits before the stronger ones.

### Dynamic ATM Ratio-Based Scaling

For each active position, before evaluating its full exit triggers (such as expiry or ATM exit), the engine checks whether the position qualifies for a partial scale-down based on profitability, trailing PnL threshold, and ATM ratio drift:

1. **Profitability Guard**: The position's unrealized `currentGrossPnl` (including accumulated sell PnL) must be **greater than zero**. This prevents scaling from triggering immediately at entry when PnL is zero.
2. **Trailing Threshold Check**: Checkpoint values are recovered from `pos.buyLeg` metadata (or initialized from entry values on first evaluation). The trailing threshold is `checkpointAtmPnl * 0.25 + checkpointPnl`. The condition `currentGrossPnl >= threshold` must be met, meaning the position's PnL is at or above the trailing threshold.
3. **Hypothetical Reduction & Recalculation**: The engine hypothetically reduces the current long lot size by `deltaBuyQty` (25% of the position's fixed initial scaled lot size `pos.buyLeg.initialScaledLotSize`): `hypotheticalLotSize = currentLotSize - deltaBuyQty`. It then recalculates the position's lot ratio under this hypothetical reduction: `recalculatedRatio = pos.sellQty / hypotheticalLotSize`.
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
6. **State Persistence**: After the loop completes, if any scaling occurred, recalculate remaining position margin using `calcMargin` and update columns (`buy_leg`, `entry_fee`, `margin`) in the `active_positions` table.

### C. Exit Priority Tree

Each position is evaluated in strict priority order:

**Priority 1 — Data Gap Guard:**
- If `latestTickerDataRef` has no `bid` or `ask` for a position's legs, the position is skipped (kept in `remaining`) rather than exited with stale data.

**Priority 2 — Expiry Settlement (Hard Exit):**
- Condition: `Date.now() >= expiryTs - 120,000ms` (2 minutes before expiry).
- Action: 100% exit, `exitReason = 'Expiry Reached (2min Early)'`.
- **Zombie guard**: If the position is more than 10 minutes past expiry, its `exit_time` is back-dated to the exact expiry timestamp for accurate reporting.
- **Bypasses all other guards.**

**Priority 3 — ATM Exit:**

Evaluated only if no expiry exit was triggered.
- Condition: Spot price crosses the buy strike (`spotPrice >= buyStrike` for calls, or `spotPrice <= buyStrike` for puts).
- Action: 100% exit, `exitReason = 'Full Exit @ ATM'`.

**Priority 4 — Rotation & Leg Swap:**

Evaluated only if no exit was triggered, the position's expiry matches `selExpiry`, and `uniqueTopSpreads` is non-empty.

1. **Leg Swap Check (Same Sell Strike, Better Buy Strike)**:
   - Always checked first (even if the active position is still in the Top 3 unique candidate strikes).
   - Looks for a candidate in `uniqueTopSpreads` with the exact same sell strike as the active position, but a better (closer to ATM) buy strike.
   - Enforces the **0.5% Spot Step Movement Guard** on the spot price relative to the active position's entry spot base.
   - Enforces the **Net Premium Swap Cost Check**: calculates `netPremiumSwap = (deltaQty * latestSell) - (s.buyPrice - latestBuy)`, where `deltaQty = getScaledSellQty(s) - pos.sellQty` (enforcing the $200,000 portfolio cap scaling at 200× leverage on the candidate's `s.sellQty` first) and `latestSell` is the ask price of the sell leg. If `netPremiumSwap < -10` (representing a debit greater than $10.00), the candidate is rejected.
   - If a valid swap target is found, `shouldExit` is set to `true`, and `exitReason` is set to `Leg Swap: Buy [currentStrike] -> [targetStrike]`.

2. **Fallback to Standard Rotation (Only if not in Top 3)**:
   - Evaluated only if no Leg Swap was triggered, and the position is not in the Top 3 unique strikes (`inTop3 === false`).
   - Finds a `bestTarget` in `uniqueTopSpreads` that passes safety guards (strike conflicts, reservation, and 0.5% spot movement).
   - If the fallback candidate happens to have the same sell strike, it checks the **Net Premium Swap Cost Check** as well; if the cost is too high (i.e. `netPremiumSwap < -10`), it rejects that candidate.
   - If the target is directionally closer to ATM, the exit is approved (`exitReason = 'Lost Top 3 and Rank 1 better target available ([targetStrike])'`).

**Threshold Guard (Rotation Only):**

Rotations are gated by the portfolio depth requirement:

- Calls can only rotate if `activeCallsCount >= 3`.
- Puts can only rotate if `activePutsCount >= 3`.
- Maximum `MAX_ROTATIONS_PER_CYCLE = 3` total rotations per evaluation cycle.

### D. Full Portfolio Rotation

When a standard rotation is executed, the engine performs a full exit (both legs) of the active position and deletes it from Supabase, allowing a new position to be opened during the subsequent entries scan on the minute boundary.

### E. ATM P&L & ROI Candidate Filtering

Spreads scanned from the options chain are evaluated for their potential At-The-Money payout:
1. **getTickerPrice**: Sourced using live quotes (bid for long leg, ask for short leg) with nearest-strike fallbacks.
2. **ATM P&L Calculation**: `[(ATM_Bid - entryBuyPrice) - (OTM_Ask - entrySellPrice) × sellQty] × lotSize`.
3. **ROI Calculation**: `(ATM_PnL / Margin) × 100`.
4. **Gauntlet Filter**: Candidates with `ATM P&L < $50` are discarded.
5. **Selection**: For each unique buy strike, candidates are sorted by ROI descending, and the one with the highest ROI is chosen.

### F. Entry Logic

New entries are opened from `uniqueTopSpreads` (the deduplicated, ROI-ranked candidate list) after the exit pass:

1. **Expiry Buffer Guard**: Skip if `minutesToExpiry < 5`.
2. **Strike Uniqueness**: Block if buy or sell strike already active in `remaining` or `newEntries` (same type/underlying).
3. **Portfolio Cap**: Block if `remaining + newEntries count >= 3` for this type.
4. **Execution**: `entryBuyPrice = spread.ask`, `entrySellPrice = spread.bid`. Entry IVs captured: `entryBuyIv = ticker.askIv`, `entrySellIv = ticker.bidIv`. Baseline ATM ratio (`entryAtmRatio`) and unscaled lot size (`originalLotSize`) are computed.
   - **ATM Ratio Entry Scaling**: If `atmRatioScaling` is enabled, the target ratio is scaled using a percentage offset: `targetRatio = originalRatio + (pct / 100) * (atmRatioVal - originalRatio)`, where `pct` is `atmRatioPctCall`/`atmRatioPctPut` and `atmRatioVal` is the live ATM ratio rounded to 0.25. The entry ratio to use is `ratioToUse = Math.max(spread.sellQty, Math.round(targetRatio / 0.25) * 0.25)`. Both long lot size and short quantity are scaled under the 200X leverage limit ($200k cap) using this `ratioToUse`.
   - The final scaled values are written to `buy_leg` JSON metadata and stored inside Supabase `active_positions`.
6. **Supabase Insert (with three DB-level guards)**:
   - Count guard: `SELECT id WHERE underlying AND type` — abort if count `>= 3`.
   - Buy strike uniqueness: `SELECT id WHERE buy_strike = X` — abort if exists (`buyConflict`).
   - Sell strike uniqueness: `SELECT id WHERE sell_strike = Y` — abort if exists.
   - Unique constraint `23505` is the final net.

### G. State Update Strategy

- **Structural changes** (exits or entries): `setPositions(finalPositions)` — full array replacement.
- **PnL-only updates** (no exits or entries at minute boundary): `setPositions(prev => prev.map(p => byId.get(p.id) ?? p))` — in-place functional update to prevent table re-mount flash.

### H. Visual Simulation Mode (ATM Ratio Scaling)

The manual, dollar-based visual "Base/Extra" credit simulation has been completely removed from both the scanner and paper trading screens. 

- **Ratio Spread Scanner Simulation**: Driven directly by the configuration-level ATM Ratio Entry settings (`atmRatioScaling` toggle and `atmRatioPctCall` / `atmRatioPctPut` offsets). When enabled:
  - The visual scanner (`ResultTable.jsx`) recalculates candidate quantities, margins, net premiums, and projected ATM P&Ls in real-time under the 200X leverage limit ($200k portfolio cap).
  - Ratios that differ from their default baseline values due to scaling are highlighted in golden text (`var(--accent)`).
- **Paper Trading Interface**: Does not perform local client-side visual simulation; it renders active position metrics (`sellQty`, `lotSize`, `margin`, `PnL`) as-is from the database. The scaled quantity values are computed and locked directly in Supabase by the backend engine at entry-time.

### I. KPIs & History

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

### 2. `getTickerPrice` — Expiry-Filtered Nearest-Strike Fallback

All ATM price lookups go through `getTickerPrice(strike, optType, priceField, expiry)`:

1. **Filter by type and expiry**: Collects all tickers from `tickerData` matching `optType` (case-insensitive) and the requested `expiry`. Returns `null` immediately if no tickers match.
2. **Exact match**: If a ticker at the requested `strike` is found, its `priceField` (or `markPrice` as fallback) is returned — or `null` if the value is missing/zero.
3. **Nearest-strike fallback**: If no exact match exists, scans same-type, same-expiry tickers and picks the one whose strike is closest to the target, subject to a tight asset-specific **tolerance**: **`500`** points for BTC and **`50`** points for ETH.
4. **Returns `null`** (never `0`) when no ticker satisfies the tolerance, so callers can cleanly distinguish "no data" from "priced at zero".

### 3. At ATM Ask/Bid Option Chain Shifting & Ratio
- **Long Leg (ATM)**: Option valued at the current Bid price of the option at `atmStrike` (via `getTickerPrice(atmStrike, type, 'bid')`).
- **Short Leg (OTM)**: Option valued at the current Ask price of the option at strike `atmStrike + strikeDiff` (for Calls) or `atmStrike - strikeDiff` (for Puts), with the same nearest-strike fallback.
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
  `shortValue = Math.min(200000, spot × sellQty × sellLotSize)`
  `leverage = 200`
  `margin = (buyPrice × buyLotSize) + (shortValue / leverage)`
- **Always rendered**: Because margin does not depend on ATM quote availability, it is never suppressed.
- **Sorting**: The scanner table groups the spreads by buy strike, sorts the group strikes by their highest candidate ROI descending, and sorts all options/sub-rows within each group by ROI descending. This ensures the most margin-efficient opportunities are ranked at the top.

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
  - Collects Name and Initial Balance.
  - Utilizes `react-hook-form` for input validation and error feedback.
  - Validations:
    - Account Name: Required, trimmed input must be non-empty.
    - Initial Balance: Required, must be a positive number.
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
- **Renaming & Updating Account Balance (Edit Account Modal)**:
  - Triggered by clicking a pencil icon next to the active account details (Name and Balance displayed in a compact visual pill container).
  - Opens a custom styled React modal allowing the user to update both Account Name and Balance in a single transaction.
  - The modal inputs are pre-populated with the active account's current values.
  - Utilizes `react-hook-form` for input validation and error feedback.
  - Validations:
    - Account Name: Required, trimmed input must be non-empty.
    - Balance: Required, must be a positive number.
  - Visual Indicators:
    - Invalid inputs are styled with a red border (`border: 1px solid #f85149`).
    - Validation error messages are rendered in red text directly beneath the corresponding invalid fields.
  - On submit:
    - Locks input and action buttons (Cancel/Save) by toggling `isSavingAccount`.
    - Renders a spinning inline SVG loader inside the Save button.
    - Performs an optimistic local state update to `accounts` for immediate visual responsiveness.
    - Updates both name and balance in a single database update query against `paper_trading_accounts`.
    - Refreshes account list using `fetchAccounts()` to sync changes globally, then closes the modal.

---

## 11) Paper Trading Filter State Buffering (Apply & Reset)

To prevent continuous writes to Supabase during filter updates, editing filter values in `PaperTrading.jsx` is buffered in a local React draft state.

### 1. State Management
- `draftConfig`: A copy of the configuration currently active in the UI inputs.
- `updateDraftConfig(keyOrObj, value)`: Modifies the `draftConfig` object without changing `config`.
- `FILTER_KEYS`: List of filter properties that are buffered (`minStrikeDiff`, `minIvDiff`, `maxRatioDeviation`, `minSellPremium`, `maxNetPremium`, `minLongDist`, `maxSellQty`, `atmRatioScaling`, `atmRatioPctCall`, `atmRatioPctPut`).

### 2. Button Enablement & Actions
- **Apply Button**:
  - Bound to `isFiltersDirty` selector which checks if any properties in `FILTER_KEYS` differ between `draftConfig` and `config`.
  - When clicked, calls `handleApplyFilters` which updates `config` state, writes the configuration to Supabase, and broadcasts `CONFIG_SYNC` to synchronize tabs.
- **Reset Button**:
  - Bound to `isDefaultConfig` selector which checks if all properties in `DEFAULT_FILTERS` match the active `config`.
  - When clicked, calls `handleResetFilters` which restores filters in the state to system defaults, saves them to Supabase immediately, and broadcasts `CONFIG_SYNC` across tabs.
