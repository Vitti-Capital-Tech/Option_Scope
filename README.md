# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and two independent automated paper-trading engines in a single serverless React app.

## Overview

The app is built around four workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: Discover call/put ratio spread opportunities using lot-size-aware delta notional alignment and execution-realistic pricing (Long @ Ask, Short @ Bid). Features real-time ATM projections displaying the **At ATM Ask/Bid** (actual ATM Bid for long leg, and OTM Ask at `ATM ± strikeDiff` for short leg) and the projected **At ATM P&L** directly from the live options chain, mapped to the true market ATM strike. When the exact ATM or derived OTM strike is missing from the live feed, the system automatically falls back to the **nearest available strike** within a tight asset-specific tolerance (**`500`** points for BTC / **`50`** points for ETH) under the same contract expiry, ensuring ATM columns never show misleading zeros or blanks.
- **Paper Trading**: Fully automated strategy lifecycle simulation — entry at Ask/Bid, 1s-cadence live PnL based on liquidation value, full ATM exits, rotation with leg swaps, expiry settlement, IV tracking, and trade history export.
- **ATM Exit Trading**: A simplified, always-on trading variant with a single exit rule (100% at ATM). Features bucketed performance analytics, configurable algo parameters persisted to Supabase, and automatic trade-level statistics aggregation by strike diff and sell quantity.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, `Paper Trading`, and `ATM Exit` modules with shared underlying/expiry flows.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion (50ms batch flush) and throttled compute cycle for large symbol sets.
- **Execution-Realistic Paper Trading**: High-fidelity simulation using Ask prices for long legs and Bid prices for short legs.
- **IV Tracking (Bid/Ask-Specific)**: All IV metrics throughout the platform use directional IVs — `ask_iv` for long (buy) legs and `bid_iv` for short (sell) legs — sourced from the Delta Exchange `v2/ticker` WebSocket stream. Dedicated IV In/Current/Out columns in Active Positions and Trade History tables.
- **ATM Ratio & Price Tracking**: Captures the exact ATM option prices and computed ratio at the moment of entry, leg swap, and exit (full/partial). Displays these values as **Entry ATM Ratio (Prices)** and **Exit ATM Ratio (Prices)** columns in the Trade History UI table and exports them to CSV for advanced analysis.
- **Dynamic Portfolio Rotation**: Surgical 1-for-1 replacement using **Conflict-Aware Scanning**. The rotation ranking `inTop3` check filters candidate strikes by type and slices exactly the Top 3 unique strikes. Includes **Atomic Pre-Validation** ensuring replacement candidates pass all safety guards (0.5% scaling) before an exit is authorized.
- **Scaling & Uniqueness Guards**: Advanced entry filtering including a **0.5% Directional Spot Scaling Guard** (mean-reversion) and a **400-point Strike Diversification** rule (ATM Exit Trading) or **ATM P&L >= $50 and ROI-based Sorting** (Paper Trading) to prevent portfolio concentration and select premium spreads. Strike uniqueness is checked at the database level for both buy and sell legs to block duplicate entries under race conditions.
- **Active Position Trailing Stop Scaling**: In the Paper Trading engine, active positions are dynamically scaled during their trade lifetime. If the trade's unrealized P&L (`grossPnl`) falls below the trailing threshold `(checkpointAtmPnl * 0.25) + checkpointPnl` (where `checkpointPnl` and `checkpointAtmPnl` act as checkpoints saved at each scaling step, defaulting to `netPremium` and `liveAtmPnl` at start) AND the live ATM ratio is greater than or equal to the position's own current ratio + 2 (meaning `liveAtmRatio >= (pos.sellQty / currentLotSize) + 2`), a partial scale-down exit is triggered. The long leg quantity (`buyLeg.lotSize`) is reduced by `0.25` (down to an absolute minimum floor of `0.5`), while the short quantity (`sellQty`) remains fully intact. Each reduction is recorded in the `trade_history` table as a **partial exit** record, realizing the exit price P&L for the buy portion closed, while reducing the remaining position's lot size and entry fee, and updating the checkpoint P&L/ATM metrics. The position's margin is automatically recalculated and updated in Supabase.
- **Visual Simulation Mode (What-If)**: Instant dashboard simulation for strategy research. Toggle between **Base** and **Extra** credit modes to see recalculated P&L and ratios across active positions, history, and KPIs without affecting the database.
- **Hard Portfolio Cap**: Maximum 3 active positions per option type (calls/puts) enforced at both the local evaluation level and via a DB-level count guard before every Supabase insert.
- **Auto-Reconnecting WebSocket**: The `createTickerStream` function automatically re-establishes dropped connections after 3 seconds, ensuring unattended VPS operation remains stable without manual intervention.
- **Connection Stability**: Intelligent WebSocket hashing (`lastWsSymbolsRef`) prevents redundant restarts. A defensive REST backfill via `/v2/tickers` guarantees accurate prices on manual refreshes without zeroing existing data, and a 1-second fallback heartbeat keeps the UI perfectly synced even when market data streams are quiet.
- **Nearest-Strike ATM Fallback**: When an exact ATM or derived sell strike is absent from `tickerData` (e.g. sparse option chains, ticks not yet received), the ATM projection logic finds the closest available strike within a tight asset-specific tolerance (**`500`** points for BTC / **`50`** points for ETH) under the same contract expiry instead of defaulting to zero. ATM P&L and ratio cells show `—` rather than `$0.00` when no suitable ticker is found, preventing misleading analysis.
- **Evergreen Data Engine**: Background product/expiry refresh every 5 minutes keeps filters and candidate pools fresh without manual page reloads.
- **Paper Trade Analytics**: Bid/Ask spread-aware margin estimate, unrealized/realized PnL based on liquidation value, full ATM exits, expiry settlement, and trade history export.
- **ATM Exit Analytics**: Bucketed trade statistics (by sell quantity range and strike diff) with running averages for margin, P&L, net premium, and fees.

## Architecture

The project uses a decoupled headless architecture to ensure 24/7 strategy execution without relying on an open browser:

1. **Headless Backend Engines (Node.js)**: Dedicated background workers (`paperTradingEngine.js` and `atmExitEngine.js`) run continuously on a VPS. They handle the Delta Exchange WebSocket connections, evaluate exit triggers every second to minimize slippage, scan for new entries on 1-minute boundaries to optimize database reads, and persist positions/analytics directly to Supabase. The engines tolerate up to 120 seconds of spot price staleness to prevent rate-limit lockouts.
2. **Frontend UI Dashboard**: React (Vite) app that serves as a read-only monitoring dashboard and configuration control panel. It watches the Supabase database via Realtime subscriptions to display live PnL and uses an `engine_heartbeat` table with a ticking UI countdown to guarantee the background engines are healthy.
3. **Persistence & Sync**: Supabase (PostgreSQL) is the source of truth for configuration, active positions, trade history, and analytics. **Supabase Realtime** subscriptions on `active_positions` deliver instant push-based updates to all connected browser instances (< 1s).
4. **Chart Engine**: `lightweight-charts` with always-mounted panels to avoid remount jitter.
5. **Proxying**: Vite local proxy and Vercel rewrites for CORS-safe API access.

## Documentation

Detailed design documentation is available in the `docs` folder:

- [High Level Design (HLD)](docs/hld.md)
- [Low Level Design (LLD)](docs/lld.md)