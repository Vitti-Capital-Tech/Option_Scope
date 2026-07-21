# High Level Design — OptionScope

## What The System Does

OptionScope is a client-side trading workstation for Delta Exchange options. It has two top-level UI modules — plus a live-execution mode on Paper Trading accounts:
- **Ratio Spread Scanner**: Live discovery of ratio spreads based on premium-to-delta-notional alignment.
- **Paper Trading**: Fully automated simulation of spread entry, live PnL, configurable exit types (ATM, ITM, OTM with points-based offsets), a **two-phase exit** (short-leg buy-back → long-only laddered scale-out), IV tracking, and expiry settlement.
- **Live Trading**: Any paper account can be switched to `live` mode and linked to a real Delta Exchange account. The same engine then places **real orders** — marketable-limit entries, a resting-order exit model, and exchange-native SL/TP brackets — gated by a global dry-run flag and a per-account arm switch. See [Live Trading](live_trading.md).

The user selects underlying and expiry, then the system streams option telemetry and updates UI decisions in near real-time.

> **Strategy versioning:** the paper and live engines share one codebase. A per-account `strategy_version` (`paper_trading_config`, migrations `018`–`020`) gates experimental logic — **paper runs v2** (the experimental testbed), **live runs the stable v1** — so a new behaviour can be validated on paper without touching live, then promoted per-account.

---

## System Components

```text
Headless Backend Engine (Node.js VPS)
  |
  |-- paperTradingEngine.js (Continuous execution, IV tracking, Supabase syncing)
  |-- WebSocket adapter ---> Delta WS (Auto-reconnect + heartbeats)

Browser (React + Vite Dashboard)
  |
  |-- Navigation Shell (Scanner / Paper Trading)
  |-- WebSocket adapter (UI local tickers) ---> Delta WS
  |-- Persistence & Sync Hub (Supabase Realtime + BroadcastChannel)
```

### 1) UI Layer (Dashboard)

