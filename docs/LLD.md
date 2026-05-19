# Low Level Design — OptionScope

This document is the authoritative implementation reference for every module, engine, data pipeline, and safety guard in OptionScope.

---

## 1) Project Structure & Codebase Map

| File | Responsibility |
|---|---|
| `main.jsx` | Root bootstrap and routing shell. Mounts all 4 modules simultaneously using `display: none/block` to preserve state across navigation. Owns the shared `page` and `theme` state and the `BroadcastChannel` sync instance. |
| `App.jsx` | Interactive charts, greeks tracking, alert manager, SMA overlay, and support/resistance drawing tools. |
| `RatioSpreadScanner.jsx` | Standalone option-chain scanner. Computes premium-to-delta-notional ratio deviation pairs, publishes top-3 results via `BroadcastChannel` and `localStorage`. |
| `PaperTrading.jsx` | Full automated simulation engine. Handles entries, multi-stage exits, leg-swaps, rotation, IV tracking, fee calculations, Supabase persistence, and UI. |
| `ATMExitTrading.jsx` | Simplified always-on trading engine. Self-contained scanner, single ATM exit rule, bucketed analytics aggregation, and separate Supabase tables. |
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

### Spot Price Polling

All four modules poll `getSpotPrice(underlying)` every **10 seconds** via `setInterval` to keep the spot display and safety guard calculations current.

---

## 3) Directional Implied Volatility (IV) Pipeline

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
| `maxNetPremium` | 20 | Symmetric net premium band: `[-max, +max]` allows credit and debit spreads |
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
   - `netPremium` within `[-maxNetPremium, +maxNetPremium]`
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
| `active_positions` | PaperTrading | `id`, `buy_strike`, `sell_strike`, `buy_leg` (JSON), `sell_leg` (JSON), `stages_exited`, `accumulated_sell_pnl`, `margin` | Unique DB constraint on `(buy_strike, sell_strike)` prevents duplicate inserts |
| `trade_history` | PaperTrading | `trade_id`, `realized_net_pnl`, `exit_reason`, `is_partial`, `exit_time`, `total_fees` | `trade_id` pre-checked before insert to prevent duplicates on partial exits |
| `atm_exit_config` | ATMExitTrading | `underlying`, `expiry`, `min_long_dist`, `min_sell_premium`, `max_ratio_deviation` | Isolated from PaperTrading config |
| `atm_exit_active_positions` | ATMExitTrading | `id`, `buy_strike`, `sell_strike`, `sell_qty`, `accumulated_sell_pnl`, `margin` | Separate runtime state for ATM Exit engine |
| `atm_exit_trade_history` | ATMExitTrading | `trade_id`, `realized_net_pnl`, `exit_reason`, `exit_time`, `exit_spot_price` | Permanent historical record |
| `atm_exit_qty_0_2_5` | ATMExitTrading | `strike_diff`, `underlying`, `type`, `trade_count`, `avg_margin`, `avg_pnl`, `avg_net_premium`, `avg_fees` | Bucket for sellQty <= 2.5 |
| `atm_exit_qty_2_5_5` | ATMExitTrading | same | Bucket for sellQty <= 5.0 |
| `atm_exit_qty_5_7_5` | ATMExitTrading | same | Bucket for sellQty <= 7.5 |
| `atm_exit_qty_7_5_10` | ATMExitTrading | same | Bucket for sellQty > 7.5 |

### Concurrency Safety Guards

**DB-Level Count Guard (pre-insert)**: Before inserting any new position, the engine queries `active_positions` for the current `(underlying, type)` pair. If the live count is `>= 3`, the insert is aborted. Uses plain `.select('id')` (not `{ head: true }`) to ensure non-null response data.

**DB-Level Strike Uniqueness (pre-insert)**: After the count check, the engine also queries for any existing position with the same `buy_strike` or `sell_strike` within the same `(underlying, type)`. Duplicate strikes are blocked.

