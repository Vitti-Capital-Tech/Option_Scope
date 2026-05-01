# OptionScope

OptionScope is a real-time options intelligence workspace for Delta Exchange. It combines live charting, ratio spread discovery, and paper-trading simulation in a single serverless React app.

## Overview

The app is built around three workflows:

- **Charts**: Monitor call, put, or combined premium structures with live candles, Greeks, and alerting.
- **Ratio Spread Scanner**: Discover call/put ratio opportunities using lot-size-aware delta notional alignment.
- **Paper Trading**: Simulate strategy lifecycle (entry, live PnL, exits, history, CSV export) using the scanner logic.

## Key Features

- **Live Multi-Page Trading UI**: `Charts`, `Ratio Spread`, and `Paper Trading` modules with shared underlying/expiry flows.
- **Data Hub + Auto-Correction**: WebSocket for low-latency updates plus periodic REST correction for candle accuracy.
- **Advanced Chart Tools**: SMA(20), drawing mode for S/R lines, zoom/scroll controls, and theme toggle.
- **Watchlist and Alerts**: Track multiple strategies, monitor live + 1h high/low, and trigger toast/notification alerts.
- **Scanner Performance Pipeline**: Buffered ticker ingestion and throttled compute cycle for large symbol sets.
- **Paper Trade Analytics**: Margin estimate, unrealized/realized PnL, auto/manual exits, and trade history export.

## Architecture

The project is built with a modern, serverless stack:

1. **Frontend**: React (Vite) with imperative chart updates for high-frequency data.
2. **Connectivity**: Delta Exchange WebSocket (`v2/ticker`, `trades`, `l2_updates`, `mark_price`) + REST backfill.
3. **Chart Engine**: `lightweight-charts` with always-mounted panels to avoid remount jitter.
4. **Proxying**: Vite local proxy and Vercel rewrites for CORS-safe API access without a custom backend.

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