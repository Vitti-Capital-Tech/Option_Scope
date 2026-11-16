# Glossary

Terms used across the OptionScope docs and code. Each entry links to where it is explained
in full.

## Trading terms

| Term | Meaning |
|---|---|
| **Ratio spread** | The core position: **buy** 1 lot-size of a nearer-to-ATM option (the *long*) and **sell** a larger quantity of a farther OTM option of the same type and expiry (the *short*). Call spreads sit above spot, put spreads below. [ratio_spread_explained.md](ratio_spread_explained.md) |
| **Long leg / short leg** | The bought (`buy_leg`) and sold (`sell_leg`) option of a spread. Longs are priced at the **ask**, shorts at the **bid** (execution-realistic pricing) |
| **Hedge leg** | Optional third long, farther OTM than the short, making a long / short / long triplet. Tag `-HB` at entry, `-HX` at exit. [paper_trading_explained.md → Hedge Leg](paper_trading_explained.md#hedge-leg--per-spread-3rd-long-long--short--long-triplet) |
| **ATM** | At-the-money: the listed strike nearest spot |
| **ITM / OTM** | In- / out-of-the-money |
| **Strike width / strike diff** | Distance between the long and short strikes |
| **Ratio** | Short quantity ÷ long quantity, sized so the two legs' delta notionals roughly offset |
| **ATM ratio** | The ratio the same spread would have if its long sat at ATM (short at ATM ± strike diff). Drives ATM Ratio Scaling and the partial scale-down |
| **ATM P&L / ATM ROI** | Projected P&L (and return on margin) if spot moved to the long strike. Candidates are ranked by ATM ROI |
| **ATM Edge Floors** | `min_atm_pnl` / `min_atm_roi` — minimum ATM P&L / ROI for a candidate |
| **Bracket-and-average** | When the exact ATM / target strike is missing from the feed, average the nearest listed strikes below and above it (BTC ±1000, ETH ±50 points) |
| **IV / IV edge** | Implied volatility. Long uses `ask_iv`, short uses `bid_iv`. *Min IV Edge* = minimum short IV − long IV |
| **DTE** | Days to expiry. Each schedule window picks its expiry by DTE (paper: 7 = weekly Friday, 30 = monthly last-Friday) |
| **Net premium / Max Net Debit** | Cash paid (debit) or received (credit) at entry; Max Net Debit caps it |
| **Margin** | Collateral for the short side, estimated with per-underlying leverage (`leverageFor()`: BTC 200×, ETH 100×; expiries more than 48 h out are capped at 100×) |
| **Short-notional cap** | Upper bound on a position's short notional, tied to leverage (`shortNotionalCap()`): **$195k** at 200× (BTC, expiry within 48 h), **$95k** at 100× (ETH, or any expiry more than 48 h out). Often called the "$195K cap" in older text |
| **Spot-cross exit (ATM / ITM / OTM)** | Catch-all exit when spot crosses the long strike ± `exit_points` |
| **Short-leg-only exit** | Phase 1 of an exit: buy back only the short once its ask ≤ `short_exit_price` (default 1.1). Tag `-SE` (resting order on live: `-SEX`) |
| **Long-only / laddered exit** | Phase 2: sell the remaining long in slices as its bid recovers. Tag `-LE-<stage>` |
| **Partial scale-down** | Selling part of the long when the live ATM ratio rises enough above the position's own ratio. Tag `-PE-<lots>` |
| **SL/TP decoy** | On live, the exchange SL/TP bracket is placed `sl_tp_decoy_diff` points beyond the real exit level (in the harder-to-trigger direction) because Delta appears to leak resting levels; the engine fires the real exit itself, and the decoy bracket is only a backstop. [paper_trading_explained.md → SL/TP Decoy](paper_trading_explained.md#sltp-decoy-sl_tp_decoy_diff-migration-031032) |
| **Brackets** | Exchange-native stop-loss / take-profit orders on Delta that protect live positions if the engine is down |
| **Expiry settlement** | Positions are closed ~2 min before expiry; any still open 10 min after are force-closed and back-dated |
| **OI limit / OI lock** | Delta's market-wide open-interest cap per strike; at the cap the strike becomes reduce-only (`only_reduce_only_orders_allowed`) |
| **Reduce-only** | An order that may only shrink an existing position |
| **Trading day** | Starts at **17:30 IST** for schedules / trade days. The Daily Report uses Delta's day instead: **05:30 IST** (00:00 UTC) |

## System terms

| Term | Meaning |
|---|---|
| **Account** | A row in `paper_trading_accounts`; `mode` is `paper` or `live` and is fixed after creation |
| **Armed / Disarmed** | A live account with `live_enabled = true` sends real orders (unless dry-run is on). Disarmed = no new real orders |
| **Dry-run** | `DELTA_LIVE_DRYRUN=true` (default): live orders are only logged |
| **Paused** | Account opens no new entries; exits continue |
| **Strategy version (v1 / v2)** | Per-account switch: paper runs experimental **v2**, live the stable **v1**. Features are validated on v2 and then promoted |
| **Schedule window** | A named IST time range that overrides filters (DTE, caps, exits, hedge…) while active. [LLD.md §12](LLD.md#12-time-based-filter-schedules) |
| **Control Panel** | Account-level (global) filters, edited with Apply / Reset |
| **Account group / leader** | Accounts sharing one set of settings; saving on the **leader** copies to the others (`sync_account_group`) |
| **Combined cap / split %** | `max_combined_positions` positions in total, divided between calls and puts by `combined_split_pct` |
| **Balance allocation %** | Share of the balance the engine may use as margin; the rest is buffer |
| **Full deploy** | Once-a-day fill that uses the remaining budget on fewer, larger positions |
| **Entry governor** | Shared, first-come-first-serve top-of-book depth budget across all accounts in one entry wave. [paper_trading_explained.md](paper_trading_explained.md#cross-account-entry-governor-paper--live) |
| **Entry wave** | All accounts scanning and entering at the same minute boundary |
| **Chase / modify** | Re-pricing an unfilled live entry order toward the market |
| **Reconcile / orphan** | Comparing tracked positions with Delta's. An *orphan* is a position on Delta the engine does not track (or vice versa) |
| **Heartbeat** | `engine_heartbeat` row each account engine updates every 30 s; the dashboard turns red when it goes stale |
| **Fenced cycle** | An evaluation cycle stuck past `EVAL_HANG_MS`, invalidated so it can no longer write |
| **Ticker hub** | One shared Delta WebSocket per underlying for all accounts (`engine/lib/tickerHub.js`) |
| **Live snapshot** | `live_exchange_state` — positions, orders, fills, balances copied from Delta for the dashboard |

## `trade_id` / `client_order_id` tags

Deterministic suffixes appended to the position id, so every exit is booked at most once.

| Tag | Meaning |
|---|---|
| *(none)* | Full exit of the pair |
| `-SE` | Short-leg-only exit |
| `-SEX`, `-SEX-R<n>` | Resting short buy-back order (live); `-R<n>` = re-placed |
| `-LEX-…` | Live ladder order (bid-cross model) |
| `-PEX-…` | Partial scale-down reduce-only market close (live) |
| `-LE-<stage>` | Long ladder slice |
| `-PE-<lots>` | Partial scale-down |
| `-EB` / `-ES` | Entry buy (long) / entry sell (short) order (live) |
| `-HB` | Hedge entry order |
| `-HX`, `-HX<n>` | Hedge exit (market), retry *n* |
| `-HXL`, `-HXL<n>` | Hedge exit resting limit, retry *n* |

Full taxonomy: [LLD.md §13.9](LLD.md#139-client_order_id-tag-taxonomy).
