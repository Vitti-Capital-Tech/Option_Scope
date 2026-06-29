# Paper Trading Engine — Complete Logic Explained

This document explains **every** logic and condition in the Paper Trading engine in the simplest terms possible, from startup to shutdown.

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Multi-Account Supervisor](#multi-account-supervisor)
3. [Engine Startup (Boot Sequence)](#engine-startup)
4. [The Heartbeat (1-Second Loop)](#the-heartbeat)
5. [How Spreads Are Found (Scanning)](#how-spreads-are-found)
6. [Entry Filters (What Makes a Good Spread)](#entry-filters)
7. [How Entries Are Placed](#how-entries-are-placed)
8. [Exit Priority Tree](#exit-priority-tree)
9. [Partial Exit / Scaling Logic](#partial-exit--scaling-logic)
10. [Short-Leg-Only Exit ($1.1)](#short-leg-only-exit)
11. [Long-Only Laddered Exit](#long-only-laddered-exit)
12. [Manual Exit (Liquidation)](#manual-exit-liquidation)
13. [Safety Guards Summary](#safety-guards-summary)
14. [Diagnostic Logging (0 Candidates)](#diagnostic-logging-0-candidates)
15. [Config Synchronization](#config-synchronization)
16. [Time-Based Filter Schedules](#time-based-filter-schedules)
17. [Frontend Dashboard Architecture](#frontend-dashboard-architecture)

---

## The Big Picture

Think of the engine as a **robot trader** that runs 24/7 on a server. It:

1. Watches live Bitcoin/Ethereum option prices via WebSocket
2. Every **1 second**, checks if any existing positions need to be exited or scaled
3. Every **1 minute**, also looks for new positions to enter
4. Writes everything to a Supabase database so the UI dashboard can display it in real time

The strategy is a **ratio spread** — you buy 1 option (the long/buy leg) and sell multiple options at a different strike (the short/sell leg). The goal is to collect more premium from selling than you pay for buying.

---

## Multi-Account Supervisor

**File**: [paperTradingEngine.js:L1414-L1500](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js#L1414-L1500)

The entry point is `startPaperTradingEngine()`. It acts like a **manager** that:

1. Fetches all active accounts from `paper_trading_accounts` table
2. Starts an **independent engine loop** for **all accounts in parallel** using `Promise.allSettled`
3. Listens for account changes in real-time:
   - **New account added** → starts a new engine
   - **Account deactivated** → stops its engine
   - **Account updated** (e.g. name or status changes) → updates the running engine's state

Each account runs in complete isolation — its own WebSocket, its own positions, its own config.

> [!TIP]
> **Parallel Startup**: All accounts start simultaneously via `Promise.allSettled`. With 10 accounts, startup time is ~3 seconds (previously ~30 seconds with sequential `for...await`). `allSettled` is used instead of `Promise.all` so that one account's startup failure does not block the others.

---

## Engine Startup

**File**: [paperTradingEngine.js](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js)

When an engine starts for an account, it runs these steps in order:

| Step | What Happens | Why |
|------|-------------|-----|
| 1 | **Load config** from `paper_trading_config` table (with retries) | Gets filter settings. Retries up to 10 times (500ms delay) to avoid database duplicate key race conditions during concurrent frontend config inserts. |
| 2 | **Load products** from Delta Exchange API | Gets the list of all available option contracts |
| 3 | **Auto-select expiry** if not set or expired | Picks the nearest valid expiry date meeting the `daysToExpiry` threshold |
| 4 | **Fetch spot price** | Gets current BTC/ETH price |
| 5 | **Load active positions** from Supabase | Restores any positions from a previous run |
| 6 | **Backfill tickers** via REST API | Pre-loads option prices so we don't start with empty data. If a ticker has a valid bid/ask price, its `bidUpdatedAt`/`askUpdatedAt` is set to `Date.now()` so it is treated as fresh for the first scan. WS live quotes overwrite these timestamps as they arrive. |
| 7 | **Start WebSocket** | Connects to Delta Exchange for real-time price streaming |
| 8 | **Start heartbeat** | Writes a "I'm alive" signal to the DB every few seconds |
| 9 | **Subscribe to config changes** | Listens for when you change filters in the UI |

> [!NOTE]
> If no config row exists for this account after the 10-retry loop, the engine **auto-creates one** with default values (BTC, min strike diff 800, etc.).

---

## The Heartbeat (1-Second Loop)

**File**: [paperTradingEngine.js](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js)

After startup, four timers run continuously, all wrapped inside **try-catch** blocks to prevent a failure in one timer from blocking subsequent ticks or other accounts:

| Timer | Interval | Purpose |
|-------|----------|---------|
| **Evaluation loop** | Every 1 second | The core brain — evaluates exits and entries |
| **Spot price poll** | Every 10 seconds | Updates BTC/ETH spot price via REST API |
| **Product refresh** | Every 5 minutes | Refreshes option contracts and handles automatic expiry rollover if needed |
| **Positions sync** | Every 2 minutes | Re-fetches positions from DB as a safety fallback (previously 30s — reduced since Realtime handles real-time sync) |

> [!TIP]
> **Real-time Spot updates**: In addition to the periodic REST API fallback poll (every 10 seconds), the engine streams the perpetual contract (`BTCUSD` or `ETHUSD`) directly over the WebSocket ticker stream. This allows the engine to update the underlying spot price instantly as trades occur.

### Product Refresh & Expiry Rollover

Every 5 minutes (as well as during startup and configuration updates), the engine refreshes the list of active option products. As part of this sequence, it validates the active expiry selection:

1. **Stale Expiry Detection**: It computes the remaining days of the current `config.expiry`. If it is less than the configured `daysToExpiry` threshold, the expiry is flagged as stale/invalid.
2. **Auto-Rollover**: The engine automatically scans all available expiries on the exchange and updates `config.expiry` to the nearest future date that satisfies the `daysToExpiry` requirement, saving this change back to the database.
3. **Scanner Rollover vs. Position Rollover**: 
   - **Scanner Rollover**: Changing `config.expiry` only shifts the engine's scanning focus. In the next minute loop, it runs a completely fresh scan for option spreads on the new expiry and will only enter trades if they meet all configuration parameters.
   - **No Position Rollover**: Active positions are never carried forward or rolled over. Instead, they are always exited 2 minutes prior to their expiration date and recorded as settled in the trade history, starting fresh.

### The Evaluation Loop Decision

Every 1 second, the engine asks: **"Has a new minute started since my last full evaluation?"**

- **Yes** → Run a **full evaluation** (check exits + scan for new entries)
- **No** → Run an **exit-only evaluation** (only check exits, no new entries)

This means:
- **Exits** are checked every **1 second** (fast reaction to price moves)
- **New entries** are checked every **1 minute** (no need to rush entries)

### Pre-Flight Checks & Auto-Healing

Before any evaluation runs, these guards must pass:

1. **`isEvaluating` mutex check** — prevents overlapping evaluations. If the previous run is still active, it skips.
   - *Hang Timeout Guard*: If `isEvaluating` has been active for more than **60 seconds** (e.g. database query is hung indefinitely), the engine logs a fatal error and crashes the process (`process.exit(1)`). This allows PM2 to auto-restart the engine container cleanly.
2. **Spot price exists** — can't evaluate without knowing the underlying price.
3. **Spot not stale** — if the spot price hasn't been updated in **120 seconds**, the evaluation is skipped.
   - *Stale WebSocket Auto-Healing*: When the spot price remains stale for >120 seconds, the engine automatically forces a WebSocket reconnection (`startWebSocket()`) to heal silent TCP drops common on VPS nodes.
4. **Tickers exist** — at least one option price must be in the cache.

---

## How Spreads Are Found (Scanning)

**File**: [utils.js:L73-L182](file:///c:/Users/ASUS/Documents/Option_Scope/engine/lib/utils.js#L73-L182)

The `scanTickers()` function is the **spread finder**. It works like this:

### Step 1: Split options into calls and puts

- **Call tickers** = all calls with strikes **at or above** ATM (At The Money)
- **Put tickers** = all puts with strikes **at or below** ATM

> [!TIP]
> ATM = the strike price closest to the current spot price. If BTC is at $105,000, the ATM strike might be $105,000.

### Step 2: O(N²) pair scan

For each option type, the scanner tries **every possible pair** of options and checks if they form a valid spread. It sorts all tickers by strike price, then pairs each one with every other one.

For **calls**: the lower-strike option is the buy leg, the higher-strike is the sell leg.
For **puts**: the higher-strike option is the buy leg, the lower-strike is the sell leg.

---

## Entry Filters (What Makes a Good Spread)

Every candidate pair must pass **all** of these filters to be considered:

| # | Filter | Config Key | What It Means |
|---|--------|-----------|---------------|
| 1 | **Strike Difference** | `minStrikeDiff` (default: 800) | The two strikes must be at least 800 points apart |
| 2 | **Fresh Quotes** | — (hardcoded 120s) | Both the buy Ask and sell Bid prices must have been updated within the last **120 seconds**. After startup, REST-backfill data now gets `Date.now()` timestamps if a valid price exists — allowing the first scan to use backfill data immediately. As WS live quotes arrive, they overwrite these timestamps. Tickers with no bid/ask price still get timestamp = 0 and are rejected. |
| 3 | **IV Difference** | `minIvDiff` (default: 5) | The implied volatility difference between the two options must be ≥ 5% |
| 4 | **Min Long Distance** | `minLongDist` (default: 500) | The buy leg's strike must be at least 500 points away from spot price |
| 5 | **Min Sell Premium** | `minSellPremium` (default: $10) | The sell leg's bid price must be at least $10 |
| 6 | **Ratio Deviation** | `maxRatioDeviation` (default: 0.25) | The premium ratio and delta notional ratio must not deviate by more than 25% |
| 7 | **Max Sell Qty** | `maxSellQty` (default: 10) | The sell quantity (ratio) must not exceed 10 |
| 8 | **Max Net Premium** | `maxNetPremium` (default: $20) | The net premium debit cannot exceed $20. **ATM Ratio Scaling is applied first**, so this is checked against the *scaled* short quantity (i.e., `scaledSellQty × sellPrice - buyPrice ≥ -$20`). When scaling is disabled, `scaledSellQty` equals the natural `sellQty`. |
| 9 | **Days to Expiry** | `daysToExpiry` (default: 0) | The option expiry date must be at least this many days away from the current time. Options closer to expiry are rejected. |
| 10 | **Max Calls (#)** | `numberOfCalls` (default: 3) | Maximum **full-spread** calls allowed concurrently. Only positions with an active short leg (`sellQty > 0`) count — long-only held positions do **not** count toward the cap. Re-applied at entry and whenever a schedule window changes the value. |
| 11 | **Max Puts (#)** | `numberOfPuts` (default: 3) | Maximum **full-spread** puts allowed concurrently. Same counting rule as Max Calls — held long-only positions are excluded from the cap. |
| 12 | **ATM Ratio Entry** | `atmRatioScaling` (default: true) | Checkbox toggle to enable scaling of entry sell quantities based on ATM strike option prices. |
| 13 | **Call ATM Pct (%)** | `atmRatioPctCall` (default: 50) | The scaling percentage for ATM ratio adjustments on call spreads. |
| 14 | **Put ATM Pct (%)** | `atmRatioPctPut` (default: 25) | The scaling percentage for ATM ratio adjustments on put spreads. |
| 15 | **Spot Diff (%)** | `spotDiff` (default: 0.5) | The spot diff required for the next entry in the Active Positions table. |
| 16 | **Exit Type** | `exitType` (default: 'ATM') | Option exit type parameter: `ATM`, `ITM`, or `OTM` |
| 17 | **Exit Points** | `exitPoints` (default: 0) | Point offset threshold from the buy strike required to exit the position (applicable for ITM/OTM exit types) |
| 18 | **Leg Swap Net Premium** | `legSwapNetPremium` (default: 0) | ⚠️ **Deprecated / unused.** Leg swaps have been removed from the engine. The config field is still loaded for backward compatibility but no longer affects behaviour. |

### How the Sell Quantity (Ratio) Is Calculated

```
rawQty = buyDeltaNotional / sellDeltaNotional
sellQty = round to nearest 0.25, minimum 1
```

This gives a **delta-neutral** ratio. If the buy leg has 3× the delta notional of the sell leg, you'd sell ~3 contracts.

#### ATM Ratio Scaling Happens Inside the Scan (Before the Max Net Premium Check)

**File**: [utils.js](file:///c:/Users/ASUS/Documents/Option_Scope/engine/lib/utils.js) (`scanTickers`)

When `atmRatioScaling` is enabled, `scanTickers` derives the ATM ratio from the intrinsic prices at the ATM strike and scales the sell quantity up toward it — **before** applying the Max Net Premium (max debit) filter:

```
buyIntrinsic   = price at ATM strike (bid)
sellIntrinsic  = price at (ATM strike ± strikeDiff) (ask)
atmRatio       = round(buyIntrinsic / sellIntrinsic to nearest 0.25)
pct            = call ? atmRatioPctCall : atmRatioPctPut
diff           = max(0, atmRatio - sellQty)
scaledSellQty  = max(sellQty, round(sellQty + (pct/100) × diff to nearest 0.25))
```

The Max Net Premium check then uses `scaledSellQty × sellPrice - buyPrice`. Because scaling up the short quantity raises the net premium (more credit / less debit), this ordering lets candidates that would otherwise fail the max-debit cap on their natural ratio survive once scaled.

> [!NOTE]
> The natural `sellQty` is **kept unchanged** in the candidate. The scaled value is used only for the max-debit filter here. The actual entry quantity is recomputed from the natural `sellQty` at entry time using **fresh** ATM prices (see [Entry pricing](#after-scanning-atm-pnl-filter) and the entry block in `paperTradingEngine.js`), so there is **no double-scaling** — the scale formula is evaluated independently per stage, never compounded.

### After Scanning: ATM PnL Filter

**File**: [paperTradingEngine.js](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js)

After `scanTickers` produces candidates, each one gets an **ATM PnL check**:

> "If we entered this spread now and the price immediately moved to ATM, would we make at least the minimum required ATM P&L?"

This simulates: _What's the profit if spot moves to the buy strike?_ 

To maintain consistency when **ATM Ratio Scaling** is enabled, both the scanner filter and UI adjust the minimum required ATM P&L threshold dynamically:
- **ATM Ratio Scaling Disabled**: Spreads must have `ATM PnL >= $50.00`.
- **ATM Ratio Scaling Enabled**: The threshold is reduced proportionally to the scaling percentage to account for the larger short leg ratio:
  - **Call Spreads**: `Min Required = 50 * (1 - config.atmRatioPctCall / 100)` (e.g., a `50%` scaling value reduces the required floor to **`$25.00`**).
  - **Put Spreads**: `Min Required = 50 * (1 - config.atmRatioPctPut / 100)` (e.g., a `25%` scaling value reduces the required floor to **`$37.50`**).

Only spreads that meet this adjusted minimum floor survive the filter.

### Deduplication & Ranking

1. Group by buy strike — if multiple spreads share the same buy strike:
   - Keep the one with the **highest ROI** (primary candidate).
   - If this highest ROI candidate conflicts with any of your currently active positions (other than itself), ALSO keep the next best **non-conflicting fallback candidate** for that same buy strike (if one exists). This allows normal entries to execute on non-conflicting spreads even when the primary highest ROI spread is blocked by active positions.
2. Sort by **distance to ATM** (closest first)
3. Take the top **10 calls + 10 puts** maximum (or higher if the configured `numberOfCalls`/`numberOfPuts` is set to more than 10, ensuring candidates always cover your max limits).

> [!IMPORTANT]
> **Why we keep both the primary and a non-conflicting fallback candidate:** normal entries require candidates that do **not** conflict with any active position strikes. If we only kept the single highest-ROI candidate per buy strike and it conflicted with an active position, we'd be locked out of entering any trade on that buy strike even when other non-conflicting spreads existed. Keeping a fallback prevents that lockout. (This is also what lets a freed slot — after a short-leg exit — be filled by the next-best closest-to-ATM spread.)

---

## How Entries Are Placed

**File**: [paperTradingEngine.js](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js)

Once we have the filtered, ranked list of candidate spreads (`uniqueTopSpreads`), the engine tries to open new positions. Each candidate must pass these checks **in order**:

### Guard 1: Expiry Buffer
```
If less than 5 minutes until expiry → SKIP
```
No point entering a trade that's about to expire.

### Guard 2: Days to Expiry Guard
```
If daysRemaining < daysToExpiry → SKIP
```
Requires the option's expiry to be at least `daysToExpiry` days away from the current time.

### Guard 3: Buy Strike Conflict (Local)
```
If any existing or newly-staged position already has this buy strike → SKIP
```
Prevents duplicate buy strikes within the same option type.

### Guard 4: Sell Strike Conflict (Local)
```
If any existing FULL-SPREAD or newly-staged position already has this sell strike → SKIP
```
Prevents duplicate sell strikes within the same option type. **Long-only held positions are ignored here** (`sellQty > 0` filter) — their short leg is gone, so their old sell strike no longer blocks new entries. (The buy-strike conflict above still applies to held longs, since their long leg is still live at that strike.)

### Guard 5: Portfolio Cap (Local)
```
If there are already `config.numberOfCalls` (calls) / `config.numberOfPuts` (puts) FULL-SPREAD positions of this type → SKIP
```
The cap counts only **full spreads** (`sellQty > 0`). Long-only held positions do **not** count, so each short-leg exit frees a slot for a new closer-to-ATM spread. The total rows in the Active Positions table can therefore exceed the cap (full spreads + held longs); the cap limits only the full spreads. The same `sellQty > 0` rule is enforced again at the DB level (`.gt('sell_qty', 0)`) before insert.

### Guard 6: ATM Ratio Scaling (Optional)
If `atmRatioScaling` is enabled in config:
```
liveAtmRatio = ATM buy price / ATM sell price
diff = max(0, liveAtmRatio - baseRatio)
adjustedRatio = baseRatio + (pct% × diff)
```
This lets you capture a percentage (e.g. 50%) of the extra ratio available at ATM strikes.

> [!NOTE]
> This is the **entry-time** scaling, computed from the natural `sellQty` using **fresh** ATM prices at the moment of entry. It is the same formula used during the scan for the [Max Net Premium filter](#how-the-sell-quantity-ratio-is-calculated), but evaluated independently — both stages start from the natural `sellQty`, so the scale is never compounded.

### Guard 7: $200K Short Value Cap
```
shortValue = spotPrice × sellQty × sellLotSize
If shortValue ≥ $200,000 → scale down both lot size and sell qty proportionally
```
Ensures no single position has more than $200K notional exposure on the short side.



### Guard 8: DB-Level Count Guard
```
Query: SELECT count(*) FROM active_positions WHERE type = X AND account_id = Y
If count ≥ `config.numberOfCalls` (for calls) or `config.numberOfPuts` (for puts) → BLOCK
```
Double-check against the **database** (not just local memory) to prevent race conditions.

### Guard 9: DB-Level Buy Strike Uniqueness
```
Query: SELECT * FROM active_positions WHERE buy_strike = X AND type = Y AND account_id = Z
If exists → BLOCK
```

### Guard 10: DB-Level Sell Strike Uniqueness
```
Query: SELECT * FROM active_positions WHERE sell_strike = X AND type = Y AND account_id = Z
If exists → BLOCK
```

> [!IMPORTANT]
> Guards 8-10 are **database-level guards** that act as a second safety net. Even if the in-memory checks pass, the DB checks can still block an entry. This prevents duplicate positions if two evaluation cycles overlap or if the engine restarts.

### Entry Pricing

- **Buy price** = the live **Ask** (you're buying, so you pay the asking price)
- **Sell price** = the live **Bid** (you're selling, so you receive the bid price)

This is **execution-realistic** — no cheating with mid-prices.

---

## Exit Priority Tree

**File**: [paperTradingEngine.js:L420-L1022](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js#L420-L1022)

When evaluating exits, positions are processed in a specific order: **worst-first** (farthest from ATM). This ensures we exit the least valuable positions before the best ones.

For each position, the engine walks through this **priority tree** from top to bottom. The first matching condition triggers the exit:

```
┌─────────────────────────────────────────────────────────┐
│         For each position (worst-first):                 │
│                                                          │
│  1. Data gap? (no live quotes)                           │
│     → SKIP. Long-only positions only need the long       │
│       price (short is gone).                             │
│                                                          │
│  2. Short-leg-only exit? (full spreads only)             │
│     → If short leg's live ASK === 1.1:                   │
│       buy back ONLY the short, HOLD the long.            │
│       Position becomes long-only (sellQty = 0).          │
│                                                          │
│  3. Long-only laddered exit? (long-only positions)       │
│     → Exit 1/10 of the long per crossed LTP level        │
│       (10 random levels: current LTP → max(entry,2hr-hi)) │
│                                                          │
│  4. Partial Exit / Scaling? (full spreads only)          │
│     → Scale down buy leg if profitable                   │
│       (does NOT exit the position)                       │
│                                                          │
│  5. PRIORITY 2: Expiry?                                  │
│     → EXIT if ≤ 2 minutes to expiry                      │
│                                                          │
│  6. PRIORITY 3: ATM reached / Candle Wick?               │
│     → EXIT if spot crosses buy strike                    │
│       (via real-time spot or 1m index wick).             │
│       For long-only, this closes the remaining long.     │
│                                                          │
│  7. None of the above                                    │
│     → HOLD (keep position)                               │
└─────────────────────────────────────────────────────────┘
```

> [!NOTE]
> **Leg Swap, Standard Rotation, and "Lost Protected Rank" have been removed.** A position is now closed in two phases: the **short leg** exits on its own ($1.1 ask trigger) and the **held long leg** is then scaled out by the laddered exit, with expiry / ATM-ITM-OTM as the catch-all. The priority numbering (2, 3) still reflects the code comments; Priority 1 (time-based) and Priority 4 (rotation/leg-swap) no longer exist.

### Exit: Expiry Settlement

```
If current time ≥ expiry time - 2 minutes → EXIT
```

We exit **2 minutes early** to avoid settlement mechanics. If a position somehow wasn't exited and it's been more than **10 minutes past expiry**, it's treated as a "zombie" and force-exited with the expiry time as the recorded exit time.

### Exit: Dynamic Spot Trigger (ATM, ITM, OTM) & Candle Validation Fallback

The engine uses two layers to check exit conditions: **Real-time 1-second ticks** and **1-minute index candle validation**.

#### Layer 1: Real-time Spot Ticker (1-Second Check)
Every second, the engine checks the latest spot price from the WebSocket stream against the config rules:

##### ATM (Standard)
```
For CALLS: if spotPrice ≥ buyStrike → EXIT
For PUTS:  if spotPrice ≤ buyStrike → EXIT
```
Exits when the spot price crosses your buy leg's strike.

##### ITM (In The Money)
```
For CALLS: if spotPrice ≥ buyStrike - exitPoints → EXIT
For PUTS:  if spotPrice ≤ buyStrike + exitPoints → EXIT
```
Exits when the option goes in-the-money relative to the strike (e.g. spot rises to or above `buyStrike - exitPoints` for calls, or falls to or below `buyStrike + exitPoints` for puts).

##### OTM (Out The Money)
```
For CALLS: if spotPrice ≥ buyStrike + exitPoints → EXIT
For PUTS:  if spotPrice ≤ buyStrike - exitPoints → EXIT
```
Exits when the buy leg has gone ITM by at least `exitPoints` (i.e., spot rises to or above `buyStrike + exitPoints` for calls, or falls to or below `buyStrike - exitPoints` for puts). The sell leg is still OTM at that point. This is a **delayed exit** — it lets the buy leg go deeper into the money before closing the spread.

## Partial Exit / Scaling Logic

This is the most complex part. Think of it as **gradually taking profit** by reducing the buy leg's lot size in steps while keeping the short leg untouched.

> [!IMPORTANT]
> This buy-leg scaling runs for **full spreads only** (`atmStrike !== null && pos.sellQty > 0`). Once the short leg has exited and the position is **long-only** (`sellQty === 0`), this scaling is skipped — the held long is instead managed by the [Long-Only Laddered Exit](#long-only-laddered-exit). (The ratio math here degenerates without a short leg.)

### The Concept

Imagine you entered with a lot size of 1.0 on the buy leg. As the position becomes more profitable, the engine **shaves off 10% of the initial lot size** at each step:

```
Start:  lotSize = 1.00
Step 1: lotSize = 0.90  (shaved off 0.10)
Step 2: lotSize = 0.80  (shaved off another 0.10)
...
Step 5: lotSize = 0.50  (shaved off another 0.10)
STOP:   Can't go below 0.50 (50% floor of initial scaled lot size)
```

### Three Conditions Must ALL Be True to Scale

| Condition | Formula | Meaning |
|-----------|---------|---------|
| **PnL threshold** | `currentGrossPnl ≥ checkpointPnl + (checkpointAtmPnl × 10%)` | The position's gross profit must exceed the last checkpoint plus 10% of the ATM P&L |
| **Floor limit** | `hypotheticalLotSize ≥ floorLimit (50% of initial)` | Can't reduce below 50% of the initial scaled lot size |
| **ATM ratio guard** | `liveAtmRatio ≥ recalculatedRatio + 1` | The live ATM ratio must be at least 1 higher than what the ratio would become after scaling |

### What Happens When It Scales

1. A **partial exit trade** is recorded in `trade_history` with `is_partial = true`.
2. The buy leg's `lotSize` is reduced by `deltaBuyQty` (10% of initial).
3. The `checkpointPnl` and `checkpointAtmPnl` are **reset** to current values (this raises the bar for the next scaling step).
4. **Accurate & Symmetrical Fee Calculations**: 
   - **Entry Fee (`partialEntryFee`)**: Calculated exactly for the exited buy leg portion using the entry parameters: `calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1)` (capped to the remaining entry fee). This avoids scaling down the total entry fee proportionally (which would incorrectly deduct a portion of the Sell Leg's entry fee while it is still open).
   - **Exit Fee (`partialExitFee`)**: Calculated dynamically based on the current live exit price and spot: `calculateFee(liveExitBuy, spotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1)`.
5. The process **repeats in a while loop** — multiple scaling steps can happen in a single evaluation if the price moved a lot.

### Key Fields

| Field | Meaning |
|-------|---------|
| `originalLotSize` | The lot size before any `$200K` cap scaling was applied |
| `initialScaledLotSize` | The lot size after the `$200K` cap at entry (this is the "100%" baseline) |
| `lastCheckpointPnl` | The gross PnL at the last scaling event |
| `lastCheckpointAtmPnl` | The ATM PnL at the last scaling event |
| `accumulatedSellPnl` | ⚠️ Misleading DB column name — actually stores accumulated **buy leg** partial exit PnL |

---

## Short-Leg-Only Exit

A ratio spread is no longer closed as a single unit. Instead, the **short leg exits on its own**, leaving a held long leg.

### When Does It Happen?

For a full spread (`sellQty > 0`), every cycle the engine checks the short leg's **live ask** price:

```
If shortLeg liveAsk === 1.1  → buy back ONLY the short leg, HOLD the long
```

> [!WARNING]
> This is an **exact** match (`=== 1.1`) by design. If the ask gaps past 1.1 (e.g. 1.15 → 1.05 between cycles), the short leg is **not** closed that cycle.

### What Happens

1. The short leg is **bought back at the ask** (`liveExitSell`, which is 1.1). Its P&L is recorded in `trade_history` as a partial row (`is_partial = true`, reason `Short Leg Exit @ Ask $1.1 ...`).
2. The short's share of the entry fee is apportioned out: `calculateFee(entrySellPrice, entrySpotPrice, sellQty, sellLotSize)` (capped to the remaining entry fee).
3. The position becomes **long-only**: `sellQty = 0`, `sellLeg.lotSize = 0`, margin recomputed (`calcMargin(entryBuyPrice, buyLot, spot, 0, 1)`).
4. The current long lot is **snapshotted** as `buyLeg.longExitBaseLot` (with `longExitStage = 0`) — this is the base for the laddered long exit below. Both are persisted in `buy_leg`.
5. The position is **kept** in `active_positions` (not deleted) — the long leg continues to be held.

Because the cap counts only full spreads (`sellQty > 0`), this freed slot lets a new closer-to-ATM spread enter. See [How Entries Are Placed](#how-entries-are-placed).

---

## Long-Only Laddered Exit

Once a position is long-only (short leg gone), the held long leg is scaled out in **10 slices** as its own LTP recovers toward the entry price.

### How the levels are built

At the moment the short leg exits, the engine snapshots the long's current LTP, fetches the long option's **last 1-2hr high** from Delta's historical candles, and builds **10 random price levels** spanning `[current LTP, upperBound]` (sorted ascending). These are stored on the position (`buyLeg.longExitLevels`) along with the base lot (`longExitBaseLot`) and stage (`longExitStage = 0`).

- **Upper bound** = `max(entryBuyPrice, pastHigh)`, where `pastHigh` = max candle high of the long over the last 2 hours (`getOptionHigh(symbol, 2)` → Delta `/v2/history/candles`). If candles are unavailable (API error / newly listed / no data), it **falls back to `entryBuyPrice`**. Using `max` means: when the long traded **above** its entry in the last 1-2hr, the ladder extends into the **profit zone** up to that high; otherwise it caps at entry (breakeven).
- **Range**: from the long's **current LTP** (low — the long is cheap after the short went worthless) up to that **upper bound**. The long is held expecting a recovery toward the level it recently traded at.
- **Levels**: 10 **random** points in that range (`buildLongExitLevels()`), not evenly spaced. Each crossed level exits **1/10** of the base lot (`longExitBaseLot / 10`).
- **One fetch only**: the candle call happens once, when the position becomes long-only; the resulting levels are persisted, so there's no repeated network call and no mid-flight re-randomisation.
- **Degenerate case**: if current LTP is already ≥ upper bound, all levels collapse to the upper bound, so the whole long exits as soon as it's evaluated.

```
entryBuyPrice = $70, last 2hr high = $90  →  upper = max(70, 90) = 90
long LTP at short-exit = $10
→ 10 random levels in [10, 90], e.g.:
   14, 22, 31, 40, 49, 58, 66, 75, 83, 90   (sorted)
Levels above $70 are profit on the long; below are loss-recovery.
As long LTP rises and crosses each level → exit 1/10 of base lot.
Crossing the last (10th) level → remaining long exits → position deleted.

(If last 2hr high ≤ entry, e.g. 50 → upper = max(70,50) = 70, capped at entry.)
```

### Details

1. Each slice exits the long by **selling at the bid** (`liveExitBuy`); the LTP is only the **trigger**. Each slice is a partial `trade_history` row (`is_partial = true`, reason `Long Leg Exit @ level $X ...`) with its apportioned entry fee.
2. If the LTP crosses several levels in one cycle (e.g. a sharp move up), **all crossed slices exit at once** (a `while` loop advances the stage).
3. The final (10th) level clears any rounding remainder, then the position is **deleted** from `active_positions`.
4. Progress survives restarts: `longExitStage`, `longExitBaseLot`, and the `longExitLevels` array all live in the `buy_leg` JSON, so the ladder resumes where it left off — no double exits and the levels don't get re-randomised mid-flight.
5. **Catch-all still applies**: if levels aren't reached, the remaining long still exits via **expiry** or the **ATM/ITM/OTM Full Exit** (spot crossing the buy strike). A partial slice this cycle falls through to those checks for the remaining lot.

> [!NOTE]
> The level **range top is `max(entry, last 1-2hr high)`** (Delta candles, with entry as fallback). When the recent high is above entry, the ladder books **profit on the long leg** up to that high; when it's below entry, the top caps at entry (loss-recovery only). Either way the short leg's buy-back already booked the bulk of the trade's profit. The slice **trigger** is the long LTP; the slice **exit price** (for P&L) is the long's live **bid**.

---

## Manual Exit (Liquidation)

Manual exit (or "Close Position") is a client-initiated override flow allowing traders to manually close any active position directly from the frontend dashboard. 

### Lifecycle of a Manual Exit

```mermaid
sequenceDiagram
    participant User as Trader (Frontend)
    participant Modal as ConfirmExitModal
    participant DB as Supabase DB
    participant Engine as paperTradingEngine (VPS)
    
    User->>User: Click "Exit" on Active Positions Row
    User->>Modal: Open ConfirmExitModal (Display pricing/P&L/fees)
    User->>Modal: Click "Confirm Exit"
    Modal->>DB: INSERT row in trade_history (exit_reason = 'Manual Exit')
    Modal->>DB: DELETE row in active_positions (id = T...)
    DB->>Engine: Postgres realtime notification (DELETE active_positions)
    Engine->>Engine: Filter out position from memory immediately
    Modal->>User: Close modal & remove position from frontend UI
```

1. **Trigger**: The trader clicks the **Exit** button in the **Actions** column of the Active Positions table.
2. **Review**: The **ConfirmExitModal** opens, showcasing real-time liquidation statistics:
   - Current long Bid and short Ask prices.
   - Gross realized P&L and net realized P&L.
   - Estimated transaction exit fees.
3. **Execution (Database level)**:
   - An entry is inserted into the `trade_history` table with `exit_reason` set to `'Manual Exit'`.
   - The position's corresponding row is deleted from the `active_positions` table.
4. **Realtime Engine Synchronization**:
   - The VPS engine has a realtime subscription listening to the `active_positions` table.
   - Upon receiving the `DELETE` event, the engine instantly filters the position from its in-memory `positions` array, ensuring it doesn't attempt any further exit evaluation on it.
   - A redundant check ensures that if the engine's main evaluation loop attempts to exit the same position before the deletion is processed, it queries `trade_history` first and aborts the exit if `trade_id` already exists (preventing double exits).

---

## Safety Guards Summary

Here's every safety guard in one table:

| Guard | Where | Purpose |
|-------|-------|---------|
| `isEvaluating` mutex | `paperTradingEngine.js` | Prevents overlapping evaluation cycles |
| Spot staleness (120s) | `paperTradingEngine.js` | Skips evaluation if spot price is stale |
| WebSocket stale spot reconnect | `paperTradingEngine.js` | Automatically forces WebSocket reconnect (`startWebSocket()`) if spot remains stale > 120s |
| Evaluation hang guard (60s) | `paperTradingEngine.js` | Logs fatal error and crashes process (`exit(1)`) if evaluation is hung > 60s, triggering PM2 container recovery |
| Config fetch retry loop (10x) | `paperTradingEngine.js` | Retries config load up to 10 times with 500ms delay to prevent duplicate key database insert collisions |
| Quote freshness (120s) | `utils.js` | Rejects spread candidates whose quotes are older than 120 seconds |
| Backfill rejection (timestamp = 0) | `utils.js` | Rejects tickers with no bid/ask price that still have timestamp = 0. Tickers with a valid price from REST backfill are treated as fresh (timestamp = `Date.now()`) for the first scan, then overwritten by live WS quotes. |
| Min strike diff | `utils.js` | Minimum distance between buy and sell strikes |
| Min IV diff | `utils.js` | Minimum implied volatility gap |
| Min long distance | `utils.js` | Buy leg must be far enough from spot |
| Min sell premium | `utils.js` | Sell leg must have meaningful premium |
| Ratio deviation | `utils.js` | Premium ratio must roughly match delta notional ratio |
| Max sell qty | `utils.js` | Caps the short side quantity |
| Max net premium debit | `utils.js` | Limits how much net debit is acceptable |
| ATM PnL ≥ $50 | `paperTradingEngine.js` | Only enters spreads that would profit $50+ at ATM |
| Days to Expiry | `paperTradingEngine.js` | Rejects candidates whose expiry is fewer than `daysToExpiry` days away |
| Portfolio cap | `paperTradingEngine.js` | Max **full-spread** calls (`config.numberOfCalls`) and puts (`config.numberOfPuts`) per account — held long-only positions (`sellQty = 0`) excluded |
| $200K short value cap | `paperTradingEngine.js` | Scales down lot sizes if short notional ≥ $200K |
| DB count guard | `paperTradingEngine.js` | Database-level check: max `config.numberOfCalls`/`config.numberOfPuts` **full spreads** (`.gt('sell_qty', 0)`) |
| DB buy strike uniqueness | `paperTradingEngine.js` | Database-level: no duplicate buy strikes |
| DB sell strike uniqueness | `paperTradingEngine.js` | Database-level: no duplicate sell strikes among full spreads (`.gt('sell_qty', 0)`) |
| Expiry buffer (5 min) | `paperTradingEngine.js` | Won't enter if less than 5 minutes to expiry |
| Scaling floor (50%) | `paperTradingEngine.js` | Buy lot size can never go below 50% of initial (full-spread scaling only) |
| Scaling ATM ratio guard | `paperTradingEngine.js` | Live ATM ratio must justify the lot reduction (full-spread scaling only) |
| Short-leg exit trigger | `paperTradingEngine.js` | Short leg bought back when its live ask `=== 1.1`; long leg held |
| Long-only ladder | `paperTradingEngine.js` | Held long scaled out in 10 slices at 10 random LTP levels spanning [current LTP, max(entry, last 2hr high)] |
| `lastDbWrite` cooldown (3s) | `paperTradingEngine.js` | Skips position refetch for 3s after a DB write |
| Heartbeat timer delete | `paperTradingEngine.js` / `heartbeat.js` | Clears interval timer and deletes the DB row on account deletion to prevent zombie row resurrection |

---

## Diagnostic Logging (0 Candidates)

**Files**: [`paperTradingEngine.js`](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js), [`utils.js`](file:///c:/Users/ASUS/Documents/Option_Scope/engine/lib/utils.js)

When `Evaluating 0 candidate spreads` appears in logs, the engine now automatically logs **why** — making it easy to distinguish a market condition issue from a technical one.

### How It Works

`scanTickers()` now returns `{ pairs, rejected }` instead of just an array. The `rejected` object contains per-filter rejection counts:

```javascript
rejected = {
  strikeDiff, noPrice, staleQuote, noIv,
  ivDiff, longDist, sellPremium, noDelta,
  ratioDev, maxSellQty, netPrem
}
```

After scanning, the engine merges call and put rejection counts and logs the **top rejecting filter** when 0 candidates result.

### Reading the Diagnostic Logs

| Log Pattern | Meaning |
|---|---|
| `0 candidates — top filter: minSellPremium rejected 171 pairs` | Market premiums are too low for current config (near-expiry theta decay) |
| `0 candidates — top filter: stale WS quote (>120s) rejected 83 pairs` | WebSocket disconnected — reconnecting |
| `Ticker pool: 138 total, 0 match expiry ... — WS may not have started yet` | Engine just restarted, WS not connected yet |
| `Ticker pool: 85 matching expiry, but 23 have stale quotes (>120s)` | WS partially stale — some symbols not updated |

> [!NOTE]
> If the **top filter is `minSellPremium`** and all accounts are affected simultaneously, this is a **market condition issue** (e.g., near-expiry OTM options have low premiums due to theta decay) — not a bug.

### Trade History Realtime Optimization

Instead of re-fetching all trade history from Supabase on every `INSERT` event, the `historyChannel` Realtime handler now uses `payload.new` directly:

```javascript
// Before: full re-fetch on every closed trade
historyChannel.on('INSERT', () => { fetchSupabaseTradeHistory(); })

// After: use the payload data already delivered in the event
historyChannel.on('INSERT', (payload) => {
  const newTrade = mapRow(payload.new);
  setTradeHistory(prev => [newTrade, ...prev]);
})
```

This eliminates the largest source of Supabase egress. A full re-fetch still happens on initial page load and when the tab regains focus.

---

## Config Synchronization

**File**: [paperTradingEngine.js:L1279-L1312](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js#L1279-L1312)

When you change filters in the UI and click **Apply**:

1. The UI writes the new config to `paper_trading_config` in Supabase
2. Supabase Realtime fires a `postgres_changes` event
3. The engine's `subscribeConfigChanges` listener catches it
4. It re-reads the config from the DB
5. If the **underlying or expiry changed**, it also:
   - Refreshes products
   - Re-fetches positions
   - Clears the ticker cache
   - Restarts the WebSocket with new symbols
   - Backfills tickers for the new symbols

When you click **Reset**:

1. The UI loads the account-specific defaults stored in the active account's `default_config` JSONB column. (If the account is a legacy account without custom defaults, it falls back to system factory defaults).
2. It merges these default parameters with the current asset/expiry.
3. Immediately upserts those defaults to Supabase.
4. The same Realtime listener picks it up and reloads the config.

### Tab Synchronization
- Changes are synchronized across browser tabs in real-time using a local broadcast channel (`CONFIG_SYNC` event).
- To prevent database write loop collisions, receiving tabs update only their local React state buffers and do **not** trigger redundant database writes, preserving the correct, newly applied configuration.

---

## Time-Based Filter Schedules

**File**: [paperTradingEngine.js:L325-L344](file:///c:/Users/ASUS/Documents/Option_Scope/engine/paperTradingEngine.js#L325-L344), [SchedulePanel.jsx](file:///c:/Users/ASUS/Documents/Option_Scope/src/components/PaperTrading/SchedulePanel.jsx)

Time-Based Filter Schedules allow users to define multiple named time windows per account within a 24-hour cycle. Each window overrides specific entry and portfolio filters during that period.

### Overridden Parameters
Only the following 8 parameters are scheduled:
1. **Max Calls** (`numberOfCalls`)
2. **Max Puts** (`numberOfPuts`)
3. **Min Strike Difference** (`minStrikeDiff`)
4. **Min Long Distance** (`minLongDist`)
5. **ATM Ratio Entry** (`atmRatioScaling`)
6. **Call ATM Pct (%)** (`atmRatioPctCall`)
7. **Put ATM Pct (%)** (`atmRatioPctPut`)
8. **Spot Diff (%)** (`spotDiff`)

All other filter settings (like `minIvDiff`, `exitType`, etc.) default back to the base account config.

### Layout & UI
- **Watchlist Style**: The configuration interface (`SchedulePanel.jsx`) features a compact, horizontal, inline-editable list styled like the Charts Watchlist. Users can edit window names, times, and overrides directly within the row.
- **Visual Timeline**: A 24-hour horizontal bar visualizes active windows, gaps, and overrides. The timeline boundary starts/ends at `05:30` IST (representing the `00:00` UTC Delta Exchange daily rollover/day boundary). This ensures that any empty slots wrap around `05:30` IST and display at the end of the bar.
- **Permanent Activation**: All configured schedule windows are permanently active/enabled (`is_active = true`), and the checkbox toggle has been removed.

### Execution, Timezones & Evaluation
- **Database (IST)**: All times in the database `paper_trading_schedules` table (columns `start_time` and `end_time`) are stored directly as IST values in `TIME` type columns.
- **Frontend (IST)**: The frontend displays and accepts inputs in Indian Standard Time (IST). Direct IST time strings are read and saved directly without timezone conversion offsets.
- **Engine Comparison**: The backend trading engine evaluates schedule matches against the current time translated to IST (UTC + 5:30).
- **Overnight Windows**: The engine correctly handles overnight ranges in IST (e.g. `22:29` to `06:30` IST) by splitting/wrapping time comparisons relative to the 24-hour cycle.
- **Fallback Behavior**: If the current IST time does not fall into any active scheduled window, the engine automatically falls back to using the base account configuration parameters.
- **Live Auto-Sync & Real-time Updates**: Changes made in the UI are automatically synced (debounced auto-save) to Supabase. The background engine subscribes to real-time postgres changes on `paper_trading_schedules` and reloads them instantly upon edits.

---

## Frontend Dashboard Architecture

**File**: [PaperTrading.jsx](file:///c:/Users/ASUS/Documents/Option_Scope/src/PaperTrading.jsx)

`PaperTrading.jsx` is the root component of the dashboard. It manages all frontend state and is the single source of truth for config, positions, trade history, and accounts in the browser. The server-side engine (`paperTradingEngine.js`) runs independently and communicates via Supabase DB only — there is no direct API call between the UI and the engine.

### Authentication & RBAC

The dashboard requires a Supabase auth session to load. Login is **email-only** — no password is entered by the user. The password is deterministically derived from the email: `OptionScope_${cleanEmail}_Secure123!`. On first login, a `profiles` row is auto-created with `role: 'client'`.

Two roles exist:

| Role | Capabilities |
|------|-------------|
| `client` | Can only see and manage accounts linked to their own `user_id` |
| `admin` | Can see all accounts across all users; can assign any account owner during creation |

### Account Management

Accounts are rows in `paper_trading_accounts`. Each account has:
- A **name** (editable via `EditAccountModal`)
- An **owner** (`user_id`) — only admins can assign a different owner at creation
- A **`default_config` JSONB column** — stores the "Reset" target for that account's filters. This is set at creation and never changes unless manually updated.

**Account lifecycle:**

| Action | What Happens |
|--------|-------------|
| **Create** | Inserts into `paper_trading_accounts` + `paper_trading_config`; the engine starts automatically via Realtime |
| **Edit** | Renames the account only (config is separate) |
| **Delete** | Pre-deletes the `engine_heartbeat` row first (prevents zombie heartbeat rows), then deletes the account row; the engine stops via Realtime |

> [!NOTE]
> On account load, any `default_config` rows missing new fields (e.g., after adding `legSwapNetPremium`) are automatically backfilled to current defaults. This prevents "stale default" bugs after config schema additions.

### Reset Button Behavior

When you click **Reset**, the frontend merges `activeAccount.default_config` (account-specific defaults stored in the DB) with system factory defaults (fallback for missing keys), then immediately upserts the merged config to Supabase. The engine picks it up via Realtime.

```
Reset target = account.default_config ?? ACCOUNT_CONFIG_DEFAULTS
```

This means each account can have its own set of "default" filters, not just one global default.

### Phase 1: Real-time P&L Display

The frontend runs a **read-only WebSocket** for P&L display only — it never writes positions. Every 1 second, a `setInterval` loop reads the latest ticker data and recomputes unrealized P&L for each active position:

```
grossPnl = (buyPriceDiff × buyLotSize) + (sellPriceDiff × sellQty × sellLotSize) + accumulatedSellPnl
netPnl   = grossPnl - totalFees
```

**Ticker buffer flush** — to prevent React rendering every time a single ticker updates, incoming WS messages are collected in a `tickerBufferRef` and flushed to state via `setTickerData` on a **50ms timer**. This batches all rapid WS messages into a single React render.

> [!TIP]
> The frontend WebSocket subscribes to all symbols for the current expiry PLUS all open position symbols (even if they belong to an older expiry), ensuring P&L display works for positions entered on a different day's expiry.

### Heartbeat Status Thresholds

The engine's `engine_heartbeat` row is polled every **30 seconds** (paused when the tab is hidden). The frontend classifies the engine state as:

| Status | Condition | Badge Color |
|--------|-----------|-------------|
| **Online** | `age < 60 seconds` | Green (`#0ecb81`) |
| **Stale** | `60s ≤ age < 120 seconds` | Yellow (`#f0b90b`) |
| **Offline** | `age ≥ 120 seconds` | Red (`#f85149`) |

### Trade History Date Filter

The trade history table has a day-by-day date filter. The "today" boundary uses a **UTC+12 offset** (not IST):

```js
d.setUTCHours(d.getUTCHours() + 12); // date flips at noon UTC = 17:30 IST
```

This means the trading "day" runs from **17:30 IST to 17:30 IST** the next day, matching the Delta Exchange daily rollover time. A trade closed at 18:00 IST and one at 17:00 IST the next morning are counted on the same day.

### Schedule Auto-Save

Schedule changes in the UI are saved automatically with a **1200ms debounce**. However, the auto-save is silently **blocked** if any two active schedule windows overlap in time:

```
if (hasOverlap) return; // do not write overlapping schedules to DB
```

A save only proceeds once all windows are non-overlapping. The overlap check handles both normal and overnight windows. Manual overlap resolution is required before changes persist.

### CSV Export

The Trade History table provides a **CSV export** button (`exportCSV`). The export includes:

| Column | Description |
|--------|-------------|
| Entry/Exit Time | ISO-formatted timestamps |
| Expiry | Formatted expiry date |
| Type | CALL / PUT |
| Ratio | Current ratio (after partial exits) |
| Original Ratio | Ratio at entry (before any scaling) |
| Buy / Sell Strike | Strike prices |
| Entry / Exit Prices | Buy and sell prices at entry and exit |
| Entry / Exit Spot | Spot price at entry and exit |
| Entry / Exit ATM Ratio | ATM ratio snapshot at entry and exit |
| Entry / Exit ATM Prices | ATM buy/sell prices at entry and exit |
| Gross PnL | Before fees |
| Total Fees | Entry + exit fees combined |
| Net PnL | After fees |
| Margin | Position margin at time of entry |
| Exit Reason | Full exit reason string from the engine |

The CSV filename includes the current date filter and a timestamp: `paper_trades_YYYY-MM-DD_<timestamp>.csv`.

---

## Lifecycle Flow Diagram

```mermaid
flowchart TD
    A["Supervisor starts"] --> B["Fetch all active accounts"]
    B --> C["For each account: start engine"]
    C --> D["Load config from DB"]
    D --> E["Load products & auto-select expiry"]
    E --> F["Fetch spot price"]
    F --> G["Load active positions"]
    G --> H["Backfill tickers via REST"]
    H --> I["Start WebSocket"]
    I --> J["Start heartbeat"]
    J --> K["Subscribe to config changes"]
    K --> L["1-second evaluation loop begins"]
    
    L --> M{"New minute?"}
    M -->|Yes| N["Full eval: exits + entries"]
    M -->|No| O["Exit-only eval"]
    
    N --> P["Scan & filter spreads"]
    P --> Q["ATM PnL filter >= $50"]
    Q --> R["Deduplicate & rank"]
    R --> S["Process positions worst-first"]
    
    O --> S
    
    S --> SA{"Full spread & short ask === 1.1?"}
    SA -->|Yes| SB["EXIT short leg only → hold long (sellQty=0)"]
    SA -->|No| SC{"Long-only & LTP crossed a level?"}

    SC -->|Yes| SD["Exit 1/10 long slice(s) per crossed level"]
    SD --> SE{"All 10 slices done?"}
    SE -->|Yes| AF
    SE -->|No| V
    SC -->|No| T{"Full spread & scaling conditions met?"}
    T -->|Yes| U["Partial exit: reduce buy lot 10%"]
    T -->|No| V{"Expiry <= 2 min?"}

    V -->|Yes| W["EXIT: Expiry settlement"]
    V -->|No| AD{"Spot crosses buy strike (ATM/ITM/OTM)?"}

    AD -->|Yes| AE["EXIT: Full exit (closes remaining long/spread)"]
    AD -->|No| AC["HOLD"]

    W --> AF["Write to trade_history + delete from active_positions"]
    AE --> AF
    SB --> AH["Process new entries with all guards"]
    U --> AH

    AF --> AH
    AC --> AH
    AH --> AI["Update heartbeat"]
    AI --> L
```

---

## Quick Reference: Key Numbers

| Constant | Value | Meaning |
|----------|-------|---------|
| Evaluation interval | 1 second | How often the main loop runs |
| Entry scan interval | 1 minute | How often new entries are considered |
| Spot poll interval | 10 seconds | How often spot price is fetched via REST |
| Product refresh | 5 minutes | How often the option chain is refreshed |
| Position sync | 2 minutes | Fallback re-fetch from DB (Realtime is the primary sync) |
| Spot staleness limit | 120 seconds | Max age of spot price before skipping eval |
| Quote freshness limit | 120 seconds | Max age of option quotes for entry |
| Expiry exit buffer | 2 minutes | How early before expiry to force-exit |
| Zombie threshold | 10 minutes | Past expiry, use expiry time as exit time |
| Max **full-spread** positions per type | Configurable | Max calls (`config.numberOfCalls`) or puts (`config.numberOfPuts`) per account (default: 3); held long-only positions excluded |
| Short-leg exit trigger | $1.1 (exact) | Short leg's live ask `=== 1.1` → buy back short, hold long |
| Long-only exit levels | 10 random | Random LTP levels in [current LTP, max(entry, last 2hr high)]; exit 1/10 long per crossed level |
| $200K cap | $200,000 | Max short notional value |
| Scaling step | 10% | Lot size reduction per scaling event (full spreads only) |
| Scaling floor | 50% | Minimum lot size as % of initial (full spreads only) |
| ATM PnL minimum | $50 | Min simulated ATM profit for entry |
| ATM strike tolerance (BTC) | 500 points | Fallback tolerance for finding ATM prices |
| ATM strike tolerance (ETH) | 50 points | Fallback tolerance for finding ATM prices |
| Evaluation hang limit | 60 seconds | Max duration evaluation can run before process is restarted |
| Days to Expiry | User configured | Minimum days to expiry required for new spreads |
| Exit Type | ATM | Default option exit type parameter (`ATM`, `ITM`, or `OTM`) |
| Exit Points | 0 | Default points distance threshold for ITM/OTM exits |
| Leg Swap Net Premium | 0 | ⚠️ Deprecated/unused — leg swaps removed (config still loaded for back-compat) |
