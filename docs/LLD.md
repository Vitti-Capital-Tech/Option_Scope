# Low Level Design — OptionScope

This document captures implementation details for the current multi-module application.

---

## 1) Module Structure

### Core files

- `src/main.jsx`: App bootstrap and page routing between Charts, Ratio Spread Scanner, and Paper Trading modules.
- `src/App.jsx`: Main chart + watchlist module (combined premium, Greeks, chart tools, alerts).
- `src/RatioSpreadScanner.jsx`: Real-time scanner with configurable filters and call/put opportunity tables.
- `src/PaperTrading.jsx`: Auto-entry/exit/rotation simulator built on top of scanner-style candidate logic.
- `src/ResultTable.jsx`: Reusable table renderer for grouped scanner output.
- `src/scannerUtils.js`: Shared parsing and normalization helpers (`normalizeIv`, `toFiniteNumber`, `matchesOptionType`, `formatTime`, `formatDateTime`).
- `src/api.js`: REST/WS abstraction layer and symbol/candle utilities.
- `src/supabase.js`: Supabase client singleton.
- `src/useTabSync.js`: `BroadcastChannel`-based cross-tab messaging hook.

---

## 2) Chart Module Internals (`App.jsx`)

### Chart lifecycle

- `ChartPanel` is always mounted and exposes imperative APIs through `forwardRef` + `useImperativeHandle`.
- Main APIs: `setData`, `update`, `clearData`, `clearIvData`.
- Avoids chart teardown/recreate cycles when config changes.

### Chart tools

- SMA(20) overlay computed from candle cache.
- Draw mode for support/resistance price lines with undo/clear actions.
- Utility controls: scroll left/right, zoom in/out, auto-fit, jump to current.
- Combined alert line visualized as dynamic `createPriceLine`.

### Data integrity engine

- `refreshCurrentCandle()` every 5s uses REST to correct live bucket O/H/L.
- `scheduleCandleCorrections()` computes boundary timing from timeframe seconds and runs full correction with 15s settle delay.
- `refreshAllHistory()` backfills last `CANDLE_COUNT` buckets and re-syncs close-based alert evaluation on officially closed candles.

### Data Hub

- `dataHubRef` stores per-leg channels:
  - `ticker`
  - `greeks`
  - `trades` (last 200)
  - `orderbook` (`l2_updates`)
  - `markPrice`
- UI state only mirrors values required for rendering (prices, Greeks, status) to minimize render pressure.

### Watchlist

- Strategies are stored with type (`combined`/`call`/`put`), symbols, strikes, alert config.
- Separate WS stream updates watchlist prices/high/low in near real-time.
- Alerts trigger toast + optional browser notification + sound with de-dup via `triggeredAlerts`.

---

## 3) Persistence & Synchronization Logic

### Supabase Integration
- **`paper_trading_config`**: Stores global algorithmic settings (underlying, expiry, thresholds).
- **`active_positions`**: Real-time storage of open simulated trades. Includes `buy_strike` and `sell_strike` as indexed columns for fast duplicate detection.
- **`trade_history`**: Permanent record of realized trades with entry/exit prices, spot prices, PnL, fees, and exit reason.
- **Auto-Sync**: Config changes in one tab are broadcast via `BroadcastChannel` and persisted to Supabase, triggering updates in all other open instances.

### Cross-Tab Synchronization
- `useTabListener` hook handles message passing between modules.
- `CONFIG_SYNC`: Propagates filter, underlying, and expiry changes from Paper Trading to the Scanner.
- `SCANNER_TOP_SPREADS_SYNC`: Scanner broadcasts its current top-3 calls and puts to the Paper Trading engine to avoid redundant computation.

### Supabase Write Throttle
- `lastDbWriteRef` tracks the timestamp of the last local write.
- The periodic Supabase sync (`fetchSupabaseActivePositions`) is skipped if a local write occurred within the last 10 seconds to prevent overwriting in-flight changes.

---

