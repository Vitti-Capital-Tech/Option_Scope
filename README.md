# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and two independent automated paper-trading engines in a single serverless React app.

## Overview

The app is built around four workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: Discover call/put ratio spread opportunities using lot-size-aware delta notional alignment and execution-realistic pricing (Long @ Ask, Short @ Bid). Features real-time ATM projections displaying the **At ATM Ask/Bid** (actual ATM Bid for long leg, and OTM Ask at `ATM ± strikeDiff` for short leg) and the projected **At ATM P&L** directly from the live options chain, mapped to the true market ATM strike. When the exact ATM or derived OTM strike is missing from the live feed, the system automatically falls back to the **nearest available strike** within a 10% spot-price tolerance, ensuring ATM columns never show misleading zeros or blanks.
- **Paper Trading (Multi-Stage)**: Fully automated strategy lifecycle simulation — entry at Ask/Bid, 1s-cadence live PnL based on liquidation value, multi-stage scale-out exits (33%/50% partials based on strike diff), rotation with leg swaps, expiry settlement, IV tracking, and trade history export.
- **ATM Exit Trading**: A simplified, always-on trading variant with a single exit rule (100% at ATM). Features bucketed performance analytics, configurable algo parameters persisted to Supabase, and automatic trade-level statistics aggregation by strike diff and sell quantity.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, `Paper Trading`, and `ATM Exit` modules with shared underlying/expiry flows.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion (50ms batch flush) and throttled compute cycle for large symbol sets.
- **Execution-Realistic Paper Trading**: High-fidelity simulation using Ask prices for long legs and Bid prices for short legs.
- **IV Tracking (Bid/Ask-Specific)**: All IV metrics throughout the platform use directional IVs — `ask_iv` for long (buy) legs and `bid_iv` for short (sell) legs — sourced from the Delta Exchange `v2/ticker` WebSocket stream. Dedicated IV In/Current/Out columns in Active Positions and Trade History tables.
- **Dynamic Portfolio Rotation**: Surgical 1-for-1 replacement using **Conflict-Aware Scanning**. Includes **Atomic Pre-Validation** ensuring replacement candidates pass all safety guards (400pt diversification / 0.5% scaling) before an exit is authorized.
- **Scaling & Uniqueness Guards**: Advanced entry filtering including a **0.5% Directional Spot Scaling Guard** (mean-reversion) and a **400-point Strike Diversification** rule to prevent portfolio concentration. The 400-pt guard is enforced across **both pre-existing positions (`remaining`) and positions entered earlier in the same evaluation cycle (`newEntries`)**, preventing two same-cycle entries from slipping in with <400 pts distance between them. A DB-level proximity check (fetching all active `buy_strike` values) provides a second safety net for multi-tab race conditions.
- **Visual Simulation Mode (What-If)**: Instant dashboard simulation for strategy research. Toggle between **Base** and **Extra** credit modes to see recalculated P&L and ratios across active positions, history, and KPIs without affecting the database.
- **Hard Portfolio Cap**: Maximum 3 active positions per option type (calls/puts) enforced at both the local evaluation level and via a DB-level count guard before every Supabase insert. Partially-exited positions hold their slot until fully closed.
- **Auto-Reconnecting WebSocket**: The `createTickerStream` function automatically re-establishes dropped connections after 3 seconds, ensuring unattended VPS operation remains stable without manual intervention.
- **Connection Stability**: Intelligent WebSocket hashing (`lastWsSymbolsRef`) prevents redundant restarts. A defensive REST backfill via `/v2/tickers` guarantees accurate prices on manual refreshes without zeroing existing data, and a 1-second fallback heartbeat keeps the UI perfectly synced even when market data streams are quiet.
- **Nearest-Strike ATM Fallback**: When an exact ATM or derived sell strike is absent from `tickerData` (e.g. sparse option chains, ticks not yet received), the ATM projection logic finds the closest available strike within a configurable tolerance instead of defaulting to zero. ATM P&L and ratio cells show `—` rather than `$0.00` when no suitable ticker is found, preventing misleading analysis.
- **Evergreen Data Engine**: Background product/expiry refresh every 5 minutes keeps filters and candidate pools fresh without manual page reloads.
- **Paper Trade Analytics**: Bid/Ask spread-aware margin estimate, unrealized/realized PnL based on liquidation value, precise fraction-based multi-stage scale-out exits, expiry settlement, and trade history export.
- **ATM Exit Analytics**: Bucketed trade statistics (by sell quantity range and strike diff) with running averages for margin, P&L, net premium, and fees.

## Architecture

The project is built with a modern, serverless stack:

1. **Frontend**: React (Vite) with imperative chart updates for high-frequency data.
2. **Connectivity**: Delta Exchange WebSocket (`v2/ticker`, `trades`, `l2_updates`, `mark_price`) with auto-reconnect + REST backfill.
3. **Persistence & Sync**: Supabase (PostgreSQL) for persistent configuration, active positions, trade history, and analytics. **Supabase Realtime** subscriptions on `active_positions` deliver instant push-based updates to all connected browser instances (< 1s), replacing the previous 10-second polling loop. A 10-second fallback poll is retained as a safety net. Cross-tab synchronization via `BroadcastChannel`.
4. **Chart Engine**: `lightweight-charts` with always-mounted panels to avoid remount jitter.
5. **Proxying**: Vite local proxy and Vercel rewrites for CORS-safe API access without a custom backend.

## Documentation

Detailed design documentation is available in the `docs` folder:

- [High Level Design (HLD)](docs/hld.md)
- [Low Level Design (LLD)](docs/lld.md)