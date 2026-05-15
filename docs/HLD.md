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
- **Defensive Backfill**: A manual UI refresh triggers a targeted `/v2/tickers` REST request. This intelligently merges live prices without overwriting existing data with missing/zeroed fields, guaranteeing immediate price accuracy even if the WebSocket stream is temporarily silent.

### Live Scanning

1. Subscribe to all option symbols in the selected expiry.
2. Buffer and batch ticker updates (50ms flush) to limit render pressure.
3. Evaluate pair candidates using strike/IV/premium/deviation constraints. Uses **execution-realistic pricing**: Long legs are evaluated at the **Ask** and Short legs at the **Bid**. Similarly, **IV Diff** is calculated using directional IVs (Ask IV for long, Bid IV for short).
4. Publish top-3 call and top-3 put candidates to the scanner table, and broadcast to Paper Trading via `BroadcastChannel`.

### Paper Trading (Automated Lifecycle)

1. Merge local scan candidates with real-time scanner broadcasts.
   - **Execution-Realistic Entries**: New positions are entered at the Ask for long legs and Bid for short legs, capturing the true cost of crossing the spread.
2. Each minute, evaluate all active positions for rotation or ATM/ITM/expiry exit triggers.
    - **Liquidation-Based PnL**: Unrealized PnL is calculated based on immediate exit prices: long positions are valued at the current Bid (selling back) and short positions at the current Ask (buying back).
3. **Scaling & Uniqueness Guards**: 
   - **Directional Spot Scaling**: Enforces a 0.5% price gap (rounded to 100) between entries for mean-reversion scaling.
   - **Strike Diversification**: Ensures new long strikes are at least 400 points away from existing long strikes.
4. **Visual Simulation Mode**: A "What-If" dashboard layer that allows users to simulate the impact of adding custom premium/credit to their strategy visually (including P&L and ratio recalculation) without affecting the underlying database.
5. **Expiry**: exit 2 minutes early for stable settlement prices.
4. **Phase 5: Dynamic Portfolio Rotation**
The engine compares existing positions against current top scanner results:
- **Displacement Check**: If a position is no longer in the Top 3 unique strikes AND a superior candidate (closer to ATM) is available, it is marked for rotation.
- **Conflict-Aware Target Scanning**: To ensure an exit is always followed by a successful entry, the engine verifies that the replacement target strike does not collide with any **other** active positions before approving the rotation.
- **1-for-1 Displacement**: To prevent mass exits, the engine uses a **Target Reservation** system. Each new superior candidate in the scanner is "claimed" by exactly one existing inferior position.
- **Worst-First Processing**: Active positions are evaluated from farthest-to-ATM first, ensuring the least desirable legs are rotated out first.
- **Cycle Guards**: Rotation only begins once the portfolio hits a threshold (e.g., 3 active legs) and is capped at 3 rotations per evaluation cycle.

### Phase 6: Performance Monitoring & History
- **Dual KPIs**: Tracks **Today's P&L** (Today's Realized + Current Open) using local timezone logic, and **All-Time P&L** (Total Realized + Total Open).
- **Local History Sync**: Trade history filtering is synchronized with the user's local timezone (00:00 - 23:59 window).
- **Supabase Persistence**: Automated logging of every entry, partial exit, and full closure for historical auditing.
Product and expiry list refreshed every 5 minutes to capture rollovers. Header UI uses `tabular-nums` and fixed-width containers to maintain layout stability during high-frequency (1s) PnL updates. A 1-second background heartbeat ensures the UI stays perfectly synced even during extremely quiet market periods when the WebSocket is inactive.
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
