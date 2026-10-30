# Calendar Spread Scanner

The **Calendar Spread** tab (`src/CalendarSpreadScanner.jsx`) finds ratio spreads whose two legs sit on **different
expiries**: the **short** leg on a near expiry and the **long** leg on a later one. It is the Ratio Spread scanner
(see [ratio_spread_explained.md](ratio_spread_explained.md)) with two expiry pickers and without the hedge leg.
It is a scanner only: the trading engine does not trade calendar spreads.

## Expiries

| Picker | Leg | Rule |
|---|---|---|
| **Short Expiry** | short (sold at the **bid**) | any listed expiry except the last |
| **Long Expiry** | long (bought at the **ask**) | only expiries **after** the short expiry |

Changing the short expiry keeps the chosen long expiry while it is still later, else picks the next one. Changing
the underlying reloads both, nearest first. **▶ Start Scan** subscribes to every option of both expiries
(REST backfill + WebSocket), and each ticker carries its expiry.

## How pairs are built

For each option type, every long from the long expiry is paired with every short from the short expiry:

- **Strike rule (same as the ratio spread):** call short at or above the long, put short at or below it.
  `strikeDiff = |short − long|` must be ≥ **Min Spread Width**; a width of `0` allows the same strike (a classic
  calendar).
- **ATM / OTM only:** calls at or above the ATM strike, puts at or below it. The ATM strike is the short expiry's
  strike nearest spot.
- Then the Ratio Spread scanner's checks, in the same order:
  1. fresh quotes (WS-confirmed in the last 120 s)
  2. IV edge (`|long ask IV − short bid IV|` ≥ Min IV Edge)
  3. spot distance and min short premium
  4. delta-neutral ratio (`long delta notional ÷ short delta notional`, to 0.25) within Max Delta Deviation and
     Max Short Ratio
  5. Dynamic ATM Scaling
  6. Max Net Debit on the scaled ratio
  7. Open Interest

  Results are sorted by long strike nearest spot, then by net premium.

## ATM pricing

Dynamic ATM Scaling and the ATM P&L / ROI columns price the legs at their own expiry. The long's "at ATM" value is
the **long expiry's** ATM-strike bid, and the short's is the **short expiry's** ask at ATM ± width. Both use current
market prices, the same proxy the Ratio Spread scanner uses, through `ResultTable`'s `priceSources` prop
(`{ buy, sell }` ticker maps).

> At the short expiry the long still has time value left, so the real P&L there is usually **higher** than the ATM
> P&L shown. Treat the column as an estimate.

**Req. Margin** = long premium × lot + capped short value ÷ leverage. The leverage comes from the **short** leg's
expiry, because it only divides the short value and a short's margin follows its own expiry: BTC 200x / ETH 100x
within the near-expiry window, at most 100x beyond it. It used to come from the long, which over-stated a
calendar's margin (a far long → 100x).

Call / Put Scaling above 100 applies the entered value minus 100 (350 → 250%), as in the Ratio Spread scanner.

## Filters

All Ratio Spread scanner filters apart from the hedge leg:

- Min Spread Width, Min IV Edge, Max Delta Deviation
- Min Short Premium, Max Net Debit, Min Spot Distance, Max Short Ratio
- Min ATM P&L / ROI
- Dynamic ATM Scaling (Call / Put %)
- Open Interest (Delta lock or cap)

## What it stores (this browser)

Kept apart from the Ratio Spread scanner, so the two never overwrite each other:

| Key | What |
|---|---|
| `vitti_calendar_scanner_config_v1` | current filters |
| `vitti_calendar_scanner_saved_v1` | saved settings: filters plus underlying and `short\|long` expiries; applying one reopens that market |
| `vitti_calendar_scanner_market_v1` | last underlying / short / long expiry, reopened after a page refresh |

It does **not** publish top spreads to the paper dashboard and has no **Send to window**.
