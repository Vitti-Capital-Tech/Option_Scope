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

## 3) Ratio Spread Scanner Internals (`RatioSpreadScanner.jsx`)

### Market ingestion path

1. Load products by underlying and expiry.
2. Build symbol metadata: strike, option type, lot size.
3. Subscribe to all symbols through `createTickerStream`.
4. Buffer incoming ticker payloads (`tickerBufferRef`) and flush in 50ms batches.

### Candidate evaluation

- Universe split by option type and ATM-relative side:
  - Calls: strike >= ATM
  - Puts: strike <= ATM
- Pair search is `O(N^2)` per side with constraints:
  - `minStrikeDiff`
  - `minIvDiff`
  - `minSellPremium`
  - `maxRatioDeviation`
- Core formulas:
  - `deltaNotional = abs(delta) * lotSize`
  - `premiumRatio = buyPremium / sellPremium`
  - `deltaNotionalRatio = buyDN / sellDN`
  - `ratioDeviation = abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio`
  - `sellQty` rounded to 0.25 steps, min 1

### Refresh behavior

- Adaptive refresh cadence:
  - Fast (2s) when early data arrives but no matches.
  - Normal (60s) once stabilized.
- Manual refresh button triggers immediate recompute.
- `lastRefreshed` and countdown are used for operator visibility.

### Result rendering

- Results are grouped by buy strike and expandable in `ResultTable`.
- Displays strike pair, premiums, IV diff, delta pair, sell quantity, net premium, and net delta difference.

---

## 4) Paper Trading Internals (`PaperTrading.jsx`)

### Live feed and preprocessing

- Shares product/expiry/ticker flow with scanner.
- Uses 200ms ticker buffer flush for stable table updates.
- Waits for minimum feed coverage (`>10%` of expected tickers) before evaluating candidates.

### Entry logic

- Builds call and put candidate sets using the same constraints as scanner.
- Picks top 3 per side and opens simulated positions not already active.
- Position payload includes entry prices, sell quantity, margin estimate, and type.

### Exit logic

- Auto-exit when spread loses top-3 ranking.
- Additional strike-diff dependent exit rules:
  - `< 1000`: exit when buy strike reaches ATM/ITM.
  - `< 1200`: exit at 200 points ITM.
  - `< 1400`: exit at 300 points ITM.
- Supports manual close action at any time.

### PnL and reporting

- Unrealized/realized PnL uses lot-size-aware leg calculations.
- Closed trades recorded in history with reason and timestamps.
- CSV export includes entry/exit net premium, realized PnL, and margin.

---

## 5) Performance and Reliability Patterns

- Heavy real-time structures are `useRef`-backed; React state is updated in controlled batches.
- WebSocket cleanup is handled on stop/unmount for all modules.
- Chart corrections combine WebSocket responsiveness with periodic REST truth reconciliation.
