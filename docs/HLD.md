# High Level Design — OptionScope

## What The System Does

OptionScope is a client-side trading workstation for Delta Exchange options. It has four top-level modules:
- **Charts**: Real-time call/put/combined premium monitoring with Greeks and alerts.
- **Ratio Spread Scanner**: Live discovery of ratio spreads based on premium-to-delta-notional alignment.
- **Paper Trading**: Fully automated simulation of spread entry, live PnL, full ATM exits, standard portfolio rotation, IV tracking, and expiry settlement.
- **ATM Exit Trading**: A simplified, always-on trading variant with a single exit rule (100% at ATM), built-in scanner, bucketed analytics, and no partial exits.

The user selects underlying and expiry, then the system streams option telemetry and updates UI decisions in near real-time.

---

## System Components

```text
Headless Backend Engine (Node.js VPS)
  |
  |-- paperTradingEngine.js (Continuous execution, IV tracking, Supabase syncing)
  |-- atmExitEngine.js (Always-on ATM single-exit, Bucketed analytics)
  |-- WebSocket adapter ---> Delta WS (Auto-reconnect + heartbeats)

Browser (React + Vite Dashboard)
  |
  |-- Navigation Shell (Charts / Scanner / Paper Trading / ATM Exit)
  |-- WebSocket adapter (UI local tickers, greeks) ---> Delta WS
  |-- Persistence & Sync Hub (Supabase Realtime + BroadcastChannel)
```

### 1) UI Layer (Dashboard)

- React components are route-like modules switched inside the app shell via `main.jsx`.
- `PaperTrading.jsx` and `ATMExitTrading.jsx` no longer run automated logic; they are read-only views showing live database state and a ticking server `engine_heartbeat` countdown.
- All four modules are always mounted (via `display: none/block`) to preserve state during navigation.
- Theme toggle is shared across modules.
- **Synchronization**: State (underlying, expiry, filters) is synchronized across tabs via `BroadcastChannel` and persisted to Supabase for cross-device consistency.

### 2) Market Data & Connectivity Layer

- **REST** handles product metadata, initial candle history, and correction backfills.
- **WebSocket** handles low-latency live fields (`v2/ticker`, `mark_price`, trades, order book updates).
  - `createTickerStream` uses an **auto-reconnect loop**: if the WebSocket closes unexpectedly, it re-establishes the connection after a 3-second delay. This is critical for unattended VPS operation.
  - `createWS` (used by the Charts module) delegates reconnect decisions to the caller.
- **Supabase** (PostgreSQL) stores algorithm configuration, active trading positions, realized trade history, and bucketed analytics.
- **Supabase Realtime**: A `postgres_changes` subscription on `active_positions` delivers INSERT/UPDATE/DELETE events to all connected browser sessions instantly (< 1s). This replaces the previous 10-second polling loop, eliminating the delay between when the VPS engine writes a trade and when other browser views reflect it. A 10-second fallback poll is retained for resilience.
- Proxy rewrites keep the architecture serverless while handling CORS.

### 3) Runtime Engines (Node.js VPS)

- **Charting Engine (UI)** uses imperative refs and always-mounted chart components for smooth updates.
- **Scanner Engine (UI)** processes option chains for valid ratio candidates using configurable thresholds. Enforces directional filtering (Calls ≥ ATM, Puts ≤ ATM).
- **Paper Trading Engine (Node.js)** A headless script (`paperTradingEngine.js`) that runs 24/7 on a VPS. Reuses scanner-style candidate selection to simulate positions. Filters candidates by projected ATM P&L >= $50 and sorts them by ROI descending to select the best candidate per buy strike. Enforces a hard cap of 3 positions per option type. Evaluates exit rules (ATM, expiry, rotations) every second to minimize slippage, while running full scans for entries on 1-minute boundaries to optimize DB load. Tracks Bid/Ask-specific IVs. Tolerates up to 120s spot price staleness. Synchronizes with Supabase.
- **ATM Exit Engine (Node.js)** A headless script (`atmExitEngine.js`). Runs an independent, self-contained scanner and evaluation loop. Evaluates exit rules every second, while running full scans for entries on 1-minute boundaries. Uses the same entry guards (0.5% spot scaling, 400pt diversification) but a simpler exit strategy: 100% close at ATM. Persists to separate Supabase tables (`atm_exit_*`) and aggregates bucketed running trade analytics. Tolerates up to 120s spot price staleness.

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

