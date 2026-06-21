# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and two independent automated paper-trading engines in a single serverless React app.

## Overview

The app is built around four workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: A standalone options discovery scanner. Discovers call/put ratio spread opportunities using lot-size-aware delta notional alignment and execution-realistic pricing (Long @ Ask, Short @ Bid). Persists configuration locally in `localStorage` independent of Paper Trading database states. Features real-time ATM projections displaying the **At ATM Ask/Bid** and the projected **At ATM P&L** directly from the live options chain, mapped to the true market ATM strike. When the exact ATM or derived OTM strike is missing from the live feed, the system automatically falls back to the **nearest available strike** within a tight asset-specific tolerance (**`500`** points for BTC / **`50`** points for ETH) under the same contract expiry.
- **Paper Trading**: Scoped multi-account simulation environment. Features custom React modals to create, edit (renaming via `react-hook-form` validation), and delete accounts (complete with active position safety warnings). Live PnL is based on immediate liquidation values, configurable exit filters (ATM, ITM, OTM with points-based thresholds), dynamic portfolio rotation, expiry settlement, IV tracking, and CSV exports.
- **ATM Exit Trading**: A simplified, always-on trading variant with a single exit rule (100% at ATM). Features bucketed performance analytics, configurable algo parameters persisted to Supabase, and automatic trade-level statistics aggregation by strike diff and sell quantity.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, and `Paper Trading` modules with shared underlying/expiry flows. The Paper Trading module includes a **Multi-Account Selector Dropdown** allowing users to switch active trading accounts instantly.
- **Themed Create, Edit & Delete Modals**: Fully custom React-based modals for creating, editing, and deleting accounts (complete with warning prompts when deleting accounts with open positions) and logout confirmation overlay, replacing legacy browser alerts. Integrates inline spinning SVG loaders, double-submission blocks, and active theme CSS variables (`--bg2`, `--bg3`, `--text`, `--text-dim`) for seamless light/dark mode compatibility.
- **Cross-Tab Account Synchronization**: Broadcasts account modifications instantly across all active browser tab sessions via `BroadcastChannel` (`ACCOUNTS_SYNC`), keeping dropdown lists updated in real-time.
- **Buffered & Applied Filter Editing**: Filter changes in Paper Trading do not affect execution instantly. Edits are buffered in a local tab-specific draft state. The user must click **Apply** to save changes to the database. Clicking **Reset** immediately reverts all filter inputs to system default parameters, persists those defaults to Supabase, and syncs all active tabs.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion (50ms batch flush) and throttled compute cycle for large symbol sets.
- **Strict Execution-Realistic Paper Trading**: High-fidelity simulation using Ask prices for long legs and Bid prices for short legs. New entries require WebSocket-confirmed quotes updated within the last 120 seconds, preventing false fills on illiquid strikes.
- **IV Tracking (Bid/Ask-Specific)**: All IV metrics throughout the platform use directional IVs — `ask_iv` for long (buy) legs and `bid_iv` for short (sell) legs. Dedicated IV In/Current/Out columns in Active Positions and Trade History tables.
- **ATM Ratio & Price Tracking**: Captures the exact ATM option prices and computed ratio at the moment of entry and exit (full/partial). Displays these values as **Entry ATM Ratio (Prices)** and **Exit ATM Ratio (Prices)** columns in the Trade History UI table and exports them to CSV.
- **Dynamic Portfolio Rotation**: Surgical 1-for-1 replacement using **Conflict-Aware Scanning**. The rotation ranking protection check filters candidate strikes by type and slices them dynamically based on the configured maximum active positions (`numberOfCalls` / `numberOfPuts`). Includes **Atomic Pre-Validation** ensuring replacement candidates pass all safety guards (0.5% scaling) before an exit is authorized. Validates leg swaps against the **Net Premium Swap Cost Check** (must be non-negative credit/debit, i.e. `>= 0`), ensuring candidate target quantities are scaled by the $200,000 portfolio cap at 200× leverage first. Leg swaps update the position row **in-place** (not delete+insert), recording buy-leg-only PnL in trade history and **weighted-averaging** the sell entry price if the short quantity changes.
- **Scaling & Uniqueness Guards**: Advanced entry filtering including a **0.5% Directional Spot Scaling Guard** (mean-reversion) and a **400-point Strike Diversification** rule (ATM Exit Trading) or **ATM P&L >= $50 and ROI-based Sorting** (Paper Trading) to prevent portfolio concentration. Strike uniqueness is checked at the database level for both buy and sell legs to block duplicate entries under race conditions. A **Days to Expiry** filter (default `0`) prevents entering positions on expiries with fewer remaining days than the configured threshold, and automatically selects the nearest valid expiry.
- **Active Position Trailing Stop Scaling**: In the Paper Trading engine, active positions are dynamically scaled during their trade lifetime. If the trade's unrealized P&L (`grossPnl`) is at or above the trailing threshold `(checkpointAtmPnl * 0.10) + checkpointPnl` AND under a hypothetical reduction of the buy leg quantity by **10% of the position's current lot size**, the recalculated position ratio (`sellQty / hypotheticalLotSize`) is at least **1.00 points lower** than the live ATM ratio (meaning `liveAtmRatio >= recalculatedRatio + 1.00`), a partial scale-down exit is triggered, realizing proportional PnL and updating checkpoints.
- **Visual Simulation Mode & ATM Ratio scaling (What-If)**: Toggling ATM Ratio Entry ON in the scanner simulates quantities, margins, net premiums, and projected PnLs under the 200X leverage limit ($200k portfolio cap) using a percentage-based scaling offset (`atmRatioPctCall` / `atmRatioPctPut`), highlighting modified candidate ratios in golden text. Paper Trading renders database metrics as-is.
- **Time-Based Filter Schedules**: Define multiple named time windows per account within a 24-hour cycle. Each window overrides specific strategy filters (`numberOfCalls`, `numberOfPuts`, `minLongDist`, `minStrikeDiff`) when active (based on local IST time, supporting overnight ranges), automatically falling back to the base account config during gaps.
- **Hard Portfolio Cap**: Configurable maximum active positions per option type (calls/puts, defaulting to 3 each) enforced at both the local evaluation level and via a DB-level count guard before every Supabase insert.
- **Auto-Reconnecting WebSocket**: The `createTickerStream` function automatically re-establishes dropped connections after 3 seconds, ensuring unattended VPS operation remains stable without manual intervention.
- **Connection Stability**: Intelligent WebSocket hashing (`lastWsSymbolsRef`) prevents redundant restarts. A defensive REST backfill via `/v2/tickers` guarantees accurate prices on manual refreshes without zeroing existing data, and a 1-second fallback heartbeat keeps the UI perfectly synced even when market data streams are quiet.
- **Nearest-Strike ATM Fallback**: When an exact ATM or derived sell strike is absent from `tickerData` (e.g. sparse option chains, ticks not yet received), the ATM projection logic finds the closest available strike within a tight asset-specific tolerance (**`500`** points for BTC / **`50`** points for ETH) under the same contract expiry instead of defaulting to zero. ATM P&L and ratio cells show `—` rather than `$0.00` when no suitable ticker is found, preventing misleading analysis.
- **Config Auto-Creation**: When a new account is started, the engine auto-creates a default config row in Supabase if one doesn't exist, ensuring every account always has valid filter settings.
- **Config Hot-Reload**: Each engine subscribes to Supabase Realtime on `paper_trading_config`. When Apply or Reset is clicked, the engine re-reads config immediately and restarts the WebSocket if the underlying or expiry changed.
- **Zombie Exit Guard**: Positions that survive past expiry by more than 10 minutes are force-exited with the exit time back-dated to the exact expiry timestamp for accurate trade history.
- **2-Minute Fallback Position Sync**: In addition to Supabase Realtime events, the engine re-fetches active positions from the database every **2 minutes** as a safety net against missed events (reduced from 30 seconds — Realtime is the primary sync mechanism).
- **Evergreen Data Engine**: Background product/expiry refresh every 5 minutes keeps filters and candidate pools fresh without manual page reloads.
- **Paper Trade Analytics**: Bid/Ask spread-aware margin estimate, unrealized/realized PnL based on liquidation value, configurable exit triggers (ATM, ITM, OTM), expiry settlement, and trade history export.
- **ATM Exit Analytics**: Bucketed trade statistics (by sell quantity range and strike diff) with running averages for margin, P&L, net premium, and fees.

