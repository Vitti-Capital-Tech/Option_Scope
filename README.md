# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and paper-trading simulation in a single serverless React app.

## Overview

The app is built around three workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: Discover call/put ratio spread opportunities using lot-size-aware delta notional alignment.
- **Paper Trading**: Fully automated strategy lifecycle simulation — entry, live PnL, multi-stage scale-out exits, rotation, expiry settlement, and trade history export.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, and `Paper Trading` modules with shared underlying/expiry flows.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion (50ms batch flush) and throttled compute cycle for large symbol sets.
- **Automated Rotation Engine**: Positions are rotated toward higher-ranked (closer-to-ATM) strikes. Rotation is gated by a portfolio threshold guard (3 calls + 3 puts) and limited to **one rotation per side per scan cycle** to prevent cascading exits.
- **Hard Portfolio Cap**: Maximum 3 active positions per option type (calls/puts) enforced at both the local evaluation level and via a DB-level count guard before every Supabase insert. Partially-exited positions hold their slot until fully closed.
- **Paper Trade Analytics**: Margin estimate (lot-size aware), unrealized/realized PnL, precise fraction-based multi-stage scale-out exits (expiry 2min early, ATM/ITM stages), expiry settlement, and trade history export.

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

## Installation and Setup

### Prerequisites

- Node.js (v18+)

### Steps

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Open the local URL printed by Vite.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.