- React components are route-like modules switched inside the app shell via `main.jsx`.
- `PaperTrading.jsx` no longer runs automated logic; they are read-only views showing live database state and a ticking server `engine_heartbeat` countdown.
- Both modules are always mounted (via `display: none/block`) to preserve state during navigation.
- Theme toggle is shared across modules.
- **Multi-Account Selector**: Features a styled, theme-friendly dropdown selector on the Paper Trading dashboard header to instantly switch the active account. The Ratio Spread Scanner is now a fully standalone component that saves its config locally in `localStorage` and does not connect to paper trading accounts.
- **Themed Modals**: Features custom React modals for creating, editing, and deleting accounts, as well as a confirmation dialog for logging out. The Create Account Modal includes options to set up the default strategy filters (pre-filled with the current page's active filters), allowing users to define strategy thresholds immediately upon creation. It uses `react-hook-form` to validate inputs. Styled with active theme CSS variables (`--bg2`, `--bg3`, `--text`, `--text-dim`) with inline loading spinner SVGs during DB operations, and warns the user if they try to delete an account with active positions.
- **Buffered Filter Editing & Apply/Reset**: Configuration edits inside the filter panel are buffered locally in the tab state. The **Apply** button is enabled when changes are dirty, and saves the updates to Supabase and broadcasts them to other tabs. The **Reset** button reverts all filter parameters to standard system defaults, upserts them to Supabase immediately, and broadcasts to all active tabs.
- **Synchronization**: Core configuration parameters (`underlying`, `atmRatioScaling`, `atmRatioPctCall`, `atmRatioPctPut`) and the current accounts list (`ACCOUNTS_SYNC`) are synchronized across tabs via `BroadcastChannel` and persisted to Supabase for cross-device consistency.

### 2) Market Data & Connectivity Layer

- **REST** handles product metadata, initial candle history, and correction backfills.
- **WebSocket** handles low-latency live fields (`v2/ticker`, `mark_price`, trades, order book updates).
- **Auto-Reconnect**: `createTickerStream` (used by Scanner and Paper Trading) automatically reconnects after 3 seconds if the WebSocket drops. This is critical for unattended VPS operation.
- **Supabase** (PostgreSQL) stores algorithm configuration, active trading positions, realized trade history, and bucketed analytics.
- **Supabase Realtime**: A `postgres_changes` subscription on `active_positions` delivers INSERT/UPDATE/DELETE events to all connected browser sessions instantly (< 1s). This replaces the previous 10-second polling loop, eliminating the delay between when the VPS engine writes a trade and when other browser views reflect it. Paired with tab visibility guards, standard REST polling fallbacks are completely removed to optimize network egress and database load.
- Proxy rewrites keep the architecture serverless while handling CORS.
- **Live Account Security**: Delta API credentials live in a dedicated `delta_credentials` table — `api_key` (public) plus `api_secret_enc` encrypted at rest with pgcrypto `pgp_sym_encrypt` under a key held in **Supabase Vault**. RLS denies `anon`/`authenticated` any read of the secret; clients write only through a `SECURITY DEFINER` RPC (`upsert_delta_credentials`, encrypts server-side), owners read non-secret metadata via `get_delta_credentials_meta`, and **only the engine (`service_role`) decrypts** via `get_delta_credentials_decrypted`. Because Delta keys are IP-whitelisted, verification is engine-mediated: the browser signs nothing sensitive; it enqueues a request the engine executes from the whitelisted IP and writes the result back.

### 3) Runtime Engines (Node.js VPS)

- **Scanner Engine (UI)** processes option chains for valid ratio candidates using configurable thresholds. Enforces directional filtering (Calls ≥ ATM, Puts ≤ ATM).
- **Multi-Account Paper/Live Supervisor (Node.js)**: The headless process (`paperTradingEngine.js`) runs a supervisor manager that queries `paper_trading_accounts` and spawns isolated, **parallel** engine execution loops (`startSingleAccountEngine`) for each account using `Promise.allSettled`. This reduces startup time from ~30s (sequential) to ~3s regardless of account count. Each account is reserved synchronously (`startingEngines` set) before its loop starts so a concurrent trigger can never spawn a second (zombie) evaluator that double-books exits; the process itself is pinned to one instance via `ecosystem.config.cjs` (`fork` / `instances: 1`). The supervisor listens to Supabase database events (INSERT, UPDATE, DELETE) on the `paper_trading_accounts` table to dynamically start, stop, or hot-reload single account engine threads in real-time without process restarts. The **same supervisor manages live accounts** — each loop reads `mode`, `live_enabled`, and `paused` and gates all real-order effects accordingly. Manual-action polling (`pollAllRequests`) and the 20s `live_exchange_state` snapshot are run at the **manager level** (batched across all accounts) so database egress stays flat as account count grows.
- **Live Execution Layer (Node.js)**: For armed-live accounts the engine places real orders through `engine/lib/deltaTradeApi.js` (signed Delta REST client — `placeOrder`, `placeBracketOrder`, `editOrder`, `cancelOrder`, `getLivePositions`, `getFills`, `getBalance`, …) wrapped by `engine/lib/liveExecution.js` (a dry-run-gated executor: `openSpread`, `closeLeg`, `changePositionBracket`, `placeStop`, `snapshot`, `walletBalance`, `reconcile`). All hooks sit alongside the existing DB writes and are gated on `mode === 'live' && live_enabled`, so paper logic is byte-for-byte unchanged. A global `DELTA_LIVE_DRYRUN` (default **ON**) logs intended orders without sending; a per-account `live_enabled` kill-switch arms real sends.
- **Single Account Engine**: Each loop executes the trading strategy independently, scoped by its specific account ID. Reuses scanner-style candidate selection to simulate positions. Filters candidates by projected ATM P&L >= $50 and sorts them by ROI descending. Enforces account-specific position limits (configurable maximum positions per option type), IV tracking, and Supabase synchronization. If no config row exists for a new account, the engine **auto-creates** a default config row with standard values (BTC, 800 strike diff, etc.).
- **Config Hot-Reload**: Each account engine subscribes to Supabase Realtime events on `paper_trading_config`. When the user clicks Apply or Reset in the UI, the engine re-reads config immediately. If the underlying or expiry changed, it refreshes products, clears tickers, and restarts the WebSocket for the new symbol set.

---

## End-to-End Data Flow

### Initialization

1. Load product universe for the selected underlying.
2. Derive expiries and strikes; auto-select first expiry if none is configured.
3. Pull spot price and start periodic spot refresh (every 10s).

### Ticker Subscription (Shared Infrastructure)
- **Restart Optimization**: `lastWsSymbolsRef` hashes the symbol list to prevent redundant WebSocket restarts during periodic product refreshes, avoiding the "WebSocket is closed before established" error.
- **Auto-Reconnect**: `createTickerStream` (used by Scanner and Paper Trading) automatically reconnects after 3 seconds if the WebSocket drops. This eliminates the need for manual restarts during unattended VPS operation.
- **Auto-Refresh**: Products and expiries are re-queried from Delta every 5 minutes; if the currently selected expiry disappears (e.g. daily rollover), the UI automatically shifts to the next available date.
- **Buffered Flush**: 50ms ticker batching reduces render pressure under high-volatility data bursts.
- **Defensive Backfill**: A manual UI refresh triggers a targeted `/v2/tickers` REST request. This intelligently merges live prices without overwriting existing data with missing/zeroed fields, guaranteeing immediate price accuracy even if the WebSocket stream is temporarily silent.

### Live Scanning

1. Subscribe to all option symbols in the selected expiry.
2. Buffer and batch ticker updates (50ms flush) to limit render pressure.
3. Perform REST backfill on scanner startup. Set `bidUpdatedAt` and `askUpdatedAt` to `Date.now()` if quotes exist so that backfilled tickers are recognized as fresh, filling the tables immediately.
4. Evaluate pair candidates every 2 seconds using a throttled scanner loop (and instantly on configuration updates).
5. Candidates are filtered using strike/IV/premium/deviation constraints. Uses **execution-realistic pricing**: Long legs are evaluated at the **Ask** and Short legs at the **Bid**. Similarly, **IV Diff** is calculated using directional IVs (Ask IV for long, Bid IV for short). Candidates must pass a **quote freshness guard**: both the buy and sell legs must have bid/ask quotes updated (either via REST backfill initially or by WebSocket ticks subsequently) in the last 120 seconds (`bidUpdatedAt > 0` and `askUpdatedAt > 0`), which prevents utilizing stale quotes on illiquid strikes.
6. Project spread values to the ATM boundary using live option chain shifting:
   - **At ATM Ask/Bid**: Pulls the current option chain Bid for the ATM strike (long leg) and the Ask for the OTM strike at `ATM ± strikeDiff` (short leg). If the exact strike is missing from `tickerData` (a "weird" strike-diff target can land between two listed grid strikes), the scanner takes the **nearest listed strike below and above** the target and returns the **average** of their prices (a midpoint estimate, replacing the old single-nearest snap that biased the ATM ratio), each side within a tight asset-specific tolerance (**1000** points for BTC and **50** points for ETH); if only one side exists it falls back to that single strike. Directly shows the ATM premium ratio below the prices, rounded to the nearest 0.25. Displays `—` when no suitable ticker exists. *(The live/paper engine uses the same bracket-and-average, so displayed and traded ATM ratios agree.)*
   - **At ATM P&L**: Computes the liquidation payout using the live ATM option chain quotes: `[(ATM_Bid - Entry_Long) - (OTM_Ask - Entry_Short) × Qty] × lotSize`. Computed only when both legs have valid (non-null, non-zero) prices; shows `—` otherwise. Directly displays the Return on Margin (ROI %) inside the same cell.
   - **At ATM Margin**: Computes the trade's margin requirement matching the Paper Trading tier-leverage system. Always shown — it is derived from spread entry prices, not ATM chain data, so it is always available.
   - **ATM Edge Floors**: When ATM Ratio Scaling is enabled, two display-time floors — **Min ATM P&L** (`minAtmPnl`, default 0) and **Min ATM ROI** (`minAtmRoi`, default 0) — hide rows whose projected at-ATM edge is below either threshold (rows with no ATM data stay visible). Ignored when scaling is off.
   - **ROI Sorting**: Dynamically groups results and sorts them descending by maximum ROI at ATM.
7. Publish top-3 call and top-3 put candidates to the scanner table, and broadcast to Paper Trading via `BroadcastChannel`.

### Paper Trading (Automated Lifecycle)

1. Run a self-contained local scan for ratio spread candidates (the headless engine does not merge from the browser Scanner's BroadcastChannel).
   - **Strict Execution-Realistic Entries**: New positions are entered at the Ask for long legs and Bid for short legs. Entries require live active quotes and are strictly rejected if executable quotes (Ask/Bid) are missing or if they are stale. The system checks that the bid/ask quotes for both legs have been confirmed by the WebSocket stream in the last 120 seconds (`bidUpdatedAt > 0` and `askUpdatedAt > 0`). This prevents executing entries on model-derived or stale REST ticker prices from illiquid strikes.
   - **REST Backfill (`refreshAllTickers` / `backfillTickers`)**: Triggered on algo start or manual page refresh. Calls `/v2/tickers` and merges results into the local ticker cache without zeroing existing data. When a valid bid or ask price exists in the REST response, `bidUpdatedAt`/`askUpdatedAt` is set to `Date.now()` so the first scan after startup can use backfill data immediately. Tickers with no price still get `timestamp = 0` and are rejected by the freshness guard. WS live quotes overwrite these timestamps as they arrive.
2. Evaluate active positions for rotation or dynamic exit targets (ATM, ITM, OTM with points-based thresholds)/expiry exit triggers every second to prevent slippage, while scanning and entering new positions on the 1-minute boundary.
   - **Liquidation-Based PnL**: Unrealized PnL is calculated based on immediate exit prices: long positions are valued at the current Bid (selling back) and short positions at the current Ask (buying back).
   - **Zombie Exit Guard**: If a position is more than **10 minutes past expiry**, its `exit_time` is back-dated to the exact expiry timestamp to ensure trade history reflects the true settlement moment.
   - **2-Minute Fallback Position Sync**: The engine re-fetches active positions from the database every 2 minutes as a safety net against missed Realtime events.
3. **Scaling & Uniqueness Guards**: 
   - **Directional Spot Scaling**: Enforces a 0.5% price gap (rounded to 100) between entries for mean-reversion scaling.
   - **Buy Strike Uniqueness**: Ensures new buy strikes are unique in the database for the same underlying and type via a DB-level check (`buyConflict`), preventing duplicate entries under race conditions.
   - **Min Days to Expiry (per window)**: Now a **per-schedule-window** control (migration `019`, paper AND live) rather than an account-level field. The traded expiry follows the active window (`current date + that window's DTE`) and rolls in ~1s as windows change — advancing to a farther expiry or back to a nearer one; live (v1) auto-rolls forward only when the expiry is missing/expired.
   - **Trading Days (day-of-week entry gate)**: A per-account `trade_days` set (migration `021`, default all-7) gates which weekdays new entries may open, aligned to the **17:30 IST** trading-day boundary (the Delta daily rollover). It stacks on top of the schedule windows — an entry needs both an active window *and* an enabled trading day — blocks entries only (exits/management continue), and applies to paper AND live.
   - **Paper Balance & Combined-Position Sizing (paper only, migration `027`)**: Paper accounts model a **funded balance** — dynamic equity = `initial_balance` + cumulative realized P&L. A **Balance Allocation %** carves the tradeable margin pool (the rest is buffer), and each schedule window has a **Max Combined Positions** cap (calls + puts) plus a **Split %** that derives the per-type cap `ceil(split% × combined)`. Per-position margin = allocated pool ÷ the **active window's** Max Combined, computed on the *remaining* pool so each new time window re-divides the leftover balance; positions scale to fill that margin and self-skip when the pool is exhausted. Live accounts are unchanged (wallet-balance sizing + `numberOfCalls`/`numberOfPuts`).
   - **Daily full-deployment fill (4:30 AM IST, paper only)**: normal sizing reserves budget for every empty slot, so idle balance can accumulate when candidates are scarce. Once per day, on the upward crossing of `04:30` IST (latched per IST date), the engine runs a one-time fill that **concentrates** the remaining pool across only the spreads scanning actually finds openable (÷ openable count, not ÷ empty slots) — respecting the Max Combined cap and the normal entry filters (no forced/low-quality fills; if nothing qualifies, nothing opens). A running-pool clamp keeps the pass from ever over-deploying. Existing positions are untouched.
   - **Whole-cycle pre-entry gate**: If the account is **paused** or the current trading day is disabled (i.e. this cycle can open nothing), the engine skips the *entire* candidate-evaluation pass — the per-spread ATM P&L/ROI compute, grouping, and the `Evaluating…`/`Candidate…` logs — not just placement. Exits and position management run regardless.
   - **Active Position Dynamic Scaling**: Evaluates active positions inside the exit loop. Scaling triggers when three conditions are met: (1) the position is **profitable** (`currentGrossPnl > 0`), preventing false triggers at entry when PnL is zero, (2) the PnL **is at or above the trailing threshold** (`currentGrossPnl >= checkpointAtmPnl * 0.10 + checkpointPnl`), and (3) under a hypothetical reduction of the buy leg quantity by **10% of the position's fixed initial scaled lot size (`pos.buyLeg.initialScaledLotSize`)**, the recalculated position ratio (`pos.sellQty / hypotheticalLotSize`) has a difference of at least **1** relative to the live ATM ratio (`liveAtmRatio >= recalculatedRatio + 1`), where the hypothetical lot size must be at or above the dynamic floor of 50% of the position's fixed initial scaled lot size (`pos.buyLeg.initialScaledLotSize * 0.5`). Only when all conditions are met, the long leg quantity (`buyLeg.lotSize`) is reduced by **10% of the position's fixed initial scaled lot size**, while the short quantity (`sellQty`) remains fully intact. After each step, `maxAtmRatio` in metadata is updated to reflect the new recalculated ratio of the position, and checkpoint values are saved. `entryAtmRatio` is never modified (it is a historical value). Each reduction is recorded in the `trade_history` table as a **partial exit** record, realizing the proportional entry fee and exit price P&L for the buy portion closed. The `exit_reason` for the partial exit is recorded in a concise format containing the exact initial and live ATM buy/sell prices, live and recalculated ratios, and original net debit/credit at entry of the position. The remaining position's margin is recalculated using `calcMargin` and saved to the database. This scaling can recur down to the dynamic floor limit (50% of initial scaled lot size).
   - **Baseline Calculations**: Calculates the entry ATM ratio (`entryAtmRatio`) and records it along with `originalLotSize` in the `buy_leg` JSON metadata at entry.
4. **IV Tracking**:
   - Entry IVs captured using directional Bid/Ask IVs (`ask_iv` for buy leg, `bid_iv` for sell leg).
   - Current IVs updated live from the ticker stream using the same directional logic.
   - Dedicated table columns: **IV In (B/S)**, **IV Cur (B/S)**, **IV Out (B/S)**.
5. **ATM Ratio & Price Tracking**:
   - Captures the exact ATM option prices (`buyIntrinsic`, `sellIntrinsic`) and their ratio (`entryAtmRatio`/`exitAtmRatio`) at entry and exit (full/partial).
   - Stored in the `buyLeg` JSON metadata within the `active_positions` and `trade_history` tables.
   - Dedicated Trade History columns: **Entry ATM Ratio (Prices)** and **Exit ATM Ratio (Prices)**.
6. **Visual Simulation Mode**: Driven directly by the configuration-level ATM Ratio Entry settings (`atmRatioScaling` toggle and `atmRatioPctCall` / `atmRatioPctPut` percentage offsets). When enabled, the **scaled short quantity is computed inside the scanner (`scanTickers`)** — before the Max Debit filter, which then runs on the scaled quantity — and `ResultTable.jsx` **consumes** it to render the derived margins, net premiums, and projected PnLs under the 200X leverage limit ($195k portfolio cap) in real-time, highlighting shifted candidate ratios in golden text (it no longer recomputes the scaling). The manual dollar-based visual "Base/Extra" toggle has been completely removed from both scanner and paper trading screens; Paper Trading renders database metrics as-is.
7. **Two-Phase Position Exit** (replaces the removed Dynamic Rotation / Leg Swap / "Lost Protected Rank" model): each active position is evaluated worst-first (farthest-from-ATM first) through a priority tree —
   - **Short-Leg-Only Exit**: for a full spread (`sellQty > 0`), once the short leg's live ask ≤ `shortExitPrice` (default `1.1`) the engine buys back **only** the short, books it (`trade_id -SE`), and the position becomes long-only (`sellQty → 0`, margin recomputed). Fires once, gap-safe.
   - **Long-Only Laddered Exit**: the held long is then scaled out as its bid recovers — **constant mode** (5 fixed levels: `[10,20,30,40,50]` if bid < 25 else `[25,50,75,100,125]`) or **variable mode** (`longExitSlices` equidistant levels from the current bid up to the last-4h high). Each slice books `trade_id -LE-<stage>`; the final slice clears the remainder and the row is deleted.
   - **Partial ATM-ratio scale-down** (full spreads only), **Expiry** (2 min early, with a 10-min zombie back-date), and **ATM/ITM/OTM spot-cross / candle-wick** remain as the other branches and catch-alls.
8. **Idempotent exit writes**: every `trade_history` row uses a deterministic `trade_id` (never `Date.now()`) plus a UNIQUE constraint and `upsert(onConflict:'trade_id', ignoreDuplicates:true)`, so a re-run or a race can never double-book an exit.
9. **Hedge Leg (paper v2)**: entries may carry an optional 3rd OTM long (`hedge_strike_type`, migrations `022`/`023`), forming a long/short/long triplet. The Max Net Debit gate applies to the combined 3-leg premium; the hedge rides the triplet and is closed only by the main long's ATM/ITM/OTM or expiry catch-all (`trade_id -HX`).
10. Open new positions up to the configured limit per type from the ranked candidate list, enforced by local and DB-level count guards (the cap counts full spreads only — `sell_qty > 0` — so held long-only rows are excluded).
11. Sync all entries and exits to Supabase. Full `positions` array replacement only happens when rows are added/removed, not on routine PnL updates.
12. **Instant Cross-Device Sync**: Supabase Realtime pushes `active_positions` change events to all connected sessions within <1s of a write. Trade history `INSERT` events are handled directly from the Realtime `payload.new` data — no full history re-fetch on each trade close. This eliminates the largest source of Supabase egress. The `lastDbWriteRef` post-write blackout is 3s to minimize the window where a just-written position could be overwritten by a stale re-fetch. Tab visibility listeners pause all active intervals (spot price, heartbeat) when in the background.
13. **Time-Based Filter Schedules**: Supports configuring multiple time windows per account. Frontend configuration inputs, the visual timeline, database storage (`TIME` type), and engine evaluation matches operate natively in Indian Standard Time (IST) for user convenience. The timeline bar displays the daily trading cycle starting and ending at `17:30` IST (the Delta Exchange daily rollover/day boundary). Every account has a permanent **Window 1** (auto-seeded from the base `paper_trading_config`, undeletable, defaulting to a full-day `17:30`→`17:29` IST range) so there are normally no gaps. When a schedule window matches, the engine builds an `effectiveConfig` overriding the window's scheduled parameters — the full set is `numberOfCalls`, `numberOfPuts`, `minStrikeDiff`, `minLongDist`, ATM-ratio scaling (`atmRatioScaling`/`atmRatioPctCall`/`atmRatioPctPut`), re-entry `spotDiff`, **Max Net Debit** (`maxNetPremium`), **Exit Type / Exit Points** (migration `012`), **Min DTE** (migration `019`, paper v2), and the **hedge** fields (migration `022`) — falling back to the base account config (the "gap fallback") when no window matches. **Exit Type is active-window-governed**: the paper exit check and the live spot-cross catch-all read the currently-active window's exit type each cycle, so an open position's exit level follows the window that is live now. (Live SL/TP brackets, however, are placed at entry from the then-active window and are not auto-moved on a window flip until re-synced.) Changes made in the UI are saved via a debounced (1.2s) **upsert-then-prune** auto-save (never DELETE-all, so a failed write can't wipe the schedule), showing live sync indicators (`✓ Live Synced`, `Syncing...`, `Overlap Detected`), and the engine reloads updates in real-time via Supabase Postgres Realtime subscriptions.

### Live Order Execution (Automated Lifecycle — armed real accounts)

For an account with `mode = 'live'`, `live_enabled = true`, and `DELTA_LIVE_DRYRUN = false`, the same lifecycle drives real Delta orders:

1. **Entry**: marketable-limit orders (buy @ ask + `entry_buy_offset`, sell @ bid − `entry_sell_offset`) are **chased to a full fill** (re-priced up to `ENTRY_CHASE_ATTEMPTS` times) or fully **unwound and aborted** if unfillable, so no half-open spread is left. Sizing is driven by the **live wallet balance** (`balance × balance_allocation_pct`, default 90%) split across peak concurrent positions, using each leg's real per-contract `contractValue` and clamped by a $195k short-notional cap; an entry is skipped (never guessed) if `contractValue` is missing. The order set is placed first and the `active_positions` row written last (recording order ids); a failed insert unwinds the orders (`-ORPHX`).
2. **Exit (resting-order model, `handleLiveRestingExit`)**: at entry a reduce-only resting BUY rests on the short at `shortExitPrice` (`-SEX`); when it fully fills (confirmed via `/v2/fills` + size 0) the short is booked and a **fixed long ladder** of reduce-only SELLs is placed (`-LE-<stage>`). Exchange-native **SL/TP brackets** at the exit-type spot level are attached at entry as an engine-down risk backstop and kept in sync (cancel-then-recreate) when exit params change.
3. **Reconciliation (exchange is source of truth)**: a periodic sweep (`reconcileOrphans`) books positions closed on Delta, **adopts** orphan long legs the engine doesn't track, flattens naked/dangling shorts, converts a manually-closed short into a laddered long-only (`externalShortExitToLongLadder`), adopts manual TP/SL changes, re-arms missing brackets, and reconciles external partial reductions — all idempotently. A per-cycle **margin self-heal** recomputes each live position's margin on the real contract-value basis.
4. **Observability**: a read-only 20s `live.snapshot()` upserts `live_exchange_state` (positions/orders/stop orders/fills/balances) for the dashboard, and armed-real failures (order/close/bracket/entry/reconcile) are pushed to **Telegram** (`notifyLiveFailure`, deduped).


### Performance Monitoring & History
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
| Streaming | Native WebSocket | Low-latency market updates with auto-reconnect |
| Data buffering | `useRef` + batched flush | Controls re-render frequency under bursty data |
| Persistence | Supabase (PostgreSQL) | Serverless, real-time DB with cross-device sync |
| Styling | Vanilla CSS | Fine-grained control of trading terminal aesthetics |