**DB Unique Constraint Fallback**: A PostgreSQL unique constraint on `(buy_strike, sell_strike)` is the final safety net. Error code `23505` is caught and logged but does not crash the engine.

**Write Throttle (`lastDbWriteRef`)**: Tracks Unix timestamp of the last local database write. The periodic background sync (`fetchSupabaseActivePositions`, runs every 10 seconds) is skipped if a local write occurred within the last 10 seconds to prevent stale remote data overwriting in-flight local changes.

### Margin Calculation (`calcMargin`)

Applied to both engines using a tiered leverage model based on short notional value:

| Short Notional (`spot × sellQty × sellLot`) | Leverage |
|---|---|
| <= $200,000 | 200× |
| <= $450,000 | 100× |
| <= $950,000 | 50× |
| > $950,000 | 25× |

`margin = (entryBuyPrice × buyLotSize) + (shortValue / leverage)`

---

## 7) Paper Trading Engine (`PaperTrading.jsx`)

### Dual-Phase Evaluation Loop (`evaluateStrategy`)

Called every second by a `setInterval`. Uses the `isEvaluatingRef` mutex to prevent re-entrant calls.

**Phase 1 — Real-Time PnL (every 1 second):**

Triggered when the current time has not crossed a new clock-minute boundary and no scanner update is pending.

- Reads `latestTickerDataRef.current` directly (no React state read — avoids stale closures).
- For each position: reads `ticker.bid` (long leg exit price) and `ticker.ask` (short leg exit price).
- Computes: `grossPnl = (buyPnl × buyLotSize) − (sellPnl × sellQty × sellLotSize) + accumulatedSellPnl`
- Fee formula: `feePerUnit = min(0.035 × price, 0.0001 × spot)`, then `× qty × lotSize`.
- Updates current IVs: buy leg uses `ticker.bidIv`, sell leg uses `ticker.askIv`.
- Uses `setPositions(prev => prev.map(...))` — functional update avoids full array replacement to prevent table flash.

**Phase 2 — Strategy Evaluation (every clock-minute or on scanner sync):**

Triggered when `currentMinute > lastMinute` OR `scannerSyncVersion > lastProcessedScannerVersionRef.current` OR `force = true`.

Steps: A → B → C → D → E → F (detailed in sections below).

### A. Candidate Pool Construction

1. **Local Scan**: Filters `latestTickerDataRef` by option type and ATM direction. Runs `scanTickers` (same algorithm as `RatioSpreadScanner`) on calls and puts separately.
2. **Scanner Merge**: If the Scanner's `BroadcastChannel` snapshot (`scannerTopRef.current`) matches the current `underlying` and `expiry`, the engine merges its IDs with the local results. Scanner results take priority; local results backfill any gaps up to 6 total.
3. **Unique Ranking List (`uniqueTopSpreads`)**: A deduplicated view (one entry per buy strike, max 10 per type) used exclusively for ranking and rotation decisions.

### B. Sorted Position Processing (Worst-First)

All active positions are sorted by descending `|buyStrike - spotPrice|` (farthest OTM first). This ensures the weakest positions are evaluated for exits before the stronger ones.

### C. Exit Priority Tree

Each position is evaluated in strict priority order:

**Priority 1 — Data Gap Guard:**
- If `latestTickerDataRef` has no `bid` or `ask` for a position's legs, the position is skipped (kept in `remaining`) rather than exited with stale data.

**Priority 2 — Expiry Settlement (Hard Exit):**
- Condition: `Date.now() >= expiryTs - 120,000ms` (2 minutes before expiry).
- Action: 100% exit, `exitReason = 'Expiry Reached (2min Early)'`.
- **Zombie guard**: If the position is more than 10 minutes past expiry, its `exit_time` is back-dated to the exact expiry timestamp for accurate reporting.
- **Bypasses all other guards.**

**Priority 3 — ATM/ITM Scale-Out:**

