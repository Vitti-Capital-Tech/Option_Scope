# Low Level Design — OptionScope

This document outlines the technical implementation details of OptionScope.

---

## 1. Frontend Architecture (React)

The frontend is a single-page React application bundled with Vite.

### Core Files
- `src/main.jsx`: Entry point. Mounts the React application. React StrictMode is disabled to prevent double-mounting which causes issues with WebSocket connections and chart instance creation during development.
- `src/App.jsx`: The main controller. Handles state, fetching data, WebSocket management, and orchestrating the charts.
- `src/api.js`: Abstraction layer for all API interactions (REST and WebSocket).
- `src/index.css`: Vanilla CSS providing the dark theme and layout system.

### Imperative Chart Rendering
The most complex part of the architecture is how the charts are rendered. We use `lightweight-charts` v5. 

**The Problem:** React's declarative state model (where data is passed down as props causing re-renders) conflicts with `lightweight-charts`, which expects to be instantiated once on a stable DOM node and updated imperatively. If React re-renders the container, the chart instance is destroyed or detached, causing a blank screen.

**The Solution:**
1. **Always Mounted:** The `ChartPanel` components are rendered unconditionally in `App.jsx`. They are never unmounted or hidden using conditional rendering `{phase === 'ready' && <ChartPanel />}`.
2. **Overlay Approach:** When data is loading, a loading overlay is absolutely positioned *over* the charts using CSS `z-index`, hiding them without unmounting them.
3. **forwardRef & useImperativeHandle:** `ChartPanel` exposes an imperative API (`setData`, `update`, `clearData`) to the parent `App` via a `ref`. 
4. **Data Push:** When `App` receives new data from the REST API or WebSocket, it does not store the chart data in React state. Instead, it calls `ref.current.setData()` directly. This completely bypasses React's render cycle for chart updates, ensuring high performance and stability.

---

## 2. API Communication (`api.js`)

All communication with Delta Exchange is encapsulated in `api.js`.

### REST Data Fetching
- `loadProducts(underlying)`: Fetches `/v2/products`. Returns all available options contracts.
- `fetchCandles(symbol, resolution, start, end)`: Fetches `/v2/history/candles`. Requests are prefixed with `MARK:` to ensure mark prices are retrieved.
- **CORS Mitigation:** REST requests are sent to `http://localhost:5555` (the local proxy) instead of directly to Delta Exchange.

### WebSocket Live Feed
- `createWS(callSym, putSym, resolution, onCandle, onTicker, onStatus)`: Establishes a native WebSocket connection directly to `wss://socket.delta.exchange`. 
- **Subscriptions:** It subscribes to both `mark_price_candlestick_1m` (for candle updates) and `ticker` (for immediate real-time price updates in the sidebar).
- **Callbacks:** When messages arrive, the respective callbacks are fired, pushing data imperatively to the chart refs in `App.jsx`.

---

## 3. Proxy Server (`proxy.py`)

A minimal Flask application.

- **Route:** `/<path:endpoint>` catches all requests.
- **Forwarding:** It takes the requested endpoint, appends it to `https://api.india.delta.exchange/`, and forwards the GET request using the `requests` library.
- **Headers:** It attaches the `x-cors-api-key` header to the outgoing request and injects `Access-Control-Allow-Origin: *` into the response before sending it back to the browser.
- **State:** It is stateless and handles requests synchronously.

---

## 4. State Management (`App.jsx`)

React state is used solely for UI configuration, not for high-frequency chart data.

- `underlying`, `tf` (timeframe), `selExpiry`, `selStrike`: User configuration state.
- `products`, `expiries`, `strikes`: Metadata used to populate dropdowns.
- `phase`: Tracks whether the app is `idle`, `loading`, or `ready`. Controls the visibility of the loading overlay.
- `callPrice`, `putPrice`: The current mark prices displayed in the sidebar. These *are* stored in state because they are simple strings/numbers rendered as text, and React handles this efficiently.

When the user changes the expiry, an effect automatically finds the strike closest to the current spot price (At The Money) and selects it, minimizing manual configuration.
