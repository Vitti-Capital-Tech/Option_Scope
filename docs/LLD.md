# Low Level Design — OptionScope

This document is the authoritative implementation reference for every module, engine, data pipeline, and safety guard in OptionScope.

---

## 1) Project Structure & Codebase Map

| File | Responsibility |
|---|---|
| `main.jsx` | Root bootstrap and routing shell. Mounts all 4 modules simultaneously using `display: none/block` to preserve state across navigation. Owns the shared `page` and `theme` state and the `BroadcastChannel` sync instance. |
| `App.jsx` | Interactive charts, greeks tracking, alert manager, SMA overlay, and support/resistance drawing tools. |
| `RatioSpreadScanner.jsx` | Standalone option-chain scanner. Computes premium-to-delta-notional ratio deviation pairs, publishes top-3 results via `BroadcastChannel` and `localStorage`. |
| `PaperTrading.jsx` | React UI Dashboard for Paper Trading. Reads `active_positions`, `trade_history`, and heartbeat from Supabase. |
| `ATMExitTrading.jsx` | React UI Dashboard for ATM Exit Trading. Reads bucketed analytics and heartbeat from Supabase. |
| `engine/paperTradingEngine.js` | Headless Node.js engine. Handles entries, full ATM exits, rotation, IV tracking, fee calculations, and Supabase persistence. |
| `engine/atmExitEngine.js` | Headless Node.js engine. Self-contained scanner, single ATM exit rule, bucketed analytics aggregation, and separate Supabase tables. |
| `ResultTable.jsx` | Reusable grouped table renderer for ratio spread candidates. |
| `api.js` | Network abstraction: Delta REST calls, `createTickerStream` (WS with auto-reconnect), `createWS` (raw WS), `getTickers` (REST backfill). |
| `scannerUtils.js` | Shared helpers: `normalizeIv`, `toFiniteNumber`, `matchesOptionType`, `formatTime`, `formatDateTime`. |
| `supabase.js` | Supabase client singleton. |
| `useTabSync.js` | `BroadcastChannel` sync hook (`useTabSync` for root, `useTabListener` for children). |

---

## 2) Real-Time Data & Connectivity Layer (`src/api.js`)

### WebSocket Telemetry & Auto-Reconnect Engine (`createTickerStream`)

Used by `RatioSpreadScanner`, `PaperTrading`, and `ATMExitTrading`. Subscribes to the Delta Exchange `v2/ticker` channel and self-heals on unexpected drops.

**Reconnect Lifecycle:**

- **`alive` flag**: Set to `true` on creation, `false` only on a deliberate `.close()` call. Prevents reconnects after intentional shutdown.
- **`reconnectTimer`**: On `onclose` (if `alive` is still `true`), a 3-second `setTimeout` schedules a fresh `new WebSocket()`. Any previous timer is always cleared before setting a new one to prevent ghost reconnect loops.
- **Error Handling**: If the `WebSocket` constructor throws (e.g., bad URL), the catch block also schedules a reconnect if `alive` is true.
- **Clean Shutdown**: `.close()` sets `alive = false`, clears the timer, nullifies `ws.onclose` to suppress the reconnect trigger, then calls `ws.close()`.

**Message Parsing:**

Incoming frames are filtered to only process `type === 'v2/ticker'`. All other message types (e.g., `subscriptions` ack) are silently ignored to prevent noise.

### Key Network Subsystems

1. **Auto-Reconnect**: Self-heals on network drops with a 3-second backoff. Critical for VPS unattended operation.
2. **REST Backfill (`refreshAllTickers`)**: Triggered on algo start or manual page refresh. Calls `/v2/tickers` and merges results into `latestTickerDataRef` without zeroing existing data — prevents the "PnL = 0" glitch before the first WebSocket frame arrives.
3. **Redundant Connection Guard (`lastWsSymbolsRef`)**: Hashes the current symbol list. Skips WebSocket teardown/recreate if the symbol set has not changed, avoiding the "WebSocket closed before established" race condition during periodic 5-minute product refreshes.
4. **50ms Buffered Flush**: All incoming ticker frames are written to `tickerBufferRef` (a plain object). A `setTimeout(flushTickerBuffer, 50)` timer batches and flushes them into `latestTickerDataRef` and triggers a single React state update. This limits render pressure under volatile data bursts.