### Ticker Subscription (Shared Infrastructure)
- **Restart Optimization**: `lastWsSymbolsRef` hashes the symbol list to prevent redundant WebSocket restarts during periodic product refreshes, avoiding the "WebSocket is closed before established" error.
- **Auto-Reconnect**: `createTickerStream` (used by Scanner, Paper Trading, and ATM Exit) automatically reconnects after 3 seconds if the WebSocket drops. This eliminates the need for manual restarts during unattended VPS operation.
- **Auto-Refresh**: Products and expiries are re-queried from Delta every 5 minutes; if the currently selected expiry disappears (e.g. daily rollover), the UI automatically shifts to the next available date.
- **Buffered Flush**: 50ms ticker batching reduces render pressure under high-volatility data bursts.
- **Defensive Backfill**: A manual UI refresh triggers a targeted `/v2/tickers` REST request. This intelligently merges live prices without overwriting existing data with missing/zeroed fields, guaranteeing immediate price accuracy even if the WebSocket stream is temporarily silent.

### Live Scanning

1. Subscribe to all option symbols in the selected expiry.
2. Buffer and batch ticker updates (50ms flush) to limit render pressure.
3. Evaluate pair candidates using strike/IV/premium/deviation constraints. Uses **execution-realistic pricing**: Long legs are evaluated at the **Ask** and Short legs at the **Bid**. Similarly, **IV Diff** is calculated using directional IVs (Ask IV for long, Bid IV for short). Candidates must pass a **quote freshness guard**: both the buy and sell legs must have bid/ask quotes updated by the WebSocket stream in the last 120 seconds (`bidUpdatedAt > 0` and `askUpdatedAt > 0`), which prevents utilizing stale REST-backfilled quotes on illiquid strikes.
4. Project spread values to the ATM boundary using live option chain shifting:
   - **At ATM Ask/Bid**: Pulls the current option chain Bid for the ATM strike (long leg) and the Ask for the OTM strike at `ATM ± strikeDiff` (short leg). If the exact strike is missing from `tickerData`, the nearest available strike within a tight asset-specific tolerance (**500** points for BTC and **50** points for ETH) under the same contract expiry is used as a fallback. Directly shows the ATM premium ratio below the prices, rounded to the nearest 0.25. Displays `—` when no suitable ticker exists.
   - **At ATM P&L**: Computes the liquidation payout using the live ATM option chain quotes: `[(ATM_Bid - Entry_Long) - (OTM_Ask - Entry_Short) × Qty] × lotSize`. Computed only when both legs have valid (non-null, non-zero) prices; shows `—` otherwise. Directly displays the Return on Margin (ROI %) inside the same cell.
   - **At ATM Margin**: Computes the trade's margin requirement matching the Paper Trading tier-leverage system. Always shown — it is derived from spread entry prices, not ATM chain data, so it is always available.
   - **ROI Sorting**: Dynamically groups results and sorts them descending by maximum ROI at ATM.
5. Publish top-3 call and top-3 put candidates to the scanner table, and broadcast to Paper Trading via `BroadcastChannel`.

### Paper Trading (Automated Lifecycle)