## 4) Ratio Spread Scanner Internals (`RatioSpreadScanner.jsx`)

### Market ingestion path

1. Load products by underlying and expiry.
2. Build symbol metadata: strike, option type, lot size.
3. Subscribe to all symbols through `createTickerStream`.
4. Buffer incoming ticker payloads (`tickerBufferRef`) and flush in 50ms batches.

### Candidate evaluation
- **Directional Filtering**: Universe split by option type and ATM-relative side:
  - Calls: strike >= ATM strike
  - Puts: strike <= ATM strike
- **Net Premium Band**: Enforces a symmetric band `[-maxNetPremium, +maxNetPremium]` allowing both credit and debit spreads.
- **Min Long Distance**: Ensures the long leg is at least `minLongDist` away from the current spot price.
- Pair search is `O(N²)` per side with constraints:
  - `minStrikeDiff`, `minIvDiff`, `minSellPremium`, `maxRatioDeviation`
- Core formulas:
  - `deltaNotional = abs(delta) * lotSize`
  - `premiumRatio = buyPremium / sellPremium`
  - `deltaNotionalRatio = buyDN / sellDN`
  - `ratioDeviation = abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio`
  - `sellQty` rounded to 0.25 steps, min 1
- **Sorting**: Prioritizes closeness to ATM (ascending distance), then by net premium ascending.

### Refresh behavior

- Adaptive refresh cadence:
  - Fast-track (2s after data arrives) when no results exist yet.
  - Normal (aligned to next clock minute boundary) once stable results are present.
- Manual refresh button triggers immediate recompute.
- `lastRefreshed` and countdown are shown for operator visibility.

### Strike Uniqueness (`pickTopUniqueStrikes`)
- Filters result sets to ensure:
  - Each **Buy Strike** appears only once across selected spreads.
  - Each **Sell Strike** appears only once across selected spreads.
- Prevents overlapping or correlated spreads.
- Applies greedy selection over the sorted pair list (closest to ATM first).

### Result rendering

- Results are grouped by buy strike and rendered in `ResultTable`.
- Top 3 per side are published via `BroadcastChannel` to Paper Trading on every refresh.

---

## 5) Paper Trading Internals (`PaperTrading.jsx`)

### Concurrency & Performance
- **`isEvaluatingRef`**: Mutex lock preventing parallel evaluation cycles from racing (triggered by rapid WebSocket or scanner sync events).
- **`positionsRef`**: Always-current ref clone of `positions` state, read directly by the evaluation loop to avoid stale closure captures.
- **Evaluation cadence**: Full strategy evaluation runs once per clock minute or when a new scanner broadcast arrives. PnL-only updates run every 5 seconds in between.

### Ticker Subscription
- Subscribes to all option symbols for the active expiry plus any symbols used by existing positions (to track PnL across expiry rollovers).
- Buffered 50ms flush reduces render pressure under bursty market data.

### Entry Logic

1. Merge local scan candidates with external scanner top-spreads broadcast.
2. Deduplicate: no new position is opened if its buy strike or sell strike is already active for the same type and underlying.
3. Enforce a cap of 3 active positions per option type (calls, puts).
4. Before inserting into Supabase, run a DB-level duplicate check by `buy_strike` + `sell_strike` + `underlying`. Database unique constraint (`23505`) is a final safety net.

### Rotation & Exit Logic

The evaluation loop processes each active position through a priority-ordered exit decision tree:

#### Priority 1 — Expiry Settlement (Hard Exit, always runs)
- If `Date.now() >= expiryTs - 2min`, the position is exited **2 minutes before** the actual expiry timestamp.
- Early exit captures stable mark prices before the settlement spike/crash window at exact expiry.
- **Bypasses all guards.**
- `exitReason = 'Expiry Reached (2min Early)'`

#### Priority 2 — ATM/ITM Scale-Out (based on `strikeDiff`, always runs if no expiry exit)
Evaluated only if `shouldExit` is still `false` after the expiry check.

