# Portfolio (web)

Next.js + TypeScript + Postgres rewrite of the portfolio tracker, built for
Vercel deployment. See the repo root [`README.md`](../README.md) for the
full project status, spec, and roadmap, and [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
for how to actually put this on Vercel.

**Why a rewrite, and why this stack:** the original build (repo root:
`portfolio/`, `dashboard.py`) used SQLite + Streamlit, which can't run on
Vercel — Vercel's compute is stateless/serverless (no persistent local file,
no long-running process), which both SQLite and Streamlit need. This app
replaces both: Postgres (works over the network, fits serverless) and
Next.js (a real long-lived-connection-free request/response app, which
serverless is built for).

## Status

**R1: transactions data model + CSV upload**, ported from the Python
version's Phase 1, with the schema, validation rules, dedup approach, and
conventions unchanged — see [`src/lib/importer.ts`](./src/lib/importer.ts)'s
docstring and the root README's "Holdings & value/profit conventions"
section (still accurate; the computation logic itself isn't ported yet).

Not built yet: prices import, holdings/value computation, dashboard,
password gate, live connectors, research tool.

## Stack

- **Next.js 16** (App Router) + TypeScript, React 19
- **Postgres** via the standard `pg` driver — works identically against a
  local Postgres (dev/test) and a hosted one (Neon / Vercel Postgres in
  production); no code changes needed between them
- **Vitest**, tested against a real local Postgres database (not mocked) —
  same philosophy as the Python version's tests

## Local setup

Requires Node 20+ and a local Postgres.

```bash
cd web
npm install
cp .env.example .env.local   # then fill in DATABASE_URL
```

Create the dev + test databases (adjust names/credentials to match
`.env.local`):

```bash
sudo -u postgres psql -c "CREATE ROLE portfolio WITH LOGIN PASSWORD 'portfolio_dev_only';"
sudo -u postgres psql -c "CREATE DATABASE portfolio_dev OWNER portfolio;"
sudo -u postgres psql -c "CREATE DATABASE portfolio_test OWNER portfolio;"
```

The schema is created automatically on first use (every API route calls an
idempotent `ensureSchema()` before touching the DB) — no separate migration
step needed yet.

## How to test this slice

1. **Automated tests** — real Postgres, not mocked, covering the same rules
   as the Python version's `test_importer.py` (import, idempotent
   re-import, dedup, every validation rule, all-or-nothing rollback), plus
   a quoted-CSV-field case:
   ```bash
   npm test        # expect 11 passed
   npx tsc --noEmit # type-check
   npm run lint
   ```

2. **Manual walkthrough**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`, upload
   `../sample_data/transactions_sample.csv`. Expect: `Read 7 row(s)`,
   `Created 4 new asset(s)`, `Inserted 7 new transaction(s)`,
   `Skipped 0 duplicate(s)`. Upload the same file again — expect
   `Inserted 0` / `Skipped 7`. Verify directly in Postgres:
   ```bash
   psql "$DATABASE_URL" -c "SELECT date, type, quantity, price FROM transactions t JOIN assets a ON a.id = t.asset_id ORDER BY date;"
   ```
   Dates should read back exactly as in the CSV (e.g. `2024-01-05`) — the
   DB driver is configured to keep `DATE` columns as plain strings rather
   than JS `Date` objects specifically to avoid timezone-shift bugs here.

## Roadmap

1. ~~Transactions data model + CSV upload~~ ✅ (R1)
2. Prices CSV upload + holdings/value/profit computation (port of
   `portfolio/holdings.py` + `valuation.py` + `price_importer.py`) + a
   dashboard page
3. Password gate (single shared password via middleware)
4. Deploy to Vercel + Neon — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
5. Live price connector: yfinance-equivalent
6. Bolero CSV/Excel import adapter
7. TradeRepublic via `pytr`
8. Crypto: exchange API(s) + CoinGecko prices
9. Gold: manual entry + spot price API
10. Remaining computed metrics: forecast, TWR, dividends, risk/diversification, rebalancing flags, FX conversion
11. Ad-hoc research tool (Claude API + web search)

## A note on `.env.local` in this dev container

The `DATABASE_URL`/`TEST_DATABASE_URL` values checked against in this
sandboxed build session point at a local Postgres with a throwaway
password (`portfolio_dev_only`) that only exists inside this ephemeral
container — not a real credential, nothing to rotate. `.env.local` is
gitignored either way and was never committed.