1. Run a self-contained local scan for ratio spread candidates (the headless engine does not merge from the browser Scanner's BroadcastChannel).
   - **Strict Execution-Realistic Entries**: New positions are entered at the Ask for long legs and Bid for short legs. Entries require live active quotes and are strictly rejected if executable quotes (Ask/Bid) are missing or if they are stale. The system checks that the bid/ask quotes for both legs have been confirmed by the WebSocket stream in the last 120 seconds (`bidUpdatedAt > 0` and `askUpdatedAt > 0`). This prevents executing entries on model-derived or stale REST ticker prices from illiquid strikes.
2. Evaluate active positions for rotation or ATM/expiry exit triggers every second to prevent slippage, while scanning and entering new positions on the 1-minute boundary.
    - **Liquidation-Based PnL**: Unrealized PnL is calculated based on immediate exit prices: long positions are valued at the current Bid (selling back) and short positions at the current Ask (buying back).
3. **Scaling & Uniqueness Guards**: 
   - **Directional Spot Scaling**: Enforces a 0.5% price gap (rounded to 100) between entries for mean-reversion scaling.
   - **Buy Strike Uniqueness**: Ensures new buy strikes are unique in the database for the same underlying and type via a DB-level exact-match check (`buyConflict`), preventing duplicate entries under race conditions.
    - **Active Position Dynamic Scaling**: Evaluates active positions inside the exit loop. Scaling triggers when three conditions are met: (1) the position is **profitable** (`currentGrossPnl > 0`), preventing false triggers at entry when PnL is zero, (2) the PnL **is at or above the trailing threshold** (`currentGrossPnl >= checkpointAtmPnl * 0.05 + checkpointPnl`), and (3) under a hypothetical reduction of the buy leg quantity by **5% of its original quantity**, the recalculated position ratio (`pos.sellQty / hypotheticalLotSize`) has a difference of at least **0.25** relative to the live ATM ratio (`liveAtmRatio >= recalculatedRatio + 0.25`), where the hypothetical lot size must be at or above the fixed floor of `0.5`. Only when all conditions are met, the long leg quantity (`buyLeg.lotSize`) is reduced by **5% of the original long quantity**, while the short quantity (`sellQty`) remains fully intact. After each step, `maxAtmRatio` in metadata is updated to reflect the new recalculated ratio of the position, and checkpoint values are saved. `entryAtmRatio` is never modified (it is a historical value). Each reduction is recorded in the `trade_history` table as a **partial exit** record, realizing the proportional entry fee and exit price P&L for the buy portion closed. The `exit_reason` for the partial exit is recorded in a concise format containing the exact initial and live ATM buy/sell prices, live and recalculated ratios, original net debit/credit at entry of the position, and remaining unrealized net PnL. The remaining position's margin is recalculated using `calcMargin` and saved to the database. This scaling can recur down to the fixed floor limit of 0.5.
   - **Baseline Calculations**: Calculates the entry ATM ratio (`entryAtmRatio`) and records it along with `originalLotSize` in the `buy_leg` JSON metadata at entry.
4. **IV Tracking**:
   - Entry IVs captured using directional Bid/Ask IVs (`ask_iv` for buy leg, `bid_iv` for sell leg).
   - Current IVs updated live from the ticker stream using the same directional logic.
   - Dedicated table columns: **IV In (B/S)**, **IV Cur (B/S)**, **IV Out (B/S)**.
5. **ATM Ratio & Price Tracking**:
   - Captures the exact ATM option prices (`buyIntrinsic`, `sellIntrinsic`) and their ratio (`entryAtmRatio`/`exitAtmRatio`) at entry and exit (full/partial).
   - Stored in the `buyLeg` JSON metadata within the `active_positions` and `trade_history` tables.
   - Dedicated Trade History columns: **Entry ATM Ratio (Prices)** and **Exit ATM Ratio (Prices)**.
6. **Visual Simulation Mode**: A "What-If" dashboard layer that allows users to simulate the impact of adding custom premium/credit to their strategy visually (including P&L and ratio recalculation) without affecting the database.
7. **Full Portfolio Rotation**: Standard rotation that executes a full exit of the existing position and opens a new position with the improved strike, minimizing complexity and keeping the position architecture fully balanced.
8. **Expiry**: exit 2 minutes early for stable settlement prices.
9. **Dynamic Portfolio Rotation**:
   The engine compares existing positions against current top scanner results:
    - **Displacement Check**: If a position is no longer in the Top 3 unique strikes (the `inTop3` check filters candidates by type and slices exactly the Top 3 unique strikes) AND a superior candidate (closer to ATM) is available, it is marked for rotation.
    - **Atomic Pre-Validation**: The engine validates the replacement candidate against the **0.5% Scaling** guard *before* executing the exit. If the target would be blocked, the rotation is cancelled to prevent empty portfolio slots.
    - **Conflict-Aware Target Scanning**: It also ensures replacement targets never collide with existing portfolio strikes.
    - **1-for-1 Displacement**: To prevent mass exits, the engine uses a **Target Reservation** system. Each new superior candidate in the scanner is "claimed" by exactly one existing inferior position.
    - **Worst-First Processing**: Active positions are evaluated from farthest-to-ATM first, ensuring the least desirable legs are rotated out first.
    - **Cycle Guards**: Rotation only begins once the portfolio hits a threshold (e.g., 3 active legs) and is capped at 3 rotations per evaluation cycle.
10. Open new positions up to 3 per type from the ranked candidate list. DB count guard prevents exceeding 3 even under race conditions.
11. Sync all entries and exits to Supabase. Full `positions` array replacement only happens when rows are added/removed, not on routine PnL updates.
12. **Instant Cross-Device Sync**: Supabase Realtime pushes `active_positions` change events to all connected sessions within < 1s of a write. The `lastDbWriteRef` post-write blackout is reduced from 10s to 3s to minimize the window where a just-written position could be overwritten by a stale Supabase re-fetch. A 10-second fallback poll ensures any missed Realtime events are caught.

### ATM Exit Trading (Simplified Automated Lifecycle)

1. **Self-Contained Scanner**: Runs its own `scanTickers` function internally — does not rely on the external `RatioSpreadScanner` broadcast. Uses identical filtering logic (strike diff, IV diff, premium, ratio deviation, ATM directional filtering).
2. **Entry Guards**: Same as Paper Trading — 0.5% directional spot scaling, 400-point strike diversification, max 3 positions per type, DB-level count guard.
3. **Exit Strategy**: Single rule — **100% exit at ATM** (spot crosses buy strike). No partial exits or multi-stage scale-out.
4. **Rotation**: Lost Top 3 displacement with the same worst-first, conflict-aware, 1-for-1 reservation system. Capped at 3 rotations per cycle.
5. **Expiry Settlement**: Automatic close 2 minutes before expiry.
6. **Analytics Aggregation**: On every trade exit, running averages are upserted into bucketed Supabase tables (`atm_exit_qty_0_2_5`, `atm_exit_qty_2_5_5`, `atm_exit_qty_5_7_5`, `atm_exit_qty_7_5_10`) grouped by sell quantity range, strike diff, underlying, and type. Tracks: trade count, average margin, average P&L, average net premium, average fees.
7. **Always-On**: The algo starts automatically when products and expiry are loaded. The Start/Stop button has been replaced with a static "LIVE ALGO" indicator.
8. **Separate Persistence**: Uses distinct Supabase tables (`atm_exit_config`, `atm_exit_active_positions`, `atm_exit_trade_history`) to avoid any interference with the Paper Trading engine.

### Performance Monitoring & History (Both Engines)
- **Dual KPIs**: Tracks **Today's P&L** (Today's Realized + Current Open) using UTC+12h settlement offset, and **All-Time P&L** (Total Realized + Total Open).
- **Settlement-Aware Date Filtering**: Trade history uses a 12-hour UTC offset to align with Delta Exchange's settlement cycle. Date navigation with prev/next/today/all controls.
- **Supabase Persistence**: Automated logging of every entry, partial exit, and full closure for historical auditing.
- **Defensive Date Handling**: `Invalid Date` guards (`isNaN(d.getTime())`) protect against UI crashes from legacy or malformed database records.
- Product and expiry list refreshed every 5 minutes to capture rollovers. Header UI uses `tabular-nums` and fixed-width containers to maintain layout stability during high-frequency (1s) PnL updates. A 1-second background heartbeat ensures the UI stays perfectly synced even during extremely quiet market periods when the WebSocket is inactive.

---

## Technology Choices

| Component | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Fast iteration, modular stateful UI |
| Charting | `lightweight-charts` | High-performance OHLC rendering |
| Streaming | Native WebSocket | Low-latency market updates with auto-reconnect |
| Data buffering | `useRef` + batched flush | Controls re-render frequency under bursty data |
| Persistence | Supabase (PostgreSQL) | Serverless, real-time DB with cross-device sync |
| Styling | Vanilla CSS | Fine-grained control of trading terminal aesthetics |
