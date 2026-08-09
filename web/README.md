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

**R2: prices CSV upload + computed holdings/value/profit + a dashboard**,
ported from the Python version's Phases 1-2-3. Same schema, validation
rules, dedup approach, and computation conventions throughout — see
[`src/lib/importer.ts`](./src/lib/importer.ts),
[`src/lib/priceImporter.ts`](./src/lib/priceImporter.ts),
[`src/lib/holdings.ts`](./src/lib/holdings.ts), and
[`src/lib/valuation.ts`](./src/lib/valuation.ts) docstrings, plus the root
README's "Holdings & value/profit conventions" section (still accurate).

- `/` — dashboard: totals by currency + a positions table (quantity, price,
  value, cost basis, profit, profit %). Server-rendered, always fresh
  (`force-dynamic`) — never cached, since this is financial data.
- `/import` — upload forms for transactions and prices CSVs.
- `GET /api/positions` — the dashboard's data as JSON, for reuse (scripts,
  a future mobile view, the research tool later on).

Not built yet: password gate, live connectors, research tool.

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
   as the Python version's test suite (import, idempotent re-import, dedup,
   every validation rule, all-or-nothing rollback, holdings computation,
   value/profit math checked against hand-calculated numbers), plus a
   quoted-CSV-field case:
   ```bash
   npm test         # expect 27 passed
   npx tsc --noEmit # type-check (run `npm run build` first if this is a fresh checkout — see note below)
   npm run lint
   npm run build    # confirms it actually builds for production
   ```
   Note: a bare `npx tsc --noEmit` needs Next's generated route types
   (`.next/types/`), which only exist after a `dev` or `build` run. If it
   complains about `LayoutProps`, run `npm run build` once first.

2. **Manual walkthrough**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` — with an empty DB it shows "No holdings
   yet" and a link to `/import`. Upload
   `../sample_data/transactions_sample.csv`, then
   `../sample_data/prices_sample.csv`. Expect transactions: `Read 7 row(s)`,
   `Created 4 new asset(s)`, `Inserted 7`, `Skipped 0`; prices: `Read 3
   row(s)`, `Inserted 3`, `Updated 0`, `Unchanged 0`. Re-upload either file
   — expect all `Inserted`/duplicate counts to flip to 0/skipped or
   0/unchanged.

   Back on `/`, expect: **EUR 9,662.50** (+440.60 profit), **USD 975.00**
   (+71.75 profit), and 4 positions — IWDA 2,412.50 EUR (+295.60), BTC
   2,250.00 EUR (+145.00), AAPL 975.00 USD (+71.75), EUR_CASH 5,000.00 EUR
   flat. Try it at a narrow (phone-width) browser window too — the
   positions table should scroll horizontally within its own box; the page
   itself should never need horizontal scrolling.

   Verify dates directly in Postgres:
   ```bash
   psql "$DATABASE_URL" -c "SELECT date, type, quantity, price FROM transactions t JOIN assets a ON a.id = t.asset_id ORDER BY date;"
   ```
   Dates should read back exactly as in the CSV (e.g. `2024-01-05`) — the
   DB driver is configured to keep `DATE` columns as plain strings rather
   than JS `Date` objects specifically to avoid timezone-shift bugs here.

## Roadmap

1. ~~Transactions data model + CSV upload~~ ✅ (R1)
2. ~~Prices CSV upload + holdings/value/profit computation + a dashboard page~~ ✅ (R2)
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
