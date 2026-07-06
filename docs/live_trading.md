# Live Trading — Linking a Delta Exchange Account

OptionScope started as a paper-trading-only workspace. This document describes the
work to link a **real Delta Exchange account** to an existing account so the engine
can eventually place **real orders**, mirroring the strategy that already runs in
paper mode.

The work is deliberately split into stages so real money is never at risk before the
whole path has been validated.

- **Stage 1 (implemented): credential linking.** An account can be flagged `live`,
  Delta API credentials can be attached and verified, and they are stored encrypted.
- **Stage 2 (implemented, dry-run by default): order execution.** The engine reads
  the decrypted credentials and places real limit orders at entry/exit, behind a
  global dry-run flag (`DELTA_LIVE_DRYRUN`, default ON) and the per-account
  `live_enabled` kill-switch. Until you set `DELTA_LIVE_DRYRUN=false` **and** arm an
  account, no real orders are sent.

---

## Account model

A `paper_trading_accounts` row now carries two extra columns:

| Column         | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `mode`         | `'paper'` (simulated, default) or `'live'` (linked to Delta Exchange).  |
| `live_enabled` | Kill-switch. Real orders stay OFF until this is explicitly `true`.      |

Switching an account back to `paper` in the UI also forces `live_enabled = false`.

## Credential storage & security model

Credentials live in a dedicated `delta_credentials` table (one row per account):

- `api_key` — the public identifier (sent in a header on every Delta request).
- `api_secret_enc` — the secret, encrypted at rest with `pgcrypto`
  (`pgp_sym_encrypt`) using a key held in **Supabase Vault**.
- `key_last4`, `status` (`unverified` / `verified` / `invalid`), `verified_at`.

Guarantees:

1. **The browser never reads the raw secret back.** Direct table access is denied to
   `anon`/`authenticated` by RLS. Clients write credentials only through the
   `SECURITY DEFINER` RPC `upsert_delta_credentials`, which checks account ownership
   and encrypts the secret server-side.
2. **Only the engine can decrypt.** `get_delta_credentials_decrypted` is the single
   decrypt path and is granted to `service_role` **only** — the headless engine uses
   it in Stage 2.
3. Owners can read non-secret metadata (api_key, last-4, status) via
   `get_delta_credentials_meta` for display in the Edit modal.

### One-time setup (run once in the Supabase SQL editor)

Apply the migration, then create the Vault encryption key:

```sql
-- 1. Apply schema (fresh installs: supabase_schema.sql already includes section 8;
--    existing DBs: run supabase_migrations/001_delta_live_accounts.sql)

-- 2. Create the encryption key (replace with a long random string, store it safely):
select vault.create_secret('REPLACE-WITH-LONG-RANDOM-STRING', 'delta_cred_encryption_key');
```

Without the Vault secret, `upsert_delta_credentials` raises
`Encryption key not configured` and no credentials can be stored.

## Verify flow (Stage 1)

When creating or editing a **live** account, the modal exposes API key + secret
inputs and a **Verify Connection** button. Verification
(`src/deltaAuth.js → verifyDeltaCredentials`) signs a test request **in the browser**
using the just-entered secret (Web Crypto HMAC-SHA256) and hits a lightweight
authenticated endpoint (`GET /v2/wallet/balances`) through the existing `/api` proxy.

The secret used for verification is the one the user just typed — nothing is read
back from storage, so verification introduces no exposure. On submit, the verified
flag is passed to `upsert_delta_credentials` so the stored row's `status` reflects it.

> Delta rejects signatures older than 5 seconds, so the request is signed immediately
> before sending.

## Delta Exchange auth reference

- **Base URL:** `https://api.india.delta.exchange` (same host used for market data).
- **Auth headers:** `api-key`, `signature`, `timestamp`.
- **Signature:** `HMAC_SHA256(secret, method + timestamp + requestPath + query + body)`,
  hex-encoded. `timestamp` is Unix seconds.
- **Order placement (Stage 2):** `POST /v2/orders` with `product_id`/`product_symbol`,
  `size`, `side` (`buy`/`sell`), `order_type` (`limit_order`), `limit_price` (string),
  `time_in_force`, `reduce_only`, `client_order_id`.

---

## Stage 2 — order execution (implemented)

**Engine components**

- `engine/lib/deltaTradeApi.js` — signed (HMAC-SHA256) client: `placeOrder`,
  `cancelOrder`, `getLivePositions`, `getBalance`.
- `engine/lib/liveExecution.js` — the gated executor: `openSpread`, `closeLeg`,
  `reconcile`. Reads the `DELTA_LIVE_DRYRUN` flag and the per-account arm state.
- `engine/lib/supabase.js` — now prefers `SUPABASE_SERVICE_ROLE_KEY` so the engine
  can decrypt credentials.

**Execution hooks** in `engine/paperTradingEngine.js` — all gated on
`mode === 'live' && live_enabled`, added alongside the existing DB writes so paper
logic is byte-for-byte unchanged when paper/disarmed:

| Point | Live order |
| --- | --- |
| Entry (before `active_positions` insert) | Buy long @ ask (limit) + sell short @ bid (limit). **A failed live send aborts the insert** — no phantom position. |
| Short-leg exit | Buy-to-close short (`reduce_only`) @ ask |
| Long laddered exit | Sell-to-close the cycle's long lot (`reduce_only`) @ bid |
| Partial ratio scale-down | Sell-to-close the reduced buy lot (`reduce_only`) @ bid |
| Full ATM/ITM/OTM exit | Sell long + buy short (`reduce_only`) |
| **Expiry / zombie exit** | **No order** — Delta cash-settles expired options exchange-side |

All orders use limit orders at the engine's computed price and carry a
`client_order_id` derived from the position id + leg + stage (idempotency).

**Safety layer**

- `DELTA_LIVE_DRYRUN` (default **true**): intended orders are logged (`🧪 DRY-RUN…`)
  but never sent.
- Per-account `live_enabled` kill-switch (schema + UI).
- Missing service_role key or missing credentials ⇒ live trading disabled; paper
  trading unaffected.
- `getLivePositions()` reconciliation runs on the 5-minute sync (log-only) and warns
  on drift between engine and exchange.

### ⚠ Open item — contract size mapping (validate in dry-run)

The paper engine sizes positions as **fractional notional lots** (contract_size
scaled). Delta orders take an **integer number of contracts**. The current mapping
(`longContracts` / `shortContracts` in `liveExecution.js`) is **best-effort**
(≈1 contract per long unit, rounded `sellQty` for the short) and rounds fractional
scale-downs up to a minimum of 1 contract.

**Before arming any account:** run in dry-run and confirm the logged `size` on each
`🧪 DRY-RUN` line matches the real contract quantity you intend to trade. If your
intended sizing differs (e.g. you trade fixed contract counts), the mapping needs to
be adjusted to your convention first.

### Rollout checklist

1. Set `SUPABASE_SERVICE_ROLE_KEY` in the engine env; keep `DELTA_LIVE_DRYRUN=true`.
2. Restart the engine; confirm the log shows `Delta credentials loaded … Dry-run: ON`.
3. Let it run; watch the `🧪 DRY-RUN live order` lines at real entry/exit events and
   validate sides, symbols, prices, and **sizes**.
4. When satisfied, set `DELTA_LIVE_DRYRUN=false`, restart, and arm a single account
   (`live_enabled = true`) with small size to confirm real fills before scaling.
