# High Level Design — OptionScope

## What The System Does

OptionScope is a client-side trading workstation for Delta Exchange options. It has three top-level modules:

- **Charts**: Real-time call/put/combined premium monitoring with Greeks and alerts.
- **Ratio Spread Scanner**: Live discovery of ratio spreads based on premium-to-delta-notional alignment.
- **Paper Trading**: Automated simulation of spread entries/exits with live PnL and trade history.

The user selects underlying and expiry, then the system streams option telemetry and updates UI decisions in near real-time.

---

## System Components

```
Browser (React + Vite)
  |
  |-- Navigation Shell (Charts / Scanner / Paper Trading)
  |
  |-- REST adapter (products, candles, spot) ---> /api proxy ---> Delta REST
  |
  |-- WebSocket adapter (ticker, greeks, trades, l2, mark_price) ---> Delta WS
         |
         |-- Chart Data Hub + Correction Engine
         |-- Scanner Engine (filtered pair search)
         |-- Paper Trading Engine (entry/exit/PnL lifecycle)
```

### 1) UI Layer

- React components are route-like modules switched inside the app shell.
- Theme toggle is shared across modules.
- Strategy watchlist and configuration state drive the active chart context.

### 2) Market Data Layer

- **REST** handles product metadata, initial candle history, and correction backfills.
- **WebSocket** handles low-latency live fields (`v2/ticker`, `mark_price`, trades, order book updates).
- Proxy rewrites keep the architecture serverless while handling CORS.

### 3) Runtime Engines

- **Charting Engine** uses imperative refs and always-mounted chart components for smooth updates.
- **Scanner Engine** processes option chains for valid ratio candidates using configurable thresholds.
- **Paper Engine** reuses scanner-style candidate selection to simulate positions, exits, and realized outcomes.

---

## End-to-End Data Flow

### Initialization

1. Load product universe for the selected underlying.
2. Derive expiries and strikes; auto-select ATM where applicable.
3. Pull spot price and start periodic spot refresh.

### Live Monitoring (Charts)

1. Bootstrap candles from REST.
2. Start WebSocket streams for selected symbols.
3. Update latest candles and Greeks continuously.
4. Every 5 seconds, refresh forming candle from REST.
5. At each candle boundary (+ settle delay), refresh full history for official close integrity.

### Live Scanning / Trading

1. Subscribe to all option symbols in the selected expiry.
2. Buffer and batch ticker updates to limit render pressure.
3. Evaluate pair candidates using strike/IV/premium/deviation constraints.
4. Publish scanner tables or simulated trading actions based on top-ranked pairs.

---

## Technology Choices

| Component | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Fast iteration, modular stateful UI |
| Charting | `lightweight-charts` | High-performance OHLC rendering |
| Streaming | Native WebSocket | Low-latency market updates |
| Data buffering | `useRef` + batched flush | Controls re-render frequency under bursty data |
| Styling | CSS | Fine-grained control of trading terminal aesthetics |
