# Setup — Running OptionScope Locally

This guide takes you from a fresh clone to a running dashboard and engine. For deploying
to production (VPS + Vercel) see [OPERATIONS.md](OPERATIONS.md); for the database see
[MIGRATIONS.md](MIGRATIONS.md).

OptionScope has **two independent Node projects** in one repo:

| Part | Folder | What it is | Runs on |
|---|---|---|---|
| Dashboard | repo root (`src/`) | React 19 + Vite 8 + Tailwind 4 app — scanners, Paper Trading UI, Daily Report, Slippage | Browser (Vercel in prod) |
| Engine | `engine/` | Headless Node.js process that scans, enters and exits for **every** account (paper and live) | VPS under PM2 in prod |

Both talk to the same **Supabase** project. The dashboard never places trades — only the
engine does.

---

## 1) Prerequisites

- **Node.js 20.19+ or 22.12+** (Vite 8's minimum; the engine runs on the same version).
- **npm** (lockfiles are `package-lock.json`).
- A **Supabase** project (free tier works for development).
- For live trading only: a **Delta Exchange India** account with an API key whose IP
  whitelist includes the machine the engine runs on. See [live_trading.md](live_trading.md).

## 2) Install

```bash
git clone <repo-url> Option_Scope
cd Option_Scope
npm install            # dashboard deps + husky git hooks (via the "prepare" script)
cd engine && npm install && cd ..
```

## 3) Database

Create the schema in your Supabase project by following
[MIGRATIONS.md → Fresh database](MIGRATIONS.md#fresh-database). In short: run
`supabase_schema.sql`, create the Vault key, run
`supabase_migrations/ALL_MIGRATIONS.sql` and `017_realtime_config_schedules.sql`, then
enable Realtime on the remaining tables listed there.

Then sign up once through the app (email login) and promote yourself to admin in the SQL
editor:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

## 4) Environment variables

There are **two** env files. Copy each example and fill it in:

```bash
cp .env.example .env                 # dashboard (read by Vite, exposed to the browser)
cp engine/.env.example engine/.env   # engine (server-side only)
```

Minimum to get running:

| File | Variable | Required | Notes |
|---|---|---|---|
| `.env` | `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `.env` | `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon key (public by design; RLS protects data) |
| `engine/.env` | `SUPABASE_URL` | yes | Same project URL |
| `engine/.env` | `SUPABASE_ANON_KEY` | yes | Used only if no service-role key is set |
| `engine/.env` | `SUPABASE_SERVICE_ROLE_KEY` | live only | Without it live trading is disabled; paper still runs |
| `engine/.env` | `DELTA_LIVE_DRYRUN` | — | Defaults to `true`. **Leave it on** in development |

> ⚠️ Anything prefixed `VITE_` is compiled into the browser bundle and is visible to anyone
> who opens the site. Never put a service-role key, Delta secret or bot token in `.env`.

The full list (with defaults) is in [OPERATIONS.md → Environment variables](OPERATIONS.md#environment-variables).

## 5) Run

Two terminals:

```bash
# Terminal 1 — dashboard on http://localhost:5173
npm run dev

# Terminal 2 — engine (auto-restarts on file changes)
cd engine
npm run dev        # = node --watch index.js
```

In development, Vite proxies `/api/*` to `https://api.india.delta.exchange` (see
`vite.config.js`), so the browser can call Delta's public REST API without CORS errors.
In production `vercel.json` does the same rewrite.

**Check it works:**
1. Log in, create a **paper** account, set a schedule window and click **Apply**.
2. The engine log should show the account starting and its heartbeat; the dashboard's
   heartbeat countdown should turn green within ~30s.
3. The Ratio Spread Scanner tab works without the engine — it streams Delta directly.

> Running the engine locally against the **production** Supabase project will make two
> engines evaluate the same accounts and double-book trades. Always use a separate
> Supabase project for development. See [OPERATIONS.md → Single-instance rule](OPERATIONS.md#single-instance-rule).

## 6) Useful scripts

| Where | Command | What it does |
|---|---|---|
| root | `npm run dev` | Vite dev server |
| root | `npm run build` | Production build into `dist/` |
| root | `npm run preview` | Serve `dist/` locally |
| root | `npm run lint` | ESLint over the whole repo |
| root | `npm run lint:engine` | ESLint over `engine/**/*.js` only |
| engine | `npm start` | `node index.js` (production entry) |
| engine | `npm run dev` | `node --watch index.js` |

`engine/package.json` also defines `start:paper` and `start:atm`; they pass an argument
that `engine/index.js` no longer reads, so both behave exactly like `npm start`.

## 7) Git hooks

`npm install` installs a **husky** pre-commit hook (`.husky/pre-commit`). When a commit
stages any `engine/**/*.js` file it runs ESLint on those files and blocks the commit on
errors — mainly to catch undefined variables (`no-undef`) in engine code, which would
otherwise surface only at runtime on the live box. Commits that touch no engine file skip
it. Bypass only when you are sure: `git commit --no-verify`.

## 8) Tests

There is no automated test suite. Changes are validated on **paper** accounts first
(strategy version 2), then promoted to live — see *Strategy Versioning* in
[paper_trading_explained.md](paper_trading_explained.md). Live changes are validated in
dry-run (`DELTA_LIVE_DRYRUN=true`) before an account is armed.

## Where to read next

- New to the trading terms? → [GLOSSARY.md](GLOSSARY.md)
- How the system fits together → [HLD.md](HLD.md)
- Code-level detail → [LLD.md](LLD.md)