| `strikeDiff` | Stage | Trigger | Action |
|---|---|---|---|
| `<= 1000` | Full | ATM reached (`spotPrice >= buyStrike` for calls, `<= buyStrike` for puts) | 100% exit |
| `<= 1200` | Stage 1 | ATM reached (`stagesExited == 0`) | Partial 50% exit |
| `<= 1200` | Stage 2 | 200 pts ITM (`stagesExited == 1`) | Final 50% exit |
| `<= 1400` | Stage 1 | ATM reached (`stagesExited == 0`) | Partial 33.3% exit |
| `<= 1400` | Stage 2 | 150 pts ITM (`stagesExited == 1`) | Partial 33.3% exit (50% of remainder) |
| `<= 1400` | Stage 3 | 300 pts ITM (`stagesExited == 2`) | Final 33.4% exit |

- All ATM/ITM exits **bypass the threshold guard.**

#### Priority 3 — Rotation (Gated)
- Evaluated only if `shouldExit` is still `false` and the position's expiry matches the active `selExpiry`.
- A position is a rotation candidate when:
  1. Its buy strike is **not** in the current top-3 ranked spreads for its type.
  2. At least one top-ranked spread has a buy strike **not** already held by an active position.
  3. The top-ranked spread's buy strike is directionally **better** than the current position:
     - **Put**: `top1Strike > currentStrike` (higher put buy strike is closer to ATM)
     - **Call**: `top1Strike < currentStrike` (lower call buy strike is closer to ATM)
- `exitReason = 'Lost Top 3 and Rank 1 is better than (X)'`

### Threshold Guard (Rotation-only)

Rotation exits are gated by a minimum portfolio depth requirement to prevent the algorithm from prematurely dropping positions while building up the book.

```
activeCallsCount = count of call positions for current underlying
activePutsCount  = count of put positions for current underlying

currentCanExitCalls = (activeCallsCount >= 3)
currentCanExitPuts  = (activePutsCount >= 3)
```

- Only ONE rotation is allowed per option type per scan cycle. After a rotation is approved, the guard flag (`currentCanExitCalls` or `currentCanExitPuts`) is set to `false` to block any further rotations in the same loop iteration.
- **Critical fix**: The `rotationApproved` boolean is captured **before** the guard flag is locked, and used by the Final Guard. This prevents the guard from self-blocking the very rotation it just approved.
- ATM/ITM and Expiry exits are **never** affected by this guard.

### Partial Exit Mechanics
- `exitFraction` controls what portion of the position is closed (e.g. `0.5` for 50%).
- The remaining portion has its `sellQty`, `buyLeg.lotSize`, `margin`, and `entryFee` scaled by `(1 - exitFraction)`.
- `stagesExited` is incremented by 1 on each partial and synced to Supabase.
- A trade history record is written for the exited fraction.

### Persistence & Sync
- Every trade action (entry, partial exit, full exit) is immediately written to Supabase.
- Full exits: position is deleted from `active_positions`, inserted into `trade_history`. Duplicate history entries are guarded with a pre-check by `trade_id`.
- Partial exits: position is updated in-place in `active_positions` with the new `sell_qty`, `buy_leg`, `margin`, `entry_fee`, and `stages_exited`.
- Periodic sync (`fetchSupabaseActivePositions`) runs every 10 seconds but is skipped if a local write occurred within the last 10 seconds to prevent stale overwrites.
- Spot price backfill: if a loaded active position is missing `entry_spot_price`, a historical candle lookup is triggered 2 seconds after load.

---

## 6) Performance and Reliability Patterns

- Heavy real-time structures are `useRef`-backed; React state is updated in controlled batches.
- `isEvaluatingRef` mutex prevents evaluation re-entrancy under burst conditions.
- WebSocket cleanup is handled on stop/unmount for all modules.
- Chart corrections combine WebSocket responsiveness with periodic REST truth reconciliation.
- Supabase write throttling prevents DB conflicts between concurrent instances on different devices.
