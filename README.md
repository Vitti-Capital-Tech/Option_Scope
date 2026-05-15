# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and paper-trading simulation in a single serverless React app.

## Overview

The app is built around three workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: Discover call/put ratio spread opportunities using lot-size-aware delta notional alignment and execution-realistic pricing (Long @ Ask, Short @ Bid).
- **Paper Trading**: Fully automated strategy lifecycle simulation — entry at Ask/Bid, 1s-cadence live PnL based on liquidation value, multi-stage scale-out exits, rotation, expiry settlement, and trade history export.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, and `Paper Trading` modules with shared underlying/expiry flows.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion (50ms batch flush) and throttled compute cycle for large symbol sets.
- **Execution-Realistic Paper Trading**: High-fidelity simulation using Ask prices for long legs and Bid prices for short legs.
- **Dynamic Portfolio Rotation**: Surgical 1-for-1 replacement using **Conflict-Aware Scanning**. Includes **Atomic Pre-Validation** ensuring replacement candidates pass all safety guards (400pt diversification / 0.5% scaling) before an exit is authorized.
- **Scaling & Uniqueness Guards**: Advanced entry filtering including a **0.5% Directional Spot Scaling Guard** (mean-reversion) and a **400-point Strike Diversification** rule to prevent portfolio concentration.
- **Visual Simulation Mode (What-If)**: Instant dashboard simulation for strategy research. Toggle between **Base** and **Extra** credit modes to see recalculated P&L and ratios across active positions, history, and KPIs without affecting the database.
- **Hard Portfolio Cap**: Maximum 3 active positions per option type (calls/puts) enforced at both the local evaluation level and via a DB-level count guard before every Supabase insert. Partially-exited positions hold their slot until fully closed.
- **Connection Stability**: Intelligent WebSocket hashing (`lastWsSymbolsRef`) prevents redundant restarts. A defensive REST backfill via `/v2/tickers` guarantees accurate prices on manual refreshes without zeroing existing data, and a 1-second fallback heartbeat keeps the UI perfectly synced even when market data streams are quiet.
- **Evergreen Data Engine**: Background product/expiry refresh every 5 minutes keeps filters and candidate pools fresh without manual page reloads.
- **Paper Trade Analytics**: Bid/Ask spread-aware margin estimate, unrealized/realized PnL based on liquidation value, precise fraction-based multi-stage scale-out exits, expiry settlement, and trade history export.

## Architecture

The project is built with a modern, serverless stack:

1. **Frontend**: React (Vite) with imperative chart updates for high-frequency data.
2. **Connectivity**: Delta Exchange WebSocket (`v2/ticker`, `trades`, `l2_updates`, `mark_price`) + REST backfill.
3. **Persistence & Sync**: Supabase (PostgreSQL) for persistent configuration, active positions, and trade history. Cross-tab synchronization via `BroadcastChannel`.
4. **Chart Engine**: `lightweight-charts` with always-mounted panels to avoid remount jitter.
5. **Proxying**: Vite local proxy and Vercel rewrites for CORS-safe API access without a custom backend.

## Documentation

Detailed design documentation is available in the `docs` folder:

- [High Level Design (HLD)](docs/HLD.md)
- [Low Level Design (LLD)](docs/LLD.md)