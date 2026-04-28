# Low Level Design — OptionScope

This document outlines the technical implementation details of OptionScope.

---
The frontend is a single-page React application bundled with Vite.

### Core Files
- `src/main.jsx`: Entry point. React StrictMode is disabled to prevent double-mounting issues with WebSockets and chart instances.
- `src/App.jsx`: Main controller for the charting dashboard.
- `src/RatioSpreadScanner.jsx`: High-performance scanner engine for ratio spreads.
- `src/api.js`: Data abstraction layer for Delta Exchange REST and WebSocket protocols.

### Imperative Chart Rendering
We use `lightweight-charts` v5. To prevent React re-renders from destroying chart instances:
1. **Unconditional Mounting:** `ChartPanel` components are always in the DOM.
2. **Imperative Refs:** `App` uses `forwardRef` to call `setData()` and `update()` on charts directly.
3. **Overlay Strategy:** UI phases (`idle`, `loading`) are handled by an absolutely positioned overlay that blocks the charts without unmounting them.

---

## 2. Data Hub & WebSocket Logic

### The `dataHubRef` Pattern
To handle high-frequency data from multiple WebSocket channels (Ticker, Greeks, Trades, L2 Book) without triggering React renders, we use a `dataHubRef`:
- **Storage:** A plain Javascript object held in a `useRef`.
- **Channels:** Subscribes to `v2/ticker` (for prices and Greeks), `trades`, `l2_updates`, and `mark_price`.
- **Extraction:** Incoming messages update the `dataHubRef` silently. Only critical UI values (like sidebar prices and Greeks) are synced to React state via `useState`.

### WebSocket Subscriptions
- **Ticker:** Used for sub-second "Close" price updates and real-time Greek calculations.
- **Greeks:** Extracted from the `v2/ticker` payload (Delta, Gamma, Vega, Theta, Rho, IV).

---

## 3. Data Integrity Engine (Auto-Correction)

The system employs a multi-tiered approach to ensure chart accuracy:

### A. Live Candle Polling (`refreshCurrentCandle`)
A 5-second interval that fetches the "forming" candle from the REST API. This ensures that the Open, High, and Low of the current candle remain accurate even if the WebSocket feed is interrupted.

### B. Full History Refresh (`refreshAllHistory`)
Triggered by a wall-clock scheduler. When a candle closes:
1. The app calculates the exact time until the next boundary.
2. It waits for the boundary + a **15-second "Settle Delay"** (allowing Delta Exchange to finalize the historical record).
3. It performs a silent REST fetch for the last 300 candles and calls `setData(candles, false)`.
4. This replaces any transient WebSocket data with official exchange records without resetting the user's zoom or scroll position.

---

## 4. UI State & Smart Logic

- **ATM Auto-Selection:** When `underlying` or `selExpiry` changes, the app fetches the current spot price via `getSpotPrice` and uses `findATM` to select the closest strike automatically.
- **Price Type Toggle:** Supports switching between `mark` and `ltp` modes. This changes the REST symbol prefix (e.g., `MARK:C-BTC...`) and the WebSocket price field extraction.
- **Combined Premium Logic**: `sumCandles` handles the alignment of Call and Put candle arrays, ensuring the Combined Premium chart remains perfectly synced even if one leg has missing data points.

---

## 5. Ratio Spread Scanner Architecture

The scanner is built to handle the "Data Flood" associated with long-dated expiries (150+ strikes).

### A. Throttled Calculation Loop
To prevent the UI thread from locking during an $O(N^2)$ scan:
- **Ref-based Storage**: Incoming WebSocket messages are stored in `tickerDataRef` to bypass React's reconciliation for every individual price update.
- **Deterministic Interval**: The scan logic runs exactly **once per second** on a timer, regardless of message frequency.

### B. Delta-Notional Alignment
Unlike basic scanners, OptionScope uses **Lot-Size Aware** logic:
- **Delta Notional** = $|Delta| \times ContractSize$.
- **Hedge Ratio** = $BuyDeltaNotional / SellDeltaNotional$.
- This ensures the scanner is accurate for underlying assets with different quoting precision (e.g., BTC vs ETH).

### C. Scoring Formula
The proprietary **Score** ranks opportunities by:
1. **Mathematical Edge**: Lower deviation between Premium Ratio and Delta-Notional Ratio.
2. **Volatility Edge**: Larger IV spread between legs.
3. **Skew Capture**: Bonus for wider strike differentials.