### Spot Price Streaming & Redundancy

To ensure zero-latency spot prices:
1. **WebSocket Ticker Subscription**: The frontend UI (`PaperTrading.jsx`) and backend engines (`paperTradingEngine.js` and `atmExitEngine.js`) subscribe to the underlying perpetual future contract (e.g., `BTCUSD` or `ETHUSD`) directly over the WebSocket ticker stream. Spot price ticks are processed immediately upon receipt, updating the UI and engine states with zero latency.
2. **Redundant REST Polling Fallback**: All modules continue to poll `getSpotPrice(underlying)` every **10 seconds** via `setInterval` as a safety net in case of WebSocket disconnects or message drops.

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
- **CSV Export Support**: Included as `Entry ATM Ratio`, `Entry ATM Buy Price`, `Entry ATM Sell Price`, `Exit ATM Ratio`, `Exit ATM Buy Price`, and `Exit ATM Sell Price` columns in the exported CSV.

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
| `CONFIG_SYNC` | PaperTrading → Scanner | `{ underlying, expiry, config }` | Propagates filter/expiry changes from Paper Trading to Scanner |

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

### Market Ingestion Flow

1. Load products from REST for the selected underlying.
2. Extract all strikes for the selected expiry and build a `symbolMeta` map: `symbol → { strike, lotSize, type }`.
3. Subscribe all symbols to `createTickerStream`. Each incoming frame updates `tickerBufferRef`.
4. A 50ms debounce timer batches the buffer into `latestTickerDataRef` and triggers a `setTickerData` re-render.

### Pair Evaluation (`computeSpreads` / `scanTickers`)

The scanner runs an O(N²) pair search within each option type (calls and puts separately):

1. **Directional Filtering**: Universe is split at ATM — Calls at strike `>= atmStrike`, Puts at strike `<= atmStrike`.
2. **Leg Assignment**: For calls, the lower strike is the buy (long) leg; for puts, the higher strike is the buy leg.
3. **Execution-Realistic Pricing**: `buyPrice = buyLeg.ask ?? markPrice`, `sellPrice = sellLeg.bid ?? markPrice`.
4. **Directional IV**: `buyIv = buyLeg.askIv ?? iv`, `sellIv = sellLeg.bidIv ?? iv`. Pair is skipped if either IV is null.
5. **Filter Gauntlet** (all must pass):
   - `strikeDiff >= minStrikeDiff`
   - `ivDiff > minIvDiff`
   - `spotDist >= minLongDist` (buy strike to spot)
   - `sellPrice >= minSellPremium`
   - `ratioDeviation <= maxRatioDeviation`
   - `netPremium <= maxNetPremium` (one-sided upper bound debit cap)
   - `sellQty <= maxSellQty`
6. **`sellQty` Calculation**: `rawQty = buyDN / sellDN`, rounded to nearest 0.25 with minimum of 1.
7. **Sorting**: Closest buy strike to ATM first; ties broken by ascending `netPremium`.

### `pickTopUniqueStrikes`

Greedy selection algorithm ensuring each buy strike appears at most once in the output. Scans the sorted pair list and adds spreads whose buy strike has not been seen yet, up to the requested `limit` (default 3).

### Refresh Cadence

