# Low Level Design — OptionScope

This document captures implementation details for the current multi-module application.

---

## 1) Module Structure

### Core files

- `src/main.jsx`: App bootstrap and page routing between Charts, Ratio Spread Scanner, and Paper Trading modules.
- `src/App.jsx`: Main chart + watchlist module (combined premium, Greeks, chart tools, alerts).
- `src/RatioSpreadScanner.jsx`: Real-time scanner with configurable filters and call/put opportunity tables.
- `src/PaperTrading.jsx`: Auto-entry/exit simulator built on top of scanner-style candidate logic.
- `src/ResultTable.jsx`: Reusable table renderer for grouped scanner output.
- `src/scannerUtils.js`: Shared parsing and normalization helpers.
- `src/api.js`: REST/WS abstraction layer and symbol/candle utilities.

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
- **`active_positions`**: Real-time storage of open simulated trades.
- **`trade_history`**: Permanent record of realized trades with exit reasons.
- **Auto-Sync**: Config changes in one tab are broadcast via `BroadcastChannel` and persisted to Supabase, triggering updates in all other open instances.

### Cross-Tab Synchronization
- `useTabListener` hook handles message passing between modules.
- `CONFIG_SYNC`: Synchronizes filters, underlying, and expiry.
- `SCANNER_TOP_SPREADS_SYNC`: Shares real-time scanner analysis with the trading engine to minimize redundant calculations.

---

## 4) Ratio Spread Scanner Internals (`RatioSpreadScanner.jsx`)

### Market ingestion path

1. Load products by underlying and expiry.
2. Build symbol metadata: strike, option type, lot size.
3. Subscribe to all symbols through `createTickerStream`.
4. Buffer incoming ticker payloads (`tickerBufferRef`) and flush in 50ms batches.

### Candidate evaluation
- **Directional Filtering**: Universe split by option type and ATM-relative side to ensure liquidity and reduce delta risk:
  - Calls: strike >= ATM strike
  - Puts: strike <= ATM strike
- **Net Premium Band**: Enforces a symmetric band `[-maxNetPremium, +maxNetPremium]` allowing for both credit and debit spreads.
- **Min Long Distance**: Ensures the long leg is at least `minLongDist` away from the current spot price.
- Pair search is `O(N^2)` per side with constraints:
  - `minStrikeDiff`, `minIvDiff`, `minSellPremium`, `maxRatioDeviation`
- Core formulas:
  - `deltaNotional = abs(delta) * lotSize`
  - `premiumRatio = buyPremium / sellPremium`
  - `deltaNotionalRatio = buyDN / sellDN`
  - `ratioDeviation = abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio`
  - `sellQty` rounded to 0.25 steps, min 1
- **Sorting**: Prioritizes closeness to ATM, then by net premium ascending.

### Refresh behavior

- Adaptive refresh cadence:
  - Fast (2s) when early data arrives but no matches.
  - Normal (60s) once stabilized.
- Manual refresh button triggers immediate recompute.
- `lastRefreshed` and countdown are used for operator visibility.

### Strike Uniqueness (`pickTopUniqueStrikes`)
- Filters result sets to ensure:
  - Each **Buy Strike** appears only once.
  - Each **Sell Strike** appears only once.
- Prevents overlapping or highly correlated spreads from cluttering the view.
- Applies a "greedy" selection based on the best-sorted pairs (closest to ATM + highest edge).

### Result rendering

- Results are grouped by buy strike and expandable in `ResultTable`.
- Enforces unique sell strikes across different buy strike groups.

---

## 5) Paper Trading Internals (`PaperTrading.jsx`)

### Concurrency & Performance
- **`isEvaluatingRef`**: A mutex lock preventing multiple evaluation loops from running in parallel (e.g. triggered by rapid WebSocket updates).
- **Synchronous Tracking**: `positionsRef` is updated immediately within the evaluation loop to prevent race conditions during state transition.
- Uses 50ms ticker buffer flush for stable table updates.

### Entry Logic
- Merges local scan data with external scanner broadcasts.
- **Global Strike Uniqueness**: Prevents opening new positions if their buy or sell strike is already in use by any active position.
- Limits to top 3 unique candidates per option type (Call/Put).

### Rotation & Exit Logic
- **Automated Expiry Settlement**: Hard exit triggered when `Date.now()` exceeds the position's expiry time. Bypasses the threshold guard.
- **Directional Rotation**: Positions only exit if they lose their "Top 3" rank AND a "better" (closer-to-spot) buy strike becomes available.
- **Threshold Guard**: "Lost Top 3" (rotation) exits are gated by a requirement of 3 active calls and 3 active puts to maintain portfolio depth.
- **Scale-Out Exit Strategies (Bypass Guard)**:
  - `diff <= 1000`: Full exit at ATM.
  - `diff == 1200`: Partial (50%) at ATM, Final at 200 pts ITM.
  - `diff == 1400`: Partial (33.3%) at ATM, Partial (33.3%) at 150 pts ITM, Final at 300 pts ITM.
- Manual close action provided for immediate liquidity.

### Persistence & Sync
- **Background Persistence**: Every trade action (entry, exit, partial) is immediately synced to Supabase.
- **Stale Position Cleanup**: Automatically identifies and clears positions from previous expiries or underlyings.
- **Remote Sync**: Periodically fetches active positions from Supabase (every 30s) to reconcile state across different devices.

---

## 5) Performance and Reliability Patterns

- Heavy real-time structures are `useRef`-backed; React state is updated in controlled batches.
- WebSocket cleanup is handled on stop/unmount for all modules.
- Chart corrections combine WebSocket responsiveness with periodic REST truth reconciliation.
