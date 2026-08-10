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

**R5: live stock/ETF prices from Twelve Data**, on top of R1-R4
(transactions/prices CSV upload, computed holdings/value/profit, a
dashboard, a password gate on every route, deployed and live on Vercel +
Neon). Same schema, validation rules, dedup approach, and computation
conventions as the original Python build throughout — see
[`src/lib/importer.ts`](./src/lib/importer.ts),
[`src/lib/priceImporter.ts`](./src/lib/priceImporter.ts),
[`src/lib/holdings.ts`](./src/lib/holdings.ts),
[`src/lib/valuation.ts`](./src/lib/valuation.ts), and
[`src/lib/priceRefresh.ts`](./src/lib/priceRefresh.ts) docstrings, plus the
root README's "Holdings & value/profit conventions" section (still
accurate).

**First connector, first pivot:** R5 originally shipped on Yahoo Finance
(via `yahoo-finance2`, an unofficial wrapper — the direct TS equivalent of
the spec's `yfinance`). Live-tested on the deployed app, it worked
end-to-end but failed for both real assets in the sample data — correctly,
not buggily: one ISIN Yahoo can't resolve, one ETF ticker that needs an
exchange suffix Yahoo doesn't infer on its own. Switched to Twelve Data —
an official, documented, key-based API — on request, on the reasoning that
the underlying ISIN/ticker mismatch problem isn't provider-specific anyway
(see `assets.price_symbol` below), so an official API was worth trading a
"no key needed" connector for.

- `/` — dashboard: totals by currency + a positions table (quantity, price,
  value, cost basis, profit, profit %). Server-rendered, always fresh
  (`force-dynamic`) — never cached, since this is financial data.
- `/import` — live price refresh (stocks/ETFs) + upload forms for
  transactions and prices CSVs, CSV remaining the fallback per the spec's
  design rule.
- `GET /api/positions` — the dashboard's data as JSON, for reuse (scripts,
  a future mobile view, the research tool later on).
- `POST /api/prices/refresh` — fetches recent daily closes from
  [Twelve Data](https://twelvedata.com) for every stock/ETF asset, upserts
  into `prices`. Best-effort per asset, unlike the CSV importers: one bad
  symbol doesn't block the rest. Free tier is 800 requests/day, 8/minute —
  a refresh paces itself at ~1 asset/8s to stay under that, so refreshing
  ~20 assets takes a couple of minutes (the button/page waits for it; see
  `maxDuration` in the route). `assets.price_symbol` overrides the lookup
  ticker when `symbol` isn't a valid ticker (e.g. it's an ISIN, or a
  non-US listing needs an exchange suffix) — no UI to edit it yet, set
  directly via SQL if you need it before that lands.
- `/login` + a single shared password (`DASHBOARD_PASSWORD`) gate every
  other route, including the API routes — see `src/lib/auth.ts` and
  `src/proxy.ts` (Next.js 16 renamed `middleware.ts` to `proxy.ts`; same
  mechanism).
- Deployed on Vercel (Root Directory `web`, Framework Preset **Next.js** —
  not auto-detected correctly the first time, see `../DEPLOYMENT.md`),
  Postgres on Neon (pooled connection string).

**Verified live, end to end, on the deployed app** (this dev session's own
network couldn't reach `api.twelvedata.com` — confirmed via the proxy's
diagnostics — so this had to happen on the real deployment, not here). Two
rounds:

1. First live attempt surfaced a real bug: `fetchDailyCloses` called
   `res.json()` unconditionally, so the sandbox's plain-text proxy-block
   response produced a useless `"Unexpected token 'H'..."` error instead of
   saying what actually happened. Fixed to parse defensively and surface
   `HTTP <status> <statusText> — <body>` instead — see
   `tests/twelveDataPrices.test.ts` for a test reproducing the exact
   scenario.
2. Second live attempt, after the fix and with a real US ticker (`AAPL`)
   added to the DB: **genuine success** — `1 succeeded`, 6 new prices
   written, real closes from Twelve Data's API in `prices` with
   `source = 'twelvedata'`.

**Real limitation found, not a bug:** Twelve Data's free tier doesn't cover
`IWDA` (a European-listed ETF) — its own error message says that symbol
needs the paid Grow/Venture plan. Confirmed the pattern by exchange, not
just by ISIN-vs-ticker format: **free-tier Twelve Data reliably covers US
tickers; most non-US exchanges are paywalled.** If your real holdings lean
European (likely, given Bolero), this connector alone won't cover most of
your actual portfolio on the free tier — worth deciding explicitly whether
to upgrade Twelve Data, add another provider for non-US listings, or park
this and rely on manual CSV for European assets for now.

Not built yet: remaining connectors (Bolero, TradeRepublic, crypto, gold), research tool.

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
   quoted-CSV-field case and the auth logic (password check, cookie token
   round-trip/tamper rejection, login/logout routes, fail-closed behavior
   when `DASHBOARD_PASSWORD` is unset):
   ```bash
   npm test         # expect 58 passed
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
   Set `DASHBOARD_PASSWORD` in `.env.local` first. Open
   `http://localhost:3000` — expect an immediate redirect to `/login`
   (unauthenticated). A wrong password should show "Incorrect password"
   and not log you in. The correct password should land you on the
   dashboard; with an empty DB it shows "No holdings yet" and a link to
   `/import`.

   Upload `../sample_data/transactions_sample.csv`, then
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

   Click **Log out**, confirm you land back on `/login`, and that visiting
   `/` again redirects you there too rather than showing stale data. Try
   `curl -i http://localhost:3000/api/positions` with no cookie — expect
   `401`.

   Verify dates directly in Postgres:
   ```bash
   psql "$DATABASE_URL" -c "SELECT date, type, quantity, price FROM transactions t JOIN assets a ON a.id = t.asset_id ORDER BY date;"
   ```
   Dates should read back exactly as in the CSV (e.g. `2024-01-05`) — the
   DB driver is configured to keep `DATE` columns as plain strings rather
   than JS `Date` objects specifically to avoid timezone-shift bugs here.

3. **Needs a real machine with network access — confirmed working on the
   deployed app, this dev session can't do it.** Get a free key at
   [twelvedata.com](https://twelvedata.com), set `TWELVEDATA_API_KEY`, then
   click **"Refresh from Twelve Data"** on `/import` (with `IWDA` and
   `US0378331005` present from the sample data above). Expect:
   - `IWDA` fails: *"This symbol is available starting with the Grow or
     Venture plan"* — a real free-tier coverage limit, not a bug (see
     Status above).
   - `US0378331005` fails: Apple's ISIN isn't a valid symbol format for
     this (or most) providers.
   - Add a real US-listed asset (import a one-off transaction with
     `asset_symbol=AAPL`) and refresh again — expect `1 succeeded`, several
     new prices, and `SELECT * FROM prices WHERE asset_id = (SELECT id
     FROM assets WHERE symbol = 'AAPL')` showing real recent closes with
     `source = 'twelvedata'`.

## Roadmap

1. ~~Transactions data model + CSV upload~~ ✅ (R1)
2. ~~Prices CSV upload + holdings/value/profit computation + a dashboard page~~ ✅ (R2)
3. ~~Password gate (single shared password via proxy)~~ ✅ (R3)
4. ~~Deploy to Vercel + Neon~~ ✅ (R4) — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
5. ~~Live price connector: yfinance-equivalent~~ ✅ (R5) — not yet verified against the live API from this dev session, see Status above
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