- **Initial**: Scan runs immediately when ticker data arrives (fast-track: 2 seconds after first data).
- **Normal**: Aligned to clock-minute boundary via `currentMinute > lastMinute` check.
- **Manual**: Refresh button triggers `computeSpreads(true)` immediately.
- **Product Refresh**: Dedicated background `useEffect` interval runs every 5 minutes in all active modules (`RatioSpreadScanner`, `PaperTrading`, `ATMExitTrading`) independently of trading or scanning status. If the currently selected expiry is no longer present in the active list (e.g., daily rollover occurs), the engine automatically switches to the nearest active expiry, updates the configuration, and syncs/saves the new state to the database.

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
| `active_positions` | PaperTrading | `id`, `buy_strike`, `sell_strike`, `buy_leg` (JSON), `sell_leg` (JSON), `accumulated_sell_pnl`, `margin` | Unique DB constraint on `(buy_strike, sell_strike)` prevents duplicate inserts |
| `trade_history` | PaperTrading | `trade_id`, `realized_net_pnl`, `exit_reason`, `is_partial`, `exit_time`, `total_fees` | `trade_id` pre-checked before insert to prevent duplicates |
| `atm_exit_config` | ATMExitTrading | `underlying`, `expiry`, `min_long_dist`, `min_sell_premium`, `max_ratio_deviation` | Isolated from PaperTrading config |
| `atm_exit_active_positions` | ATMExitTrading | `id`, `buy_strike`, `sell_strike`, `sell_qty`, `accumulated_sell_pnl`, `margin` | Separate runtime state for ATM Exit engine |
| `atm_exit_trade_history` | ATMExitTrading | `trade_id`, `realized_net_pnl`, `exit_reason`, `exit_time`, `exit_spot_price` | Permanent historical record |
| `atm_exit_qty_0_2_5` | ATMExitTrading | `strike_diff`, `underlying`, `type`, `trade_count`, `avg_margin`, `avg_pnl`, `avg_net_premium`, `avg_fees` | Bucket for sellQty <= 2.5 |
| `atm_exit_qty_2_5_5` | ATMExitTrading | same | Bucket for sellQty <= 5.0 |
| `atm_exit_qty_5_7_5` | ATMExitTrading | same | Bucket for sellQty <= 7.5 |
| `atm_exit_qty_7_5_10` | ATMExitTrading | same | Bucket for sellQty > 7.5 |

### Concurrency Safety Guards

**Supabase Realtime Subscription**: On mount (when `trading = true`), the engine subscribes to `postgres_changes` events on `active_positions` (`event: '*'`). Any INSERT, UPDATE, or DELETE by any client (engine tab, browser tab) triggers an immediate `fetchSupabaseActivePositions()` call, delivering the update to all connected sessions in < 1 second. The channel is unsubscribed (`supabase.removeChannel`) on component unmount or when `trading` becomes `false`.

**Fallback Polling**: A 10-second `setInterval` polls `fetchSupabaseActivePositions` and `fetchSupabaseTradeHistory` as a safety net for any missed Realtime events.

**DB-Level Count Guard (pre-insert)**: Before inserting any new position, the engine queries `active_positions` for the current `(underlying, type)` pair. If the live count is `>= 3`, the insert is aborted. Uses plain `.select('id')` (not `{ head: true }`) to ensure non-null response data.

**DB-Level Strike Uniqueness (pre-insert)**: After the count check, the engine queries active positions for duplicate `buy_strike` (`buyConflict`) and `sell_strike` (`sellConflict`) values for the same `(underlying, type)`. If any conflict is found, the insert is aborted with a console warning.

**DB Unique Constraint Fallback**: A PostgreSQL unique constraint on `(buy_strike, sell_strike)` is the final safety net. Error code `23505` is caught and logged but does not crash the engine.

**Write Throttle (`lastDbWriteRef`)**: Tracks Unix timestamp of the last local database write. The Supabase Realtime subscription (and the 30-second fallback poll) skip the fetch if a local write occurred within the last **3 seconds** to prevent a just-written position from being overwritten by a stale re-fetch before the DB has finished committing. (Previously 10 seconds — reduced to minimize the staleness window.)

### Margin Calculation (`calcMargin`)

