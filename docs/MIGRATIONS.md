# Database Migrations & RPC Reference

OptionScope's database is a Supabase (PostgreSQL) project. There is no migration runner:
SQL files are pasted into the **Supabase SQL editor** and run by hand. Table-level design is
in [LLD.md §6](LLD.md#6-supabase-schema--persistence); this page covers *how* to apply
schema changes and what each migration did.

## Contents

1. [Files](#files)
2. [Fresh database](#fresh-database)
3. [Applying a new migration](#applying-a-new-migration)
4. [Writing a new migration](#writing-a-new-migration)
5. [Duplicate numbers](#duplicate-numbers)
6. [Migration index](#migration-index)
7. [RPC reference](#rpc-reference)

---

## Files

| File | What it is |
|---|---|
| `supabase_schema.sql` | Base schema: profiles + auth trigger, accounts, config, schedules, positions, trade history, heartbeat, RLS, and many later migrations folded in. **Not** a complete current schema — it lacks e.g. the engine-verify RPCs (`004`) and `068`–`072` |
| `supabase_migrations/NNN_*.sql` | One change each, numbered in the order they were applied to production |
| `supabase_migrations/ALL_MIGRATIONS.sql` | Every **schema** migration concatenated in order (001 → 072). **Idempotent** — safe to re-run on an existing DB |

Not in `ALL_MIGRATIONS.sql` (run them separately):

| File | Why it's separate |
|---|---|
| `017_realtime_config_schedules.sql` | Adds `paper_trading_config` / `paper_trading_schedules` to the `supabase_realtime` publication. Without it, config edits reach the engine only on the 15-min fallback reload |
| `020_backfill_strategy_version.sql` | One-time **data** migration (sets paper → v2, live → v1). Only for databases that existed before `018`/`019` |
| `023_backfill_live_days_to_expiry.sql` | One-time **data** migration for live accounts' per-window DTE. Same reason |

## Fresh database

Run in the Supabase SQL editor, in this order:

1. `supabase_schema.sql`
2. The Vault key used to encrypt Delta API secrets (once; use a long random string and keep
   a copy somewhere safe — losing it makes every stored secret unreadable):
   ```sql
   select vault.create_secret('<long-random-string>', 'delta_cred_encryption_key');
   ```
3. `supabase_migrations/ALL_MIGRATIONS.sql`
4. `supabase_migrations/017_realtime_config_schedules.sql`
5. Enable Realtime for the tables the app subscribes to but no SQL file publishes. In the
   Supabase dashboard (Database → Publications → `supabase_realtime`) or in SQL:
   ```sql
   alter publication supabase_realtime add table
     public.active_positions, public.trade_history,
     public.live_exchange_state, public.paper_trading_accounts;
   ```
   (`paper_trading_config`, `paper_trading_schedules`, `delta_order_requests` and
   `entry_block_notifications` are already added by steps 3–4.) Without this the dashboard
   doesn't update live and the engine misses account changes until its 30 s sync.
6. Sign up in the app, then make yourself admin:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```

Do this on a scratch project first if you are unsure — it is the quickest way to confirm
the bundle still applies cleanly from zero.

## Applying a new migration

1. Read the file's header comment. Most say whether the engine must be restarted and/or the
   dashboard redeployed, and any ordering prerequisites.
2. Run it in the SQL editor **before** deploying code that uses it (code that selects a
   missing column fails; an extra unused column is harmless).
3. Restart the engine / redeploy the dashboard as the header says
   ([OPERATIONS.md → Release checklist](OPERATIONS.md#release-checklist)).
4. Index builds (e.g. `061`) briefly lock writes — run them at a quiet time.

## Writing a new migration

- Next free number, `NNN_short_snake_name.sql`.
- Start with the standard header: `Migration NNN — <title>`, what it changes, why, and
  whether engine restart / frontend redeploy is needed.
- Make it **idempotent**: `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `DROP POLICY IF EXISTS` before `CREATE POLICY`, guarded `DO $$ … $$` blocks.
- Say "Additive only" when nothing is dropped or rewritten.
- Append it to `ALL_MIGRATIONS.sql` (schema changes only — data backfills stay separate).
- If the column is a per-account setting that groups share, check that
  `sync_account_group` copies it (it copies `paper_trading_config` columns generically,
  except the ones it explicitly excludes).
- Add a line to the [index](#migration-index) below.

## Duplicate numbers

Two numbers were used twice. Both pairs are independent of each other, so either order
works:

- `017_live_order_history.sql` and `017_realtime_config_schedules.sql`
- `023_per_spread_hedge_leg.sql` (schema) and `023_backfill_live_days_to_expiry.sql` (data)

`025` and `026` belong together: `026` fixes the partial-uniqueness that `025` could not
apply on databases with existing duplicates.

## Migration index

| # | Change | Area |
|---|---|---|
| 001 | Delta live account linking: `mode`, `live_enabled`, encrypted `delta_credentials` | Live |
| 002 | Balance allocation % for live sizing | Live |
| 003 | Account pause + live entry price offsets | Live |
| 004 | Engine-mediated credential verification (`delta_verify_requests`) | Live |
| 005 | Return wallet balance with the verify result | Live |
| 006 | Fix ambiguous `account_id` on credential save | Live |
| 007 | Live wallet balance on the heartbeat | Live |
| 008 | Dry-run vs real mode on the heartbeat | Live |
| 009 | `live_exchange_state` snapshot table | Live |
| 010 | Max positions + allocation % on the heartbeat | Live |
| 011 | Manual exit requests | Live |
| 012 | Per-window Max Net Debit + Exit Type | Schedules |
| 013 | Close All | Live |
| 014 | Close one Delta position by symbol | Live |
| 015 | Cancel one Delta order | Live |
| 016 | Admins can manage accounts they don't own | Auth |
| 017 | `order_history` on the live snapshot | Live |
| 017 | Realtime for config + schedules *(not in bundle)* | Sync |
| 018 | Per-account `strategy_version` | Versioning |
| 019 | Per-window Min Days to Expiry | Schedules |
| 020 | Backfill strategy versions *(data, not in bundle)* | Versioning |
| 021 | Trading Days (day-of-week entry filter) | Entries |
| 022 | Hedge Overlay (superseded by 023/041) | Hedge |
| 023 | Per-spread hedge leg (long/short/long) | Hedge |
| 023 | Backfill live per-window DTE *(data, not in bundle)* | Schedules |
| 024 | `engine_heartbeat` UNLOGGED (less disk IO) | Perf |
| 025 | Expiry in strike-uniqueness keys | Integrity |
| 026 | Partial sell-strike uniqueness (fixes 025) | Integrity |
| 027 | Paper initial balance + combined-position sizing | Sizing |
| 028 | Per-account Telegram chat id | Telegram |
| 029 | Telegram `/start` deep-link code | Telegram |
| 030 | Daily full-deployment time | Sizing |
| 031 | SL/TP decoy diff | Exits |
| 032 | Real/decoy exit levels on active positions | Exits |
| 033 | Per-window short-exit price + variable slices | Exits |
| 034 | Drop `number_of_calls` / `number_of_puts` | Sizing |
| 035 | Entry-block notifications (governor) | Entries |
| 036 | Scope read policies to the account owner | Auth |
| 037 | Per-window Min IV Edge + All Same Type | Schedules |
| 038 | Allow 0 max combined positions | Sizing |
| 039 | ATM edge floors (`min_atm_pnl` / `min_atm_roi`) | Entries |
| 040 | Excluded strikes | Entries |
| 041 | Hedge toggle + hedge lot % | Hedge |
| 042 | Drop old 022 hedge columns | Hedge |
| 043 | Hedge max price + IV diff range | Hedge |
| 044 | Shared long strikes (paper v2) | Entries |
| 045 | `live_daily_stats` | Reporting |
| 046 | Backfill flags on daily stats | Reporting |
| 047 | `pnl_is_estimate` on daily stats | Reporting |
| 048 | Deposits on daily stats | Reporting |
| 049 | `day_basis` (switch to Delta's UTC day) | Reporting |
| 050 | Account groups + `sync_account_group` | Groups |
| 051 | Fix `sync_account_group` | Groups |
| 052 | Groups may span owners | Groups |
| 053 | Group exit-points jitter | Groups |
| 054 | Unique exit points within a group | Groups |
| 055 | Manual orders (`delta_order_requests`) | Live |
| 056 | Manual order to a whole group | Live |
| 057 | Order edit requests | Live |
| 058 | Group exit-points mode (Fixed / Random) | Groups |
| 059 | Replace with closer-to-ATM spread (paper) | Entries |
| 060 | `get_account_realized_pnl` | Perf |
| 061 | Query optimisations, batched request poll | Perf |
| 062 | OI limit filter | Entries |
| 063 | Partial scale-down controls | Exits |
| 064 | Group leader | Groups |
| 065 | OI filter mode (Delta lock / manual cap) | Entries |
| 066 | Account Max SL (paper) | Exits |
| 067 | Daily Report account groups | Reporting |
| 068 | Live hedge entry offset (`entry_hedge_offset`, default $2) | Live |
| 069 | `live_entry_fills()` for the Slippage tab | Reporting |
| 070 | Per-account Telegram **alerts** chat (`telegram_alert_chat_id`, `telegram_alert_link_code`) | Telegram |
| 071 | Paper **Max Net Credit** entry selection (`paper_trading_config.entry_by_max_credit`) | Paper entry |
| 072 | `paper_trading_accounts.exchange` (`delta` / `cosmic`) — Cosmic Paper accounts; a CHECK keeps Cosmic accounts paper-only | Accounts |

## RPC reference

Functions called by the dashboard (`supabase.rpc(...)`) or the engine. "Definer" =
`SECURITY DEFINER` (runs with the owner's rights; checks access itself).

| Function | Defined in | Caller | Purpose |
|---|---|---|---|
| `upsert_delta_credentials` | 001, 006 | Dashboard | Save a Delta key; encrypts the secret server-side (definer) |
| `get_delta_credentials_meta` | 001 | Dashboard | Key last-4 / status without the secret |
| `get_delta_credentials_decrypted` | 001 | Engine (`service_role` only) | The only decrypt path for API secrets |
| `request_delta_verification` | 004 | Dashboard | Queue an engine-side credential check |
| `get_delta_verify_request_decrypted` | 004 | Engine | Read a queued verify request |
| `get_delta_verification_status` | 004, 005 | Dashboard | Verify result + wallet balance |
| `get_pending_engine_requests` | 061 | Engine (manager) | One call returns pending manual exits / close / cancel / orders / edits for all accounts |
| `place_manual_order` | 055, 056 | Dashboard | Queue a manual order (optionally for the whole group) |
| `sync_account_group` | 050 → 058 | Dashboard | Copy the leader's settings to every group member in one transaction |
| `get_account_realized_pnl` | 060 | Engine | Cumulative realized P&L (paper equity) |
| `get_trade_stats` | schema | Dashboard | KPI totals / win counts per account + underlying |
| `get_trade_day_totals` | 061 | Engine | Per-day realized P&L, fees, trade count |
| `live_entry_fills` | 069 | Dashboard (Slippage) | Entry orders' average fills from `live_exchange_state.order_history` |
| `handle_new_user` | schema | Auth trigger | Creates the `profiles` row on sign-up (role `client`) |
| `_is_admin`, `_delta_cred_key`, `_check_account_group`, `_reset_exit_points_jitter` | various | Internal | Helpers used by policies, triggers and the RPCs above |
