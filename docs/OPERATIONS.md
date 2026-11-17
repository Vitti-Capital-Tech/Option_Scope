# Operations — Deploy, Configure, Monitor, Recover

Production runbook for OptionScope. Local setup is in [SETUP.md](SETUP.md); live-trading
safety and the arming procedure are in [live_trading.md](live_trading.md).

## Contents

1. [Production topology](#production-topology)
2. [Deploying the dashboard (Vercel)](#deploying-the-dashboard-vercel)
3. [Deploying the engine (VPS + PM2)](#deploying-the-engine-vps--pm2)
4. [Single-instance rule](#single-instance-rule)
5. [Release checklist](#release-checklist)
6. [Environment variables](#environment-variables)
7. [Engine timers](#engine-timers)
8. [Telegram setup](#telegram-setup)
9. [Diagnostic scripts](#diagnostic-scripts)
10. [Incident runbook](#incident-runbook)

---

## Production topology

```text
Browser ──► Vercel (static dist/ + rewrites)
              ├─ /api/*  ──► https://api.india.delta.exchange   (public market data)
              └─ /*      ──► index.html (SPA)
Browser ◄──► Supabase (auth, tables, Realtime)
Browser ──► VITE_DELTA_PROXY_URL ──► engine proxyServer.js   (optional, credential Verify only)

VPS (whitelisted static IPv4, PM2: optionscope-engine)
   engine/index.js ──► paperTradingEngine.js (all accounts, one process)
        ├─ Delta WebSocket (one per underlying, shared — tickerHub.js)
        ├─ Delta signed REST (live orders, fills, balances)
        ├─ Supabase (service_role)
        └─ Telegram Bot API
```

The production engine box is an AWS Lightsail instance (~1.9 GB RAM) with a static IP that
is whitelisted on every live account's Delta API key.

## Deploying the dashboard (Vercel)

1. Vercel project → framework **Vite**, build `npm run build`, output `dist`.
2. Set these Environment Variables in Vercel (they are baked in at **build** time, so
   redeploy after changing one): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_TELEGRAM_BOT_USERNAME`, and optionally `VITE_DELTA_PROXY_URL`.
3. `vercel.json` rewrites `/api/*` to Delta and everything else to `index.html`.
4. Trigger a deploy from the Vercel dashboard (or by pushing to the connected branch) — Vercel builds and publishes.

> `vercel.json` and `vite.config.js` also proxy `/claude/*` and `/groq/*` for
> `src/aiService.js`. That module is **not imported anywhere** — it is dead code. Do not set
> `VITE_ANTHROPIC_API_KEY` / `VITE_GROQ_API_KEY` in Vercel: `VITE_` values are shipped to
> every visitor's browser.

## Deploying the engine (VPS + PM2)

First time:

```bash
git clone <repo-url> Option_Scope && cd Option_Scope/engine
npm install
cp .env.example .env     # fill in — see Environment variables below
npm install -g pm2
pm2 install pm2-logrotate
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup  # restart on reboot
```

Update to a new version:

```bash
cd Option_Scope && git pull
cd engine && npm install          # only if engine/package.json changed
pm2 restart optionscope-engine
pm2 logs optionscope-engine --lines 200
```

What `ecosystem.config.cjs` sets, and why:

| Setting | Value | Reason |
|---|---|---|
| `exec_mode` / `instances` | `fork` / `1` | Never two engines — see below |
| `kill_timeout` | 10 s | Lets SIGTERM stop timers, close sockets, flush heartbeat before a restart |
| `restart_delay` / `max_restarts` | 5 s / 50 | Crash recovery |
| `max_memory_restart` | `900M` | Peaks are ~550–680 MB with 22 accounts; the old 500M limit caused restart loops that overloaded Supabase |

Other operational facts:

- `engine/index.js` forces **IPv4-first** DNS so Delta sees the whitelisted IPv4, not an IPv6 address.
- Accounts start **staggered** in batches (`ENGINE_START_BATCH`, default 4, every
  `ENGINE_START_GAP_MS`, default 3 s) — armed live accounts with open positions first,
  then other live, then paper.
- Optional credential-verify proxy: set `DELTA_PROXY_PORT`, put nginx/Caddy with TLS in
  front, and point the dashboard's `VITE_DELTA_PROXY_URL` at it. Details:
  [live_trading.md → IP whitelisting & the Verify proxy](live_trading.md#ip-whitelisting--the-verify-proxy).
- The same proxy serves the **Cosmic Paper** tab: Cosmic (cosmic.trade) answers 403 to any browser
  Origin, so the dashboard reads Cosmic through it — `GET /cosmic/api/v1/{contracts,orderbook/…,charts/…}`
  and the WebSocket `/cosmic/feeds` (msgpack decoded to JSON). nginx/Caddy must pass WebSocket
  upgrades for `/cosmic/feeds` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";`). The engine itself reads Cosmic directly (`engine/lib/cosmicApi.js`).

## Single-instance rule

**Exactly one engine may run against a given Supabase project.** Two evaluators would both
exit the same positions and, on live, send duplicate orders. The deterministic `trade_id`
+ UNIQUE constraint stops duplicate *bookings* in the database, but cannot stop duplicate
*orders* on Delta. So:

- Never run `node index.js` on the VPS while PM2 is running it.
- Never point a local/dev engine at the production Supabase project.
- Check with `pm2 list` (one `optionscope-engine`, status `online`).

## Release checklist

1. **Migrations first.** Run any new `supabase_migrations/NNN_*.sql` in the Supabase SQL
   editor before deploying code that reads the new columns ([MIGRATIONS.md](MIGRATIONS.md)).
2. Engine change → `git pull` + `pm2 restart optionscope-engine` on the VPS.
3. Dashboard change → redeploy on Vercel.
4. Watch `pm2 logs` for a few minutes: accounts load, heartbeats publish, no `❌` lines.
5. Behaviour change for live? Ship it on paper (strategy v2) first and promote later.
6. Prefer a quiet market period; never restart in the middle of the minute's entry wave
   (`:00`–`:10`).

## Environment variables

### Dashboard (`.env`, all exposed to the browser)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon key |
| `VITE_TELEGRAM_BOT_USERNAME` | for Telegram | Bot username (no `@`) used to build the *Connect Telegram* `t.me/<bot>?start=<code>` link |
| `VITE_DELTA_PROXY_URL` | no | HTTPS origin of the engine's verify proxy; unset = use the Vercel `/api` rewrite |
| `VITE_ANTHROPIC_API_KEY`, `VITE_GROQ_API_KEY` | no — **do not set** | Read only by the unused `src/aiService.js` |

### Engine (`engine/.env`)

Core:

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | — | Supabase project URL (required) |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Required for live: decrypts Delta credentials. Without it only paper runs |
| `SUPABASE_ANON_KEY` | — | Fallback key when no service-role key is set |
| `DELTA_LIVE_DRYRUN` | `true` | Anything but `false` keeps every live order a dry-run log line |
| `DELTA_PROXY_PORT` | unset | Enables `proxyServer.js` on that port |
| `DELTA_PROXY_ALLOW_ORIGIN` | `*` | CORS origin(s) allowed to call the proxy, comma-separated |

Telegram:

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token; also enables the `/start` link listener |
| `TELEGRAM_CHAT_ID` | — | Default/admin chat for alerts and trade messages |
| `TELEGRAM_ERROR_CHAT_ID` | — | Admin error-only channel (technical format). If set, failures go here instead of `TELEGRAM_CHAT_ID` |
| `TELEGRAM_DEDUPE_MS` | 60000 | Same alert suppressed within this window |
| `TELEGRAM_MIN_GAP_MS` | 1200 | Minimum gap between sends to one chat |
| `TELEGRAM_GLOBAL_GAP_MS` | 150 | Minimum gap between any two sends |
| `TELEGRAM_MAX_RETRIES` | 3 | Retries on HTTP 429 (uses Telegram's `retry_after`) |
| `TELEGRAM_MAX_QUEUE` | 200 | Per-chat queue cap |

Live entry (armed real accounts):

| Variable | Default | Purpose |
|---|---|---|
| `ENTRY_FILL_WAIT_MS` | 5000 | Wait between modifies of an unfilled entry leg |
| `ENTRY_MODIFY_TRIES` | 6 | Number of modifies (5 s × 6 = 30 s per leg) |
| `ENTRY_SELL_MODIFY_PX` | 1 | Short leg is modified to this price ($) |
| `ENTRY_BUY_MARK_PLUS` | 50 | Long leg is modified to mark + this ($) |
| `ENTRY_HEDGE_OFFSET` | 2 | Fallback hedge offset when `entry_hedge_offset` (migration 068) is missing |
| `ENTRY_CHASE_ATTEMPTS` | 2 | Chase re-prices (hedge leg / legacy chase) |
| `ENTRY_CHASE_POLL_MS` | 1200 | Wait per chase attempt |
| `ENTRY_CHASE_BUMP` | 1 | Flat $ cross per attempt |
| `ENTRY_CHASE_BUMP_PCT` | 3 | %-of-premium cross per attempt (the larger of the two is used) |
| `ENTRY_STAGGER_MS` | 2000 | Random per-minute delay per live account so the governor's "first come" rotates. 0 = off |
| `ENTRY_RETRY_DELAY_MS` | 10000 | Retry delay after an entry aborted on an unfillable leg |
| `ENTRY_RETRY_MAX_PER_MIN` | 2 | Retries per minute (0 = off) |
| `ENTRY_WARMUP_RETRY_MS` | 3000 | Retry delay when the feed is still warming after an expiry roll |
| `ENTRY_NOFILL_BLOCK_MS` | 180000 | Symbol kept out of entries after an accepted-but-unfilled leg |
| `LIVE_REJECT_BLOCK_MS` | 1800000 | Symbol kept out after a non-margin rejection by Delta |
| `LIVE_MARGIN_COOLDOWN_MS` | 600000 | New live entries paused after two margin rejections in a row |
| `OI_LOCK_PCT` | 1 | Fraction of Delta's OI cap treated as locked (clamped 0.8–1) |

Entry gates & cycle (all accounts):

| Variable | Default | Purpose |
|---|---|---|
| `ENTRY_QUOTE_FRESH_MS` | 60000 | Long and short need a two-sided quote at least this fresh |
| `DEPTH_SIZE_STALE_MS` | 10000 | Diagnostic only: age at which a top-of-book size is logged as stale (`🕰`) |
| `ENTRY_GOVERNOR_WINDOW_MS` | 8000 | Cross-account depth-budget window |
| `ENTRY_PHASE_BUDGET_MS` | 25000 | Cap on one cycle's entry-placement phase |
| `EVAL_HANG_MS` | 60000 | A cycle stuck this long is fenced and replaced (per account, no process exit) |

Network & feeds:

| Variable | Default | Purpose |
|---|---|---|
| `DELTA_READ_TIMEOUT_MS` | 6000 | Signed GET deadline |
| `DELTA_WRITE_TIMEOUT_MS` | 15000 | Signed POST/PUT/DELETE deadline — keep it long (aborting an accepted order leaves an orphan) |
| `DELTA_PUBLIC_TIMEOUT_MS` | 10000 | Public REST deadline |
| `SPOT_CACHE_TTL_MS` | 5000 | Shared REST spot cache |
| `WS_SPOT_FRESH_MS` | 15000 | REST spot polling is skipped while the WebSocket spot is fresher than this |
| `LIVE_FILL_POLL_MS` | 3000 | `/v2/fills` poll for resting-order fills |
| `LIVE_FILL_STALE_MS` | 30000 | Fills cache older than this → the exit loop holds instead of guessing |

Process:

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_START_BATCH` | 4 | Accounts started per batch |
| `ENGINE_START_GAP_MS` | 3000 | Pause between batches |
| `DB_ALERT_AFTER_MS` | 45000 | Telegram alert when no DB write has succeeded for this long |
| `DB_ALERT_REPEAT_MS` | 600000 | Repeat interval while the DB stays down |

Every tuning value has a safe default in code. Set one only to tune the live box, then
`pm2 restart optionscope-engine`.

## Engine timers

Per account unless noted.

| Interval | What |
|---|---|
| 1 s | Evaluation tick — exits every tick; entry scan once per wall-clock minute |
| 1.5 s (manager) | `pollAllRequests` — manual exits, close/cancel, manual orders, order edits |
| 4 s (manager) | Engine-mediated credential verification requests |
| 10 s | Spot REST fallback (skipped while WS spot is fresh) |
| 10 s (live) | `live_exchange_state` snapshot — written only when something changed, keepalive 60 s, full row at least every 5 min |
| 30 s (live) | `reconcileOrphans` against Delta |
| 30 s (manager) | Account sync — starts/stops engines for added, removed, paused accounts |
| 30 s | Heartbeat (`engine_heartbeat`, batched) |
| 60 s | Live balance refresh; live "has schedule windows" guard |
| 5 min | Product / expiry refresh |
| 15 min | Fallback reload of config, schedules and active positions + reconcile (Realtime is the primary path) |

## Telegram setup

1. Create a bot with @BotFather → put the token in `TELEGRAM_BOT_TOKEN` (engine) and its
   username in `VITE_TELEGRAM_BOT_USERNAME` (dashboard).
2. Create an admin group/channel, add the bot as admin, set `TELEGRAM_CHAT_ID`. Optionally
   a separate admin error channel → `TELEGRAM_ERROR_CHAT_ID`.
3. Per account, the owner links chats from the account form with **Connect Telegram**: the
   button opens `t.me/<bot>?start=<code>`; the engine's `getUpdates` listener matches the
   code and stores the chat id. Two chats can be linked:
   - **Trades** → `telegram_chat_id` (migrations 028/029): entries and exits.
   - **Alerts** → `telegram_alert_chat_id` (migration 070): that account's errors in plain
     English with IST times. If unset, alerts go to the trades chat.

The admin chat always receives every error in the technical format (the account copy is
skipped if the account's chat *is* the admin chat). Alert grades:
🔴 CRITICAL (money at risk) · 🟠 CHECK SOON · 🟡 NO MONEY RISK, plus one ✅ RESOLVED when a
condition clears. Full list in [live_trading.md → Telegram failure alerts](live_trading.md#telegram-failure-alerts).

## Diagnostic scripts

Run on the VPS from `engine/` (they need the whitelisted IP and the service-role key).
All are read-only unless stated.

| Script | Purpose |
|---|---|
| `node checkDeltaUsers.js` | Shows the Delta user id behind every live account. Accounts that are sub-accounts of one Delta user **share** its 10,000-unit / 5-min rate limit — check this before adding accounts |
| `node diagnoseDailyStats.js --account "<name>" --date YYYY-MM-DD` | Compares Delta order history, fills and wallet ledger with `live_daily_stats` for one day |
| `node backfillDailyStats.js [--dry-run] [--account "<name>"] [--from YYYY-MM-DD] [--rebuild]` | **Writes** `live_daily_stats` for past days. Use `--dry-run` first |

## Incident runbook

| Symptom | Check | Action |
|---|---|---|
| Dashboard heartbeat red / stale | `pm2 list`, `pm2 logs` | If stopped/errored: `pm2 restart optionscope-engine`. If restarting in a loop: look for memory (`pm2 status`) or the fatal error at the top of the log |
| 🔴 CRITICAL Telegram alert | Read the alert's *Money at risk* line; open the account's Positions / Open Orders | Orphan or naked short on Delta → close it manually on Delta or with the dashboard's per-leg ✕. The engine never auto-closes untracked shorts |
| DB watchdog alert ("no DB write", `engine/lib/dbHealth.js`) | Supabase status page and project usage (CPU / egress limits) | Repeats every 10 min while down; a "recovered" message follows the first successful write. If it doesn't recover, check live positions directly on Delta — the dashboard is blind while the DB is down |
| HTTP 429 from Delta | Log lines with `429`; run `checkDeltaUsers.js` | Too many accounts on one Delta user, or a reconnect storm. Do not lower the backoff |
| Live entries all skipped | `pm2 logs` and grep `OI-LOCK`, `NOFILL`, `Entry blocked`, `margin` for the account | Margin → top up or lower allocation (two margin rejections in a row pause entries for `LIVE_MARGIN_COOLDOWN_MS`). OI lock → wait for Delta to release (< 95% of cap). NOFILL → that symbol is skipped for 3 min |
| A position exists on Delta but not on the dashboard | Wait one reconcile (~30 s) | Long legs are adopted automatically; shorts raise an alert for a human |
| Engine memory climbing for days | `pm2 status` over several days | A leak — investigate. Do not just raise `max_memory_restart` |
| Need to stop all live trading **now** | — | Set `DELTA_LIVE_DRYRUN=true` and restart, or **Disarm** each account in the dashboard. Open positions and resting orders on Delta stay until closed (Close All) |
