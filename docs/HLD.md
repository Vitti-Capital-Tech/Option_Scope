# High Level Design — OptionScope

## What This System Does

OptionScope is a real-time dashboard for monitoring options contracts traded on Delta Exchange. It allows a trader to select a specific options contract (by underlying asset, expiry date, and strike price) and view live candlestick charts showing:

- The mark price of the **Call** option over time
- The mark price of the **Put** option over time
- The **Combined Premium** — the sum of Call and Put mark prices at every point in time (this represents the total cost of holding both legs of a straddle or strangle position)

---

## Who This Is For

This tool is built for options traders who want to monitor their straddle or strangle positions in real time without relying on broker interfaces, which are often slow or limited in charting capability.

---

## System Components

```
Browser (React App)
      |
      |-- REST API calls (historical data) --> /api/ Rewrite (Vite/Vercel)
      |                                               |
      |                                               --> Delta Exchange REST API
      |
      |-- WebSocket (live updates) --> Delta Exchange WebSocket Server
```

### 1. React Frontend (Browser)

The user interface runs entirely in the browser. It is built with React and displays:

- A configuration panel (asset, expiry, strike, timeframe)
- Three live candlestick charts rendered using the lightweight-charts library
- Real-time price updates in the sidebar

### 2. API Rewrites (Vite & Vercel)

Browsers block direct REST requests to external APIs that don't explicitly allow them (CORS restrictions). Instead of running a dedicated backend server, we use API rewrites:
- **Local Development:** Vite's dev server (`vite.config.js`) proxies `/api` requests to Delta Exchange.
- **Production:** Vercel's Edge Network (`vercel.json`) transparently rewrites `/api` requests.
This completely eliminates the need for a backend server, making the app purely serverless.

### 3. Delta Exchange REST API

Used to fetch:
- The list of available options contracts (products)
- Historical candlestick data for mark prices

### 4. Delta Exchange WebSocket

A persistent real-time connection that pushes live candlestick updates every time a new price is recorded. This is what makes the charts update without needing to refresh the page.

---

## Data Flow

### On startup
1. The app loads and immediately fetches all available options contracts from the Delta API.
2. The expiry date and strike price dropdowns are populated from this data.
3. The strike closest to the current market price (ATM — At The Money) is automatically selected.

### When "Start Monitoring" is clicked
1. The app fetches the last 300 historical candles for both the Call and Put contracts.
2. The three charts are drawn: Call, Put, and Combined.
3. A WebSocket connection is opened to Delta Exchange.
4. Every time a new candlestick update arrives, the charts update in real time.
5. The sidebar prices (Call, Put, Combined) update from both WebSocket candle messages and ticker messages.

---

## Technology Choices

| Component      | Technology       | Reason |
|----------------|------------------|--------|
| Frontend       | React (Vite)     | Component model makes chart management clean and maintainable |
| Charts         | lightweight-charts | Built for financial data, handles thousands of candles efficiently |
| Live data      | WebSocket        | Lower latency than polling REST every second |
| Styling        | Vanilla CSS      | No framework overhead, full control over the dark terminal aesthetic |
