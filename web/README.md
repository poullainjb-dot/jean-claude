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

**R7: TradeRepublic import**, on top of R6 (Bolero import), R5 (live
stock/ETF prices with real international coverage), and R1-R4
(transactions/prices CSV upload, computed holdings/value/profit, a
dashboard, a password gate on every route, deployed and live on Vercel +
Neon). Same schema, validation rules, dedup approach, and computation
conventions as the original Python build throughout — see
[`src/lib/importer.ts`](./src/lib/importer.ts),
[`src/lib/priceImporter.ts`](./src/lib/priceImporter.ts),
[`src/lib/holdings.ts`](./src/lib/holdings.ts),
[`src/lib/valuation.ts`](./src/lib/valuation.ts),
[`src/lib/priceRefresh.ts`](./src/lib/priceRefresh.ts), and
[`src/lib/boleroPositionsImporter.ts`](./src/lib/boleroPositionsImporter.ts)
docstrings, plus the root README's "Holdings & value/profit conventions"
section (still accurate).

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
   coverage, and its actual exchange coverage is broad and free.
   Live-verified the full fallback chain end to end, including that
   `price_symbol` overrides correctly reach both providers.
4. **Reordered: Yahoo first, Twelve Data second.** Most real portfolios
   here lean non-US, so Twelve Data-first meant paying its 8s/request
   rate-limit pacing on a call that predictably fails for most assets.
   Yahoo now goes first (covers what's actually held, fast when it
   works); Twelve Data stays as the fallback — the backstop for whenever
   Yahoo's unofficial API has an outage or gets blocked, and still the
   more reliable path specifically for US tickers.

- `/` — dashboard: totals by currency + a positions table (quantity, price,
  value, cost basis, profit, profit %). Server-rendered, always fresh
  (`force-dynamic`) — never cached, since this is financial data.
- `/assets` — read-only listing of every asset and its current
  `price_symbol` (if any), so you can see what's mapped without SQL.
- `/import` — live price refresh, price-symbol overrides, upload forms for
  transactions/prices CSVs (CSV remaining the fallback per the spec's
  design rule), and the Bolero portfolio-snapshot importer (R6).
- `POST /api/transactions/import-bolero-positions` — Bolero "Portfolio
  Positions" .xlsx snapshot import; see the R6 writeup below for the
  synthetic-transaction/upsert approach.
- `GET /api/positions` — the dashboard's data as JSON, for reuse (scripts,
  a future mobile view, the research tool later on).