Applied to both engines using a fixed leverage of 200 and capping the short value at $200,000:

- **Leverage**: Fixed at **200×**
- **Short Value Cap**: Capped at **$200,000** (`Math.min(200000, shortValue)`)

`margin = (entryBuyPrice × buyLotSize) + (shortValue / leverage)`

---

## 7) Paper Trading Engine (`engine/paperTradingEngine.js`)

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
2. **Trailing Threshold Check**: Checkpoint values are recovered from `pos.buyLeg` metadata (or initialized from entry values on first evaluation). The trailing threshold is `checkpointAtmPnl * 0.25 + checkpointPnl`. The condition `currentGrossPnl <= threshold` must be met, meaning the position's PnL has deteriorated below the trailing stop level.
3. **Hypothetical Reduction & Recalculation**: The engine hypothetically reduces the current long lot size by `deltaBuyQty` (25% of original long quantity): `hypotheticalLotSize = currentLotSize - deltaBuyQty`. It then recalculates the position's lot ratio under this hypothetical reduction: `recalculatedRatio = pos.sellQty / hypotheticalLotSize`.
4. **ATM Ratio Comparison (1:x comparison)**: The live ATM ratio (`liveAtmRatio`, computed as `buyIntrinsic / sellIntrinsic` rounded to nearest `0.25`) is compared to the `recalculatedRatio`. The condition is: **`liveAtmRatio >= recalculatedRatio + 2`**. This means the market's ATM ratio must be at least `2` points higher than the recalculated position ratio before the exit is triggered.
5. **Floor Limit**: The hypothetical long lot size must be at or above the fixed floor limit of `0.5` (`hypotheticalLotSize >= 0.5`).
6. **Execution**: If all conditions are met (while loop):
   - Record a **partial exit** to `trade_history` with `is_partial: true`, the closed buy lot size as `deltaBuyQty`, and the closed sell lot size and sell quantity as `0`. The `exit_reason` is recorded in a concise format containing the exact initial and live ATM buy/sell prices, live and recalculated ratios, and realized vs remaining unrealized net PnL.
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

**Priority 4 — Rotation (Lost Top 3 Only):**

Evaluated only if no exit was triggered, the position's expiry matches `selExpiry`, and `uniqueTopSpreads` is non-empty.
- If the position is **not** in the Top 3 unique candidate buy strikes (`inTop3 === false`), it is a candidate for displacement.
- The engine finds a `bestTarget` in `uniqueTopSpreads` matching the same option type that passes all safety guards (strike conflicts, reservation, and 0.5% spot movement).
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
4. **Strike Diversification Guard (ATM Exit Trading)**: In the ATM Exit Trading engine, new buy strikes must be `>= 400 pts` from all existing buy strikes of the same type. (This guard has been removed from Paper Trading).
5. **Execution**: `entryBuyPrice = spread.ask`, `entrySellPrice = spread.bid`. Entry IVs captured: `entryBuyIv = ticker.askIv`, `entrySellIv = ticker.bidIv`. Baseline ATM ratio (`entryAtmRatio`) and unscaled lot size (`originalLotSize`) are computed and stored inside the `buy_leg` JSON metadata at entry.
6. **Supabase Insert (with three DB-level guards)**:
   - Count guard: `SELECT id WHERE underlying AND type` — abort if count `>= 3`.
   - Buy strike uniqueness: `SELECT id WHERE buy_strike = X` — abort if exists (`buyConflict`).
   - Sell strike uniqueness: `SELECT id WHERE sell_strike = Y` — abort if exists.
   - Unique constraint `23505` is the final net.

### G. State Update Strategy

- **Structural changes** (exits or entries): `setPositions(finalPositions)` — full array replacement.
- **PnL-only updates** (no exits or entries at minute boundary): `setPositions(prev => prev.map(p => byId.get(p.id) ?? p))` — in-place functional update to prevent table re-mount flash.

### H. Visual Simulation Mode (Extra Credit)

