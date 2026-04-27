# High Level Design — OptionScope

## What This System Does

OptionScope is a real-time dashboard for monitoring options contracts traded on Delta Exchange. It allows a trader to select a specific options contract (by underlying asset, expiry date, and strike price) and view live candlestick charts showing:

- The price of the **Call** option over time
- The price of the **Put** option over time
- The **Combined Premium** — the sum of Call and Put prices at every point in time.
- **Live Greeks**: Real-time Delta, Gamma, Vega, Theta, Rho, and IV for both legs.

Users can toggle between **Mark Price** (standard for valuation) and **Last Traded Price (LTP)** for execution-focused monitoring.

---

## System Components

```
Browser (React App)
      |
      |-- REST API calls (historical & corrective) --> /api Proxy Rewrite
      |                                                     |
      |                                                     --> Delta Exchange REST API
      |
      |-- WebSocket (live telemetry) --> Delta Exchange WebSocket Server
            |
            |-- Ticker (Live Prices)
            |-- Greeks (Delta, Gamma, etc.)
            |-- Trades & L2 Book (Data Hub)
```

### 1. React Frontend (Browser)
The UI is a purely client-side application. It utilizes a **Data Hub** pattern to store incoming WebSocket streams (Greeks, Ticker, Trades) without overwhelming the React render cycle. Charts are rendered using `lightweight-charts` with an imperative update strategy.

### 2. API Rewrites (Zero-Backend)
The app is entirely serverless. It bypasses CORS restrictions using edge-level rewrites:
- **Local:** Vite proxy (`vite.config.js`).
- **Production:** Vercel edge rewrites (`vercel.json`).

### 3. Data Integrity Engine
To solve the common problem of WebSocket vs. REST data discrepancies:
- **Live Polling:** Every 5 seconds, the app fetches the *current* forming candle from REST to ensure O/H/L accuracy.
- **Full History Refresh:** Every time a candle closes (e.g., at the top of the hour for 1h charts), the app waits 15 seconds for the exchange to finalize the record and then performs a silent background refresh of the entire chart history.

---

## Data Flow

### On startup
1. The app fetches available products and calculates the **ATM (At-The-Money)** strike based on the current spot price of the underlying asset.
2. The UI populates dropdowns and auto-selects the ATM strike for the nearest expiry.

### During Monitoring
1. **Bootstrap:** Fetches the last 300 historical candles.
2. **WebSocket Feed:** Listens for `v2/ticker` (prices/Greeks) and `mark_price` updates.
3. **Imperative Updates:** Prices are pushed directly to chart refs, bypassing React's state to ensure 60fps performance.
4. **Auto-Correction:** The wall-clock scheduler triggers REST refreshes at every candle boundary to ensure the "Final" candle on the chart is 100% accurate.

---

## Technology Choices

| Component      | Technology       | Reason |
|----------------|------------------|--------|
| Frontend       | React (Vite)     | Modular UI and efficient state management for configuration |
| Charts         | lightweight-charts | High-performance financial visualization |
| Live data      | WebSocket        | Sub-second latency for prices and Greeks |
| Data Hub       | React Refs       | Prevents unnecessary re-renders for high-frequency WebSocket data |
| Styling        | Vanilla CSS      | Precision control over the "Terminal" aesthetic |
