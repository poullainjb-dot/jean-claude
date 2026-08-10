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

**R5: live stock/ETF prices, with real international coverage**, on top of
R1-R4 (transactions/prices CSV upload, computed holdings/value/profit, a
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

**How R5 actually got here — three rounds, each driven by what the
previous one revealed live, not by guessing upfront:**

1. **Yahoo Finance** (`yahoo-finance2`, unofficial, no key, the direct TS
   equivalent of the spec's `yfinance`). Worked end-to-end when live-tested,
   but failed both real sample assets — correctly, not buggily: an ISIN
   Yahoo can't resolve, and an ETF ticker needing an exchange suffix
   nothing was supplying.
2. **Switched to Twelve Data** (official, documented, key-based) on
   request. Live-tested, caught and fixed a real bug (see below), then
   confirmed genuine success with a real US ticker. But its free tier
   turned out to paywall most non-US exchanges — its own error names the
   Grow/Venture plan for a European ETF. Confirmed by exchange, not just
   by symbol format: **free-tier Twelve Data reliably covers US tickers;
   most non-US exchanges don't work on it at all.**
3. **Added Yahoo Finance back as a fallback**, once it became clear the
   European/international coverage gap wasn't a Yahoo-specific problem —
   Yahoo's original failure was a symbol-format issue, not missing
   coverage, and its actual exchange coverage is broad and free. Twelve
   Data is tried first per asset (official, works well for US), Yahoo
   catches what Twelve Data's free tier can't reach. Live-verified the
   full fallback chain end to end, including that `price_symbol`
   overrides correctly reach both providers.

- `/` — dashboard: totals by currency + a positions table (quantity, price,
  value, cost basis, profit, profit %). Server-rendered, always fresh
  (`force-dynamic`) — never cached, since this is financial data.
- `/assets` — read-only listing of every asset and its current
  `price_symbol` (if any), so you can see what's mapped without SQL.
- `/import` — live price refresh, price-symbol overrides, and upload forms
  for transactions/prices CSVs (CSV remaining the fallback per the spec's
  design rule).
- `GET /api/positions` — the dashboard's data as JSON, for reuse (scripts,
  a future mobile view, the research tool later on).
- `POST /api/prices/refresh` — for every stock/ETF asset, tries
  [Twelve Data](https://twelvedata.com) then Yahoo Finance, in order,
  stopping at the first provider with data; upserts into `prices` with
  `source` set to whichever provider actually succeeded. Best-effort per
  asset, unlike the CSV importers: one bad symbol doesn't block the rest,
  and a failure reports what *each* provider said
  (`"twelvedata: ...; yahoo: ..."`), not just the last one tried. Paced
  per-provider (Twelve Data's free tier: 8/minute; Yahoo: no published
  limit, still paced conservatively) — spacing only applies to consecutive
  calls to the *same* provider, so an asset falling back to Yahoo isn't
  also delayed by Twelve Data's slower pace. See `maxDuration` in the
  route for the practical effect on refresh duration.
- `POST /api/assets/price-symbols` + a CSV upload on `/import` —
  self-service bulk `price_symbol` overrides (`asset_symbol,price_symbol`
  columns; blank `price_symbol` clears an existing override). Built
  because there's no way for me to set these directly — I don't have
  database access to the deployed app.
- `/login` + a single shared password (`DASHBOARD_PASSWORD`) gate every
  other route, including the API routes — see `src/lib/auth.ts` and
  `src/proxy.ts` (Next.js 16 renamed `middleware.ts` to `proxy.ts`; same
  mechanism).
- Deployed on Vercel (Root Directory `web`, Framework Preset **Next.js** —
  not auto-detected correctly the first time, see `../DEPLOYMENT.md`),
  Postgres on Neon (pooled connection string).

**The real bug caught along the way:** `fetchDailyCloses` (Twelve Data)
called `res.json()` unconditionally — this dev session's network policy
returns a plain-text block page for blocked hosts, and that produced a
useless `"Unexpected token 'H'..."` error instead of saying what actually
happened. Fixed to parse defensively and surface
`HTTP <status> <statusText> — <body>` instead; verified live that the fix
produces a legible error, and added a test reproducing the exact scenario
in `tests/twelveDataPrices.test.ts`. Yahoo Finance's own error path turned
out not to need the same fix — its errors came back legible without it.

**Second real bug, caught by actually running the fallback live:** once
`price_symbol` correctly mapped `IWDA` → `IWDA.AS` and the request reached
real Yahoo Finance data (on the deployed app — this dev session's network
still can't reach either provider), it failed with *"Historical returned a
result with SOME (but not all) null values."* `yahoo-finance2`'s default
schema validation throws the entire call out if *any* row has a null field
— open/high/low/volume, not just close — which real Yahoo data legitimately
has for some tickers. Fixed by fetching with `validateResult: false` and
doing the null-filtering ourselves (which the code already had — it just
never got the chance to run, since the SDK threw first). See
`normalizeHistoricalRows` in `src/lib/yahooPrices.ts`, unit-tested against
this exact scenario in `tests/yahooPrices.test.ts`.

**What's still unverified from this session:** whether the fixed Yahoo
path now returns genuinely correct prices for `IWDA.AS` — the fix addresses
the exact error seen live, but this dev session still can't reach either
provider to confirm the corrected values are right. Check `source =
'yahoo'` rows in `prices` against Yahoo Finance's own site for that ticker.

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
   npm test         # expect 75 passed
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

3. **Needs a real machine with network access — this dev session can't do
   it.** Get a free key at [twelvedata.com](https://twelvedata.com), set
   `TWELVEDATA_API_KEY`, then click **"Refresh live prices"** on `/import`
   (with `IWDA` and `US0378331005` present from the sample data above).
   Confirmed working: `US0378331005` fails outright (Apple's ISIN isn't a
   valid symbol format for either provider) — but `IWDA` should now
   *succeed*, via the Yahoo Finance fallback, once you either:
   - upload `sample_data/price_symbols_sample.csv` under "Price symbols"
     first (sets `IWDA` → `IWDA.AS`, `US0378331005` → `AAPL` — check
     `/assets` to confirm they landed), or
   - add a real US-listed asset instead (import a one-off transaction with
     `asset_symbol=AAPL`) to at least confirm the Twelve Data path.

   This is the one specific thing left unverified from this dev session —
   whether Yahoo's fallback actually returns real data for `IWDA.AS` once
   it can reach the network. Check `SELECT * FROM prices p JOIN assets a
   ON a.id = p.asset_id WHERE a.symbol = 'IWDA'` — expect `source =
   'yahoo'` and dates matching Yahoo Finance's own site for that ticker.

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