A UI-layer only feature — the Supabase database always stores original base values.

- **Toggle**: `extraCreditMode` boolean. `extraCreditAmount` is a dollar amount.
- **Simulated Sell Qty**: `extraLots = extraCreditAmount / entrySellPrice`, rounded to 0.25. Added to base sell qty.
- **Recalculated Metrics**: Unrealized PnL, Realized PnL, ratios, and KPIs all reflect the simulated qty in real-time across the entire dashboard.
- **CSV Export**: When simulation is active, exported CSV includes simulated values.

### I. KPIs & History

- **Today's Realized P&L**: Filters `tradeHistory` where `exitTime` (offset by +12h UTC) matches today's settlement-aligned date string. Invalid dates (`isNaN(d.getTime())`) are safely skipped.
- **Today's P&L**: `todayRealizedPnl + totalUnrealizedPnl`.
- **All-Time P&L**: `totalRealizedPnl + totalUnrealizedPnl`.
- **Win Rate**: Closed trades where net PnL > 0 / total trades.
- **Date Navigation**: Prev/Next/Today buttons adjust `historyFilterDate` (UTC-aligned ISO string). All-history mode clears the filter.
- **CSV Export**: Exports all visible history rows with entry/exit prices, IVs, fees, PnL, and exit reason.

---

## 8) ATM Exit Trading Engine (`engine/atmExitEngine.js`)

### Key Differences from PaperTrading

| Feature | PaperTrading | ATMExitTrading |
|---|---|---|
| Exit logic | Dynamic ATM ratio-based scaling (25% of original qty partial exits) + rotation | 100% at ATM only |
| Scanner source | Self-contained local scan (headless, no BroadcastChannel) | Fully self-contained local scan only |
| Start/Stop | Manual toggle | Always-on (auto-starts on product load) |
| Analytics | None | Bucketed `avg_pnl`, `avg_margin` per strike diff / sell qty range |
| Supabase tables | `active_positions`, `trade_history` | `atm_exit_*` prefix tables (isolated) |
| Leg swap | No | No |

### Evaluation Loop

Uses the identical decoupled execution strategy: checks ATM and rotation exits every second (`evaluateStrategy(true)`), while scanning and entering new positions at clock-minute boundaries (`evaluateStrategy(false)`). Tolerates up to 120 seconds of spot price staleness.

### Scanner (`scanTickers` internal)

Identical filtering algorithm to PaperTrading's `scanTickers`. Filters by ATM strike, enforces all thresholds, and sorts by ATM proximity. Config is stored in and loaded from `atm_exit_config` Supabase table.

### Exit Priority

1. **Expiry (2 min early)** — same as PaperTrading.
2. **ATM Exit**: `spotPrice >= buyStrike` (calls) or `spotPrice <= buyStrike` (puts) → 100% close. No stages.
3. **Rotation**: Same worst-first, 1-for-1 reservation system. Same 0.5% spot scaling and 400pt diversification guards. Capped at 3 rotations per cycle.

### Bucketed Analytics (`upsertAnalytics`)

After every trade exit, the engine upserts a running-average record:

1. **Table selection**: Based on `sellQty` range (0–2.5, 2.5–5, 5–7.5, 7.5–10).
2. **Strike diff rounding**: `Math.round(strikeDiff / 100) * 100` for clean bucketing.
3. **Running average formula**: If record `(strike_diff, underlying, type)` exists: `avgNew = (avgOld × (N-1) + valueCurrent) / N`. Otherwise inserts a new seed record.
4. **Tracked metrics**: `trade_count`, `avg_margin`, `avg_pnl` (net), `avg_net_premium`, `avg_fees`.

---

## 9) Robustness & Error-Handling Systems

### React Date Parsing Crash Guard

Both `PaperTrading.jsx` and `ATMExitTrading.jsx` guard all date filtering logic:

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

## 10) ATM Projections in ResultTable (`ResultTable.jsx`)

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
