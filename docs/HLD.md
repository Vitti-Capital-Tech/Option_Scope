# High Level Design — OptionScope

## What The System Does

OptionScope is a client-side trading workstation for Delta Exchange options. It has three top-level modules:

- **Charts**: Real-time call/put/combined premium monitoring with Greeks and alerts.
- **Ratio Spread Scanner**: Live discovery of ratio spreads based on premium-to-delta-notional alignment.
- **Paper Trading**: Fully automated simulation of spread entry, live PnL, multi-stage scale-out exits, rotation, and expiry settlement.

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
  |-- Persistence & Sync Hub (localStorage + BroadcastChannel + Supabase)
         |
         |-- Chart Data Hub + Correction Engine
         |-- Scanner Engine (directional pair search with ATM constraints)
         |-- Paper Trading Engine (rotation + multi-stage exit + expiry settlement lifecycle)
```

### 1) UI Layer

- React components are route-like modules switched inside the app shell.
- Theme toggle is shared across modules.
- Strategy watchlist and configuration state drive the active chart context.
- **Synchronization**: State (underlying, expiry, filters) is synchronized across tabs via `BroadcastChannel` and persisted to Supabase for cross-device consistency.

### 2) Market Data & Persistence Layer

- **REST** handles product metadata, initial candle history, and correction backfills.
- **WebSocket** handles low-latency live fields (`v2/ticker`, `mark_price`, trades, order book updates).
- **Supabase** (PostgreSQL) stores algorithm configuration, active trading positions, and realized trade history.
- Proxy rewrites keep the architecture serverless while handling CORS.

### 3) Runtime Engines

- **Charting Engine** uses imperative refs and always-mounted chart components for smooth updates.
- **Scanner Engine** processes option chains for valid ratio candidates using configurable thresholds. Enforces directional filtering (Calls ≥ ATM, Puts ≤ ATM) and global uniqueness of buy/sell strikes per type.
- **Paper Engine** reuses scanner-style candidate selection to simulate positions with a full exit lifecycle: rotation toward better strikes, multi-stage ATM/ITM scale-out, and automated expiry settlement. Enforces a hard cap of 3 positions per option type — partially-exited positions hold their slot until fully closed. Synchronizes with Supabase for multi-instance stability, with a DB-level count guard preventing over-entry under race conditions.

---

## End-to-End Data Flow

### Initialization

1. Load product universe for the selected underlying.
2. Derive expiries and strikes; auto-select first expiry if none is configured.
3. Pull spot price and start periodic spot refresh (every 10s).

### Live Monitoring (Charts)

1. Bootstrap candles from REST.
2. Start WebSocket streams for selected symbols.
3. Update latest candles and Greeks continuously.
4. Every 5 seconds, refresh forming candle from REST.
5. At each candle boundary (+ settle delay), refresh full history for official close integrity.

### Ticker Subscription
- **Restart Optimization**: `lastWsSymbolsRef` hashes the symbol list to prevent redundant WebSocket restarts during periodic product refreshes, avoiding the "WebSocket is closed before established" error.
- **Auto-Refresh**: Products and expiries are re-queried from Delta every 5 minutes; if the currently selected expiry disappears (e.g. daily rollover), the UI automatically shifts to the next available date.
- **Buffered Flush**: 50ms ticker batching reduces render pressure under high-volatility data bursts.

### Live Scanning

1. Subscribe to all option symbols in the selected expiry.
2. Buffer and batch ticker updates (50ms flush) to limit render pressure.
3. Evaluate pair candidates using strike/IV/premium/deviation constraints.
4. Publish top-3 call and top-3 put candidates to the scanner table, and broadcast to Paper Trading via `BroadcastChannel`.

### Paper Trading (Automated Lifecycle)

1. Merge local scan candidates with real-time scanner broadcasts.
2. Each minute, evaluate all active positions for rotation or ATM/ITM/expiry exit triggers.
3. **Expiry**: exit 2 minutes early for stable settlement prices.
4. **ATM/ITM scale-out**: multi-stage partial exits based on `strikeDiff`; partially-exited positions stay in the portfolio, holding their slot while cleanly scaling down their PnL multipliers and margin allocations.
5. **Rotation**: exit position if a better-ranked strike is available; gated by threshold guard (min 3 per side) and limited to 1 rotation per side per cycle.
6. **Auto-Maintenance**: Product and expiry list refreshed every 5 minutes to capture rollovers. Header UI uses `tabular-nums` and fixed-width containers to maintain layout stability during high-frequency (1s) PnL updates.
7. Open new positions up to 3 per type from the ranked candidate list. DB count guard prevents exceeding 3 even under race conditions.
8. Sync all entries, exits, and partial scale-outs to Supabase. Full `positions` array replacement only happens when rows are added/removed, not on routine PnL updates.

---

## Technology Choices

| Component | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Fast iteration, modular stateful UI |
| Charting | `lightweight-charts` | High-performance OHLC rendering |
| Streaming | Native WebSocket | Low-latency market updates |
| Data buffering | `useRef` + batched flush | Controls re-render frequency under bursty data |
| Persistence | Supabase (PostgreSQL) | Serverless, real-time DB with cross-device sync |
| Styling | Vanilla CSS | Fine-grained control of trading terminal aesthetics |
