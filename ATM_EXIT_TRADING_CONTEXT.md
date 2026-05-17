# ATM Exit Trading Page — Context File

## Project Structure
- Framework: React + Vite
- Styling: Vanilla CSS (`src/index.css`)
- DB: Supabase (`src/supabase.js`)
- Routing: `src/main.jsx` — page state (`charts`, `scanner`, `trading`)
- Existing pages: `App.jsx` (charts), `RatioSpreadScanner.jsx`, `PaperTrading.jsx`

## Task
Create a NEW page: `src/ATMExitTrading.jsx`
- Route key: `'atm-exit'`
- DO NOT modify `PaperTrading.jsx` or `RatioSpreadScanner.jsx` at all.
- Add route + nav link in `src/main.jsx` and in each page's navbar (like how PaperTrading links to scanner/charts).

---

## Entry Logic (Same as PaperTrading — copy it)
From `PaperTrading.jsx`:
- Uses `loadProducts`, `getExpiries`, `getStrikes`, `getSpotPrice`, `createTickerStream`, `getTickers` from `./api`
- Uses `normalizeIv`, `toFiniteNumber`, `matchesOptionType`, `formatTime`, `formatDateTime` from `./scannerUtils`
- Uses `useTabListener` from `./useTabSync`
- Uses `supabase` from `./supabase`
- Same `scanTickers()` logic (IV diff, ratio deviation, min sell premium, net premium, etc.)
- Same `calculateFee()` function
- Same `calcMargin()` function
- Same WebSocket ticker streaming via `createTickerStream`

### Entry Differences vs PaperTrading:
1. **Entry fires only when spot price has moved ≥ 0.5%** from the last entry spot price (per type: call/put separately). NOT every minute.
   - Track `lastEntrySpotRef` per type (`call`, `put`)
   - On each algo cycle, check: `Math.abs(currentSpot - lastEntrySpot) / lastEntrySpot >= 0.005`
   - Only allow new entries when this condition is met (or when there are 0 positions of that type)
2. **Strike diff between two long (buy) strikes must be ≥ 400** — already in PaperTrading rotation logic, but enforce at entry too:
   - `Math.abs(candidateLongStrike - existingLongStrike) >= 400` for all existing positions of same type

---

## Exit Logic (DIFFERENT from PaperTrading)
**100% ATM exit only — no partial exits.**
- Exit condition: `spotPrice >= buyLeg.strike` for calls, `spotPrice <= buyLeg.strike` for puts
- No stage-based partial exits (no 33%/50% splits)
- Keep expiry exit (2 min early)
- Keep rotation/top-3 exit logic (same as PaperTrading)

---

## Supabase Tables (NEW — 4 tables based on sell qty ranges)

### Table Names:
1. `atm_exit_qty_0_2_5` — sell qty <= 2.5
2. `atm_exit_qty_2_5_5` — sell qty 2.5 to 5
3. `atm_exit_qty_5_7_5` — sell qty 5 to 7.5
4. `atm_exit_qty_7_5_10` — sell qty 7.5 to 10

### Each table schema (columns):
```sql
strike_diff         NUMERIC       -- e.g. 800, 1000, 1200
trade_count         INTEGER       -- number of trades in this bucket
avg_margin          NUMERIC
median_margin       NUMERIC
avg_pnl             NUMERIC       -- avg realized net PnL
avg_net_premium     NUMERIC       -- avg (entryBuyPrice - sellQty * entrySellPrice), negative = credit
avg_fees            NUMERIC       -- avg total fees
underlying          TEXT          -- 'BTC' or 'ETH'
type                TEXT          -- 'call' or 'put'
updated_at          TIMESTAMPTZ
```

**Active positions table:** `atm_exit_active_positions` (same schema as PaperTrading's `active_positions`)
**Trade history table:** `atm_exit_trade_history` (same schema as PaperTrading's `trade_history`)

---

## UI Requirements

### Analytics Section (below Trade History)
Show 4 expandable/tab sections, one per qty bucket:
- **Columns:** Strike Diff | Trade Count | Avg Margin | Median Margin | Avg PnL | Avg Net Premium (credit shown green, debit shown red) | Avg Fees
- **Toggle:** Avg / Total toggle switch (when Total, show sum instead of avg for PnL and fees)
- Group rows by `strike_diff` values (e.g. 400, 500, 600, 800, 1000, 1200...)
- No strikes column needed

### After each trade closes:
- Compute which qty bucket it falls into
- Upsert into the appropriate `atm_exit_qty_*` table, updating aggregates

---

## Key Refs from PaperTrading.jsx

### Config state (copy same defaults):
```js
minStrikeDiff: 800, minIvDiff: 5, maxRatioDeviation: 0.25,
minSellPremium: 10, maxNetPremium: 20, minLongDist: 500, maxSellQty: 10
```

### Supabase config table: `atm_exit_config` (same schema as `paper_trading_config`)

### Fee calculation:
```js
const calculateFee = (price, spot, qty, lotSize) => {
  if (!price || !spot) return 0;
  const feePerUnit = Math.min(0.035 * price, 0.0001 * spot);
  return feePerUnit * qty * lotSize;
};
```

### Margin calculation:
```js
const calcMargin = (buyPrice, buyLot, spot, sellQty, sellLot = 1) => {
  const longMargin = (buyPrice || 0) * (buyLot || 1);
  const shortValue = (spot || 0) * (sellQty || 0) * sellLot;
  let leverage = 200;
  if (shortValue <= 200000) leverage = 200;
  else if (shortValue <= 450000) leverage = 100;
  else if (shortValue <= 950000) leverage = 50;
  else leverage = 25;
  return longMargin + (shortValue / leverage);
};
```

---

## main.jsx Changes Needed

```jsx
// Add import
import ATMExitTrading from './ATMExitTrading.jsx'

// Add route div
<div style={{ display: page === 'atm-exit' ? 'block' : 'none', height: '100%', width: '100%' }}>
  <ATMExitTrading onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
</div>
```

---

## Navbar in ATMExitTrading.jsx
Same style as PaperTrading navbar with buttons for: Charts | Ratio Spread | Paper Trading | ATM Exit (active)

---

## Notes
- Page name: "ATM EXIT TRADING" or "ATM Exit"
- Same live WS ticker logic as PaperTrading
- Same cross-tab sync pattern (`useTabListener`)
- Same dark/light theme support
- No backtesting or AI review features needed
- Supabase config ID for this page: `'atm-exit-global'`
- Keep all existing pages untouched
