# OptionScope

OptionScope is a real-time monitoring dashboard for options contracts on Delta Exchange. It provides a premium, high-performance interface for traders to track live prices, combined premiums, and option Greeks.

## Overview

The application allows traders to monitor "Straddle" or "Strangle" positions by selecting an underlying asset, expiry date, and strike price. It generates real-time candlestick charts for individual call and put options alongside a **Combined Premium** chart, offering immediate insight into the total cost and performance of multi-leg positions.

### Key Features
- **Ratio Spread Scanner**: Real-time discovery of institutional ratio spreads with lot-size-aware delta notional logic.
- **Smart Scoring**: Proprietary ranking engine that identifies optimal spreads based on mathematical alignment, IV edge, and strike width.
- **Performance Optimized**: Uses throttled calculation loops and Ref-based data storage to handle high-frequency data bursts (150+ symbols) without UI lag.
- **Smart Selection**: Automatically detects and selects the At-The-Money (ATM) strike when you change expiry dates.
- **Purely Serverless**: Zero backend dependencies; uses Vite/Vercel edge rewrites to communicate directly with Delta Exchange.

## Architecture

The project is built with a modern, serverless stack:
1. **Frontend**: React (Vite) + `lightweight-charts` for high-performance financial charting.
2. **Connectivity**: Native WebSockets for sub-second price updates and Greeks.
3. **API Proxy**: Edge-level rewrites (`vercel.json`) and local proxies (`vite.config.js`) to handle CORS without a dedicated backend.

## Documentation

Detailed architectural documentation is available in the `docs` folder:

* [High Level Design (HLD)](docs/HLD.md) - Overview of components and data flow.
* [Low Level Design (LLD)](docs/LLD.md) - Technical implementation details, data hub logic, and chart rendering strategies.

## Installation and Setup

### Prerequisites
* Node.js (v18+)

### Steps

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open the provided localhost URL in your browser to access the dashboard.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.