Evaluated only if no expiry exit was triggered.

| `strikeDiff` | Stage | Trigger | Action | exitFraction |
|---|---|---|---|---|
| `<= 1000` | Full | Spot crosses buy strike | 100% exit | 1.0 |
| `<= 1200` | Stage 1 | Spot crosses buy strike (`stagesExited == 0`) | 50% partial | 0.5 |
| `<= 1200` | Stage 2 | 200 pts ITM (`stagesExited == 1`) | 100% final | 1.0 |
| `> 1200` | Stage 1 | Spot crosses buy strike (`stagesExited == 0`) | 33% partial | 0.33 |
| `> 1200` | Stage 2 | 150 pts ITM (`stagesExited == 1`) | 50% of remainder | 0.5 |
| `> 1200` | Stage 3 | 300 pts ITM (`stagesExited == 2`) | 100% final | 1.0 |

For calls: `itmDist = spot - buyStrike`. For puts: `itmDist = buyStrike - spot`.

**Priority 4 — Rotation (Displacement):**

Evaluated only if no exit was triggered, the position's expiry matches `selExpiry`, and `uniqueTopSpreads` is non-empty.

- If the position's buy strike is **not** in `uniqueTopSpreads`, it is a displacement candidate.
- The engine finds a `bestTarget` in `uniqueTopSpreads` matching the same option type that:
  1. Has no buy/sell strike collision with other active positions.
  2. Has not been reserved by a prior displacement this cycle (`reservedTargets` Set).
  3. Is **>= 400 points** away from the current position's buy strike.
  4. The current spot has moved **>= 0.5%** from the current position's `entrySpotPrice` (directionally: lower for calls, higher for puts).
  5. Passes both guards (step 3 & 4) against **all other** remaining positions too.
- If target is directionally closer to ATM, the exit is approved and the target strike is added to `reservedTargets` (1-for-1 reservation).

**Threshold Guard (Rotation Only):**

Rotations are additionally gated by the portfolio depth requirement:

- Calls can only rotate if `activeCallsCount >= 3`.
- Puts can only rotate if `activePutsCount >= 3`.
- Maximum `MAX_ROTATIONS_PER_CYCLE = 3` total rotations per evaluation cycle.

### D. Leg-Swap Optimization

If a rotation target shares the exact same **sell strike** as the current position, a Leg Swap is executed instead of a full spread exit:

1. Realizes P&L only on the Long leg (closed at current bid).
2. Adjusts sell quantity using `deltaQty = targetSellQty - currentSellQty`.
3. Recalculates `entrySellPrice` as a weighted average: `(oldQty × oldPrice + deltaQty × currentPrice) / newQty`.
4. Fees from the long exit and short adjustment are consolidated into `accumulatedSellPnl` and `entryFee` of the surviving position.
5. The mutated position is written back to Supabase via an `UPDATE` (not a delete/insert cycle).

### E. Partial Exit Mechanics

When `isPartial = true`:

- **Trade record**: `id = ${pos.id}-P${stagesExited+1}`, `sellQty = originalSellQty × exitFraction`, `buyLeg.lotSize = originalLotSize × exitFraction`.
- **Remaining position**: `sellQty`, `buyLeg.lotSize`, `margin`, `entryFee`, `accumulatedSellPnl` all scaled by `(1 - exitFraction)`. `stagesExited` incremented.
- The partial record is written to `trade_history` with `is_partial = true`.
- The remaining position is updated in-place in `active_positions` via Supabase `UPDATE`.
- A partial exit does **not** free a portfolio slot.

### F. Entry Logic

New entries are opened from `topSpreads` (full candidate pool, not uniqueTopSpreads) after the exit pass:

1. **Expiry Buffer Guard**: Skip if `minutesToExpiry < 5`.
2. **Strike Uniqueness**: Block if buy or sell strike already active in `remaining` or `newEntries` (same type/underlying).
3. **Portfolio Cap**: Block if `remaining + newEntries count >= 3` for this type.
4. **Strike Diversification Guard**: New buy strike must be `>= 400 pts` from all existing buy strikes of the same type.
5. **Execution**: `entryBuyPrice = spread.ask`, `entrySellPrice = spread.bid`. Entry IVs captured: `entryBuyIv = ticker.askIv`, `entrySellIv = ticker.bidIv`.
6. **Supabase Insert (with three DB-level guards)**:
   - Count guard: `SELECT id WHERE underlying AND type` — abort if count `>= 3`.
   - Buy strike uniqueness: `SELECT id WHERE buy_strike = X` — abort if exists.
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

## 8) ATM Exit Trading Engine (`ATMExitTrading.jsx`)

### Key Differences from PaperTrading

| Feature | PaperTrading | ATMExitTrading |
|---|---|---|
| Exit logic | Multi-stage partials (33%/50%) + rotation | 100% at ATM only |
| Scanner source | Merges local scan + BroadcastChannel | Fully self-contained local scan only |
| Start/Stop | Manual toggle | Always-on (auto-starts on product load) |
| Analytics | None | Bucketed `avg_pnl`, `avg_margin` per strike diff / sell qty range |
| Supabase tables | `active_positions`, `trade_history` | `atm_exit_*` prefix tables (isolated) |
| Leg swap | Yes | No |

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

---

## 10) ATM Projections in ResultTable (`ResultTable.jsx`)

To visualize potential outcomes, the Result Table projects the value of each scanned spread to the At-The-Money (ATM) boundary. This uses direct, live option chain lookups via `tickerData` instead of Greeks (Delta/Gamma) or theoretical calculations:

### 1. True ATM Strike Sourcing
The true market ATM strike is calculated globally in the scanner component (by inspecting the entire unfiltered options chain) and passed as `trueAtmStrike` to `ResultTable.jsx`. This ensures that aggressive filtering in the scanner does not lead to a wrong ATM strike calculation.

### 2. At ATM Ask/Bid Option Chain Shifting & Ratio
- **Long Leg (ATM)**: Option valued at the current Bid price of the option at `atmStrike`.
- **Short Leg (OTM)**: Option valued at the current Ask price of the option at strike `atmStrike + strikeDiff` (for Calls) or `atmStrike - strikeDiff` (for Puts).
- **At ATM Ratio**: Displayed directly below the Bid/Ask prices inside the same cell as `1 : X`, where `X` is the premium ratio rounded to the nearest 0.25: `Math.max(1, Math.round((ATM_Bid / OTM_Ask) / 0.25) * 0.25)`.

### 3. At ATM P&L & ROI %
- **At ATM P&L**: Calculates the net liquidation P&L if the underlying moves to the ATM strike:
  `P&L = [(ATM_Bid - entryBuyPrice) - (OTM_Ask - entrySellPrice) * sellQty] * lotSize`
- **ROI %**: Calculated as `(At ATM P&L / Margin) * 100` and displayed directly below the dollar P&L value in the same cell.

### 4. At ATM Margin
- **Margin Calculation**: Derived using the same leverage-tier model as Paper Trading:
  `shortValue = spot * sellQty * sellLotSize`
  `leverage = shortValue <= 200,000 ? 200 : shortValue <= 450,000 ? 100 : shortValue <= 950,000 ? 50 : 25`
  `margin = (buyPrice * buyLotSize) + (shortValue / leverage)`
- **Sorting**: The scanner table groups the spreads by buy strike, sorts the group strikes by their highest candidate ROI descending, and sorts all options/sub-rows within each group by ROI descending. This ensures the most margin-efficient opportunities are ranked at the top.

### Margin Backfill on Load

On first spot price arrival, `backfillMargins` queries all `active_positions` from Supabase and recalculates each position's margin using the latest spot price and the current leverage tier. This corrects any stale margin values persisted from a prior session.