## Architecture

The project uses a decoupled headless architecture to ensure 24/7 strategy execution without relying on an open browser:

1. **Headless Backend Engines (Node.js)**: Dedicated background workers (`paperTradingEngine.js` and `atmExitEngine.js`) run continuously on a VPS. They handle the Delta Exchange WebSocket connections, evaluate exit triggers every second to minimize slippage, scan for new entries on 1-minute boundaries to optimize database reads, and persist positions/analytics directly to Supabase. The engines tolerate up to 120 seconds of spot price staleness to prevent rate-limit lockouts. All accounts start **in parallel** via `Promise.allSettled` (startup time ~3s vs ~30s sequential). Active positions are re-fetched from the database every **2 minutes** as a fallback safety net against missed Realtime events.
2. **Frontend UI Dashboard**: React (Vite) app that serves as a read-only monitoring dashboard and configuration control panel. It watches the Supabase database via Realtime subscriptions to display live PnL and uses an `engine_heartbeat` table with a ticking UI countdown to guarantee the background engines are healthy.
3. **Persistence & Sync**: Supabase (PostgreSQL) is the source of truth for configuration, active positions, trade history, and analytics. **Supabase Realtime** subscriptions on `active_positions` deliver instant push-based updates to all connected browser instances (<1s). Trade history `INSERT` events use Realtime `payload.new` directly — no full table refetch on each trade close, eliminating the largest egress source.
4. **Chart Engine**: `lightweight-charts` with always-mounted panels to avoid remount jitter.
5. **Proxying**: Vite local proxy and Vercel rewrites for CORS-safe API access.

## Documentation

Detailed design documentation is available in the `docs` folder:

- [High Level Design (HLD)](docs/hld.md)
- [Low Level Design (LLD)](docs/lld.md)
- [Option Premium Charts Explained](docs/charts_explained.md)
- [Ratio Spread Scanner Explained](docs/ratio_spread_explained.md)
- [Paper Trading Engine Explained](docs/paper_trading_explained.md)