- `POST /api/prices/refresh` — for every stock/ETF asset, tries Yahoo
  Finance then [Twelve Data](https://twelvedata.com), in order, stopping
  at the first provider with data; upserts into `prices` with `source` set
  to whichever provider actually succeeded. Yahoo goes first since it
  covers what most real portfolios here actually hold (non-US-heavy);
  Twelve Data is the fallback (official, reliable for US tickers, backstop
  if Yahoo's unofficial API has an outage). Best-effort per asset, unlike
  the CSV importers: one bad symbol doesn't block the rest, and a failure
  reports what *each* provider said (`"yahoo: ...; twelvedata: ..."`), not
  just the last one tried. Paced per-provider (Yahoo: no published limit,
  still paced conservatively; Twelve Data's free tier: 8/minute) —
  spacing only applies to consecutive calls to the *same* provider, so
  most refreshes rarely pay Twelve Data's slower pace at all now that it's
  the fallback rather than the default. See `maxDuration` in the route
  for the practical effect on refresh duration.
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

**Fully confirmed working, on a real device:** `IWDA`, `US0378331005`
(mapped via `price_symbol`), and `AAPL` all succeeded via the Yahoo
fallback — `3 succeeded, 0 failed`, 9 new prices, 8 updated — tested from
a phone, not just a desktop browser. This is the real end-to-end
confirmation the whole chain (price_symbol overrides, Yahoo fallback, the
`validateResult: false` fix) genuinely works with live data, which this
dev session's network could never fully verify on its own.

**R6: Bolero import, built against the format Bolero actually gives you.**
The plan going in was a transaction-history CSV adapter, matching the CSV
importer pattern the rest of the app uses. That's not what came back: the
transaction-history export Bolero documents wasn't practically reachable,
so what got sent instead was the **Portfolio Positions** Excel export
(Portfolio → Posities → export icon → Excel) — a point-in-time snapshot of
current holdings (quantity, average cost, ISIN, currency) with no
individual buy/sell events, dates, or fees. Rather than block on an export
that wasn't actually obtainable, the importer was built for the real
format:

- Each holding becomes one synthetic `buy` transaction at its average
  cost, dated to the export's own "Imprimé le" timestamp — see
  [`src/lib/boleroPositionsImporter.ts`](./src/lib/boleroPositionsImporter.ts)
  for the full reasoning. Trades away real history (exact trade dates,
  per-trade fees, realized P&L and dividends before the first import) for
  zero-friction onboarding; valuation from the import date forward is
  exact.
- **Snapshot semantics, not additive.** Re-uploading a later export
  updates each holding's synthetic transaction in place (upsert, keyed by
  a hash of a fixed source tag + ISIN — not by date/quantity like the
  regular CSV importer) and deletes the synthetic transaction for any
  position no longer present (i.e. fully sold). Verified live against the
  actual uploaded export: first import creates 7 assets/transactions;
  re-importing the identical file updates all 7 with zero new inserts;
  dropping a holding from the export removes its synthetic transaction
  without touching the asset or a manually-imported transaction for the
  same asset.
- Assets are keyed by **ISIN** (what Bolero's export actually gives, not
  a ticker) — pair with the existing `price_symbol` tool (`/assets`, R5)
  to map each ISIN to something a price provider resolves.
- Parses real Bolero's export layout directly: the workbook interleaves a
  blank spacer column between every real column (a merged-cell export
  artifact), and there's no separator between the position table and a
  disclaimer footer other than the data itself — this is handled by
  reading column values at fixed positions anchored to the header row
  (not independently re-compacting each row, which would silently misalign
  any row with a legitimately blank interior cell), and detecting the
  table's end by the rightmost (ISIN) column going blank, verified against
  the real file's exact footer/address-block layout rather than guessed.
  An unrecognized `Type` (only `Actions`/`ETF` are mapped) is a validation
  error, not a silent skip — a bond or fund holding shouldn't just vanish.
- Uses `exceljs`, not the more common `xlsx` (SheetJS) package — SheetJS's
  npm release is stuck on a version with unfixed prototype-pollution/ReDoS
  advisories that a malicious upload could hit directly, since parsing an
  untrusted upload is exactly that attack surface.
- New route: `/import` → "Bolero — portfolio snapshot" section,
  `POST /api/transactions/import-bolero-positions`.

**R7: TradeRepublic import, via a local script — "Option A."**
TradeRepublic doesn't offer any export button; the only practical path out
is a third-party tool ([`pytr`](https://github.com/pytr-org/pytr)) that
runs entirely on your own machine and talks to TradeRepublic's app API the
same way the TradeRepublic app does. Credentials and 2FA approval never
touch this app, Vercel, or this repo's code — pytr produces a CSV on your
disk, and a new local converter (`scripts/traderepublic/`, repo root, not
part of this Next.js app) turns *that* into this app's existing
transactions CSV format, for upload the normal way. See
[`scripts/traderepublic/README.md`](../scripts/traderepublic/README.md)
for the full walkthrough.

- **Every trade/dividend gets a matching cash leg**, not just the
  security-side row — a synthetic `EUR_CASH` deposit/withdrawal alongside
  each `buy`/`sell`/`dividend`. The app's model is deliberately
  single-entry (a `buy` doesn't auto-decrement cash — see "Holdings &
  value/profit conventions" in the root README), but TradeRepublic really
  is one unified cash+securities account, and pytr's export gives the real
  cash effect of every event — reproducing that is what makes the
  dashboard's per-currency totals reflect actual cash and actual invested
  capital, instead of double-counting money that moved from cash into a
  position.
- **A real bug, caught by testing against a real local Postgres import
  before shipping, not just eyeballing the SQL:** the first version of the
  sign convention put a *negative* quantity on `withdrawal`-type rows
  (`REMOVAL`, `FEES`, `TAXES`). That's backwards — `withdrawal` already
  subtracts `quantity` in the app's own SQL (`COST_BASIS_SQL` /
  `computeHoldings`), so a negative quantity there double-negates and
  *increases* cash on a withdrawal instead of decreasing it. Caught by
  actually running a deposit-then-withdrawal through
  `importTransactionsCsv` → `computeHoldings` against local Postgres and
  checking the number, not by re-reading the SQL more carefully. Fixed:
  `withdrawal` (and `deposit`) always take a positive quantity; `interest`
  is the one type that takes a signed quantity directly, since the schema
  has no separate "interest charge" type — verified the same way.
- Corporate actions/transfers (`SPINOFF`, `SPLIT`, `SWAP`, `TRANSFER_IN`,
  `TRANSFER_OUT`) aren't guess-mapped — they're written to a `.review.csv`
  file alongside the output instead, same "flag it, don't guess"
  principle as the Bolero importer's unsupported-`Type` handling.
- Pure stdlib Python (no dependency beyond what `pytr` itself needs) —
  deliberately, so a security-conscious reader can audit the whole
  converter at a glance. 22 unit tests, no DB needed
  (`scripts/traderepublic/test_converter.py`), covering the full
  type/sign-mapping table; the sign convention itself was additionally
  checked against real local Postgres as described above.

Not built yet: crypto, gold connectors; remaining computed metrics;
research tool.

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
   npm test         # expect 87 passed
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
   it, but it's been confirmed working on the deployed app, including from
   a phone.** Get a free key at [twelvedata.com](https://twelvedata.com),
   set `TWELVEDATA_API_KEY` (optional now that Yahoo is the primary
   provider, but keeps the fallback alive), then upload
   `sample_data/price_symbols_sample.csv` under "Price symbols" (sets
   `IWDA` → `IWDA.AS`, `US0378331005` → `AAPL` — check `/assets` to
   confirm) and click **"Refresh live prices"** on `/import`. Expect all
   three sample assets (`AAPL`, `IWDA`, `US0378331005`) to succeed via
   Yahoo. Verify with `SELECT * FROM prices p JOIN assets a ON a.id =
   p.asset_id WHERE a.symbol IN ('IWDA', 'AAPL', 'US0378331005')` — expect
   `source = 'yahoo'` and dates matching Yahoo Finance's own site.

4. **Bolero snapshot import — no network access needed, testable locally.**
   Export your Bolero portfolio (Portfolio → Posities → export icon →
   Excel) and upload it under "Bolero — portfolio snapshot" on `/import`.
   Expect one asset + one `buy` transaction per holding, `source =
   'bolero-snapshot'` — check with `SELECT symbol, price_symbol FROM
   assets` (ISINs, no ticker yet) and `SELECT * FROM transactions WHERE
   source = 'bolero-snapshot'`. Re-upload the same file: expect
   `Updated: N, Inserted: 0` and no new rows. Set `price_symbol` for each
   ISIN (see the R5 test above) so live price refresh can find them.

## Roadmap

1. ~~Transactions data model + CSV upload~~ ✅ (R1)
2. ~~Prices CSV upload + holdings/value/profit computation + a dashboard page~~ ✅ (R2)
3. ~~Password gate (single shared password via proxy)~~ ✅ (R3)
4. ~~Deploy to Vercel + Neon~~ ✅ (R4) — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
5. ~~Live price connector: yfinance-equivalent~~ ✅ (R5) — not yet verified against the live API from this dev session, see Status above
6. ~~Bolero import adapter~~ ✅ (R6) — positions-snapshot approach, see Status above; not a real transaction-history import (Bolero doesn't offer a low-friction one — see the R6 writeup)
7. ~~TradeRepublic via `pytr`~~ ✅ (R7) — local script, see Status above and [`scripts/traderepublic/README.md`](../scripts/traderepublic/README.md)
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
