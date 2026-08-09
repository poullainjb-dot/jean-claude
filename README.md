# Portfolio App

An app that replaces Finary: tracks value/profit, forecasts future wealth,
and provides an ad-hoc research tool per ticker.

See [`portfolio-app-spec.md`](./portfolio-app-spec.md) for the full spec
this is built from (data sources, schema, computed metrics, research tool).

## Two builds in this repo

- **[`web/`](./web/)** — the current, active build. Next.js + TypeScript +
  Postgres, built to deploy on Vercel so the app is reachable from your
  phone/tablet/PC, not just one local machine. See
  [`web/README.md`](./web/README.md) and [`DEPLOYMENT.md`](./DEPLOYMENT.md).
- **`portfolio/` + `dashboard.py`** (repo root) — the original prototype:
  Python + SQLite + Streamlit, local-only. Kept as-is, not deleted, because
  it's tested and working — but it's no longer where new work happens. Its
  README section below still documents it accurately for anyone who wants
  to run it locally.

The switch happened because SQLite + Streamlit can't run on Vercel
(stateless serverless functions can't hold a persistent local file or a
long-running process) — see the `web/` README for the detailed reasoning.
One consequence worth naming: the original spec's "runs locally, nothing
routed through a third party" framing no longer fully holds once the app is
deployed to Vercel with a hosted Postgres DB — your data and API keys now
live on infrastructure you don't own, in exchange for being reachable from
all your devices. That trade-off was made deliberately, not silently.

## Status

**Python/Streamlit build (no longer active development): Phase 3 complete**
— read-only dashboard on top of Phase 1 (transactions data model + manual
CSV import) and Phase 2 (manual price import → computed holdings →
value/profit view). Still fully working; see below for how to run it.

**Next.js/Vercel build (active): R1 complete** — transactions data model +
CSV upload via a web UI, backed by Postgres. See
[`web/README.md`](./web/README.md) for its own status and roadmap.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill in real values later, as connectors are added — not needed for Phase 1
```

No API keys are required yet — Phase 1 only touches the local SQLite file.

## Data model

- **`assets`** — one row per ticker/ISIN/cash-bucket (`id`, `symbol`, `name`, `asset_class`, `currency`).
- **`transactions`** — the source of truth. Every buy/sell/deposit/withdrawal/interest/dividend, ever.
- **`prices`** — historical daily prices per asset, imported manually for now (Phase 4 adds a live yfinance feed).

Holdings, value, and P&L are never stored — they're always *computed* from
`transactions` + `prices`, so they can never drift out of sync. See
[`portfolio/schema.sql`](./portfolio/schema.sql) for the full DDL.

## CSV import format

Manual CSV is the fallback for **every** source, including Bolero and
TradeRepublic once those connectors exist — so it's worth knowing this format
even after live connectors are wired up.

Template: [`sample_data/transactions_template.csv`](./sample_data/transactions_template.csv) (header only).
Example: [`sample_data/transactions_sample.csv`](./sample_data/transactions_sample.csv) (dummy data, used by the tests).

| column | required | meaning |
|---|---|---|
| `date` | yes | `YYYY-MM-DD` |
| `asset_symbol` | yes | ticker or ISIN, e.g. `IWDA`, `US0378331005`, `BTC`, `EUR_CASH` |
| `asset_name` | only the *first* time a symbol appears | human-readable name, used to create the asset |
| `asset_class` | yes | `stock` / `etf` / `cash` / `gold` / `crypto` |
| `type` | yes | `buy` / `sell` / `deposit` / `withdrawal` / `interest` / `dividend` |
| `quantity` | yes | see convention below |
| `price` | yes | see convention below |
| `fees` | yes (`0` if none) | |
| `currency` | yes | 3-letter code, e.g. `EUR` |
| `source` | yes | `manual` for now; later also `bolero` / `traderepublic` / `binance` / ... |
| `notes` | no | free text |

**Convention (my call — not explicit in the spec, flagging it):** for
`buy`/`sell`, `quantity` = units traded and `price` = per-unit price. For pure
cash flows (`deposit`/`withdrawal`/`interest`/`dividend`), `quantity` = cash
amount and `price` = `1`. This keeps "value moved" always equal to
`quantity * price`, regardless of transaction type.

**Deduplication:** each transaction's id is a hash of
`(date, asset_symbol, asset_class, type, quantity, price, fees, currency, source)`.
Re-importing the same CSV (or a CSV that overlaps a previous one) is always
safe — duplicates are silently skipped, nothing is inserted twice.

**All-or-nothing:** if any row in a CSV fails validation, nothing from that
file is written — you get a full list of errors instead of a partially
imported mess.

## Prices CSV format

Template: [`sample_data/prices_template.csv`](./sample_data/prices_template.csv).
Example: [`sample_data/prices_sample.csv`](./sample_data/prices_sample.csv).

| column | required | meaning |
|---|---|---|
| `date` | yes | `YYYY-MM-DD` |
| `asset_symbol` | yes | must already exist — import its transactions first |
| `price` | yes | in the asset's own currency (see `assets.currency`) |
| `source` | yes | `manual` for now; later also `yfinance` / `coingecko` / ... |

Cash assets (`asset_class = cash`) never need a price row — they're always
worth `1` in their own currency by definition.

Re-importing a `(asset, date)` pair updates the price if it changed and is a
no-op if it's identical, so correcting a price is just re-importing with the
right value.

## Holdings & value/profit conventions

Both are pure functions of `transactions` (+ `prices`) — nothing is stored,
so they're recomputed fresh every time. Two modeling decisions worth
flagging since the spec doesn't spell them out:

- **Single-entry, not double-entry.** Each transaction only moves the
  quantity of the asset it names. Buying a stock does **not** automatically
  decrement a cash position — if you want a cash balance to reflect money
  spent on a purchase, log that withdrawal yourself. This matches how the
  spec scopes cash (sourced specifically from TradeRepublic's own unified
  transaction stream), rather than inventing a general "money available to
  invest" ledger the spec never asked for.
- **Dividends don't move quantity.** A `dividend` row is tracked purely as
  an income event on the asset that paid it (for yield/history later) — it
  never changes that asset's held quantity, and it does **not** auto-credit
  a cash position. If you want the dividend cash reflected in your cash
  balance, log a separate `deposit` transaction for it.
- **Cost basis is "net contributions,"** not full FIFO/average-cost lot
  accounting: buys/deposits/interest add `quantity*price + fees`,
  sells/withdrawals subtract `quantity*price - fees`. Exact for a
  position that's only ever been added to; an approximation once partial
  sells are involved. Fine for now — revisit if it stops being good enough.
- **No FX conversion yet.** Total value is reported **per currency**, not as
  one combined number — an FX rate source is still an open item (see
  Phase 9 in the roadmap). A position with no price yet is excluded from
  its currency's total and listed separately, so a missing price can never
  silently understate the total.

## CLI usage

```bash
# create the DB schema (also happens automatically on first import)
.venv/bin/python -m portfolio.cli init-db

# import data
.venv/bin/python -m portfolio.cli import-transactions sample_data/transactions_sample.csv
.venv/bin/python -m portfolio.cli import-prices sample_data/prices_sample.csv

# inspect what's in the DB
.venv/bin/python -m portfolio.cli list-assets
.venv/bin/python -m portfolio.cli list-transactions --limit 20

# computed views
.venv/bin/python -m portfolio.cli holdings   # quantity per asset
.venv/bin/python -m portfolio.cli value      # value/profit per position + totals by currency
```

The DB file location defaults to `./data/portfolio.db` (gitignored — never
committed). Override with `--db <path>` or the `PORTFOLIO_DB_PATH` env var.

## Dashboard

```bash
.venv/bin/streamlit run dashboard.py
```

Opens in your browser (default `http://localhost:8501`). It's **read-only**
— importing still goes through the CLI commands above; the dashboard just
displays whatever's currently in the DB (same `--db`/`PORTFOLIO_DB_PATH`
resolution as the CLI). Shows:
- totals per currency (with a note when a position's price is missing, so a
  gap in your price data is visible instead of silently making the total
  look smaller than it is)
- a table of every open position: quantity, price, value, cost basis,
  profit, profit %

If the DB has no holdings yet, it shows the import command to run instead of
an empty page.

## How to test this slice

1. **Automated tests** — schema creation, import, idempotent re-import, all
   validation rules, all-or-nothing rollback, holdings computation,
   value/profit math (checked against hand-calculated numbers), and the
   dashboard (headless, via Streamlit's `AppTest` — no browser needed):
   ```bash
   .venv/bin/python -m pytest -v
   ```
   Expect 29 passed.

2. **Manual walkthrough**, to see it end to end:
   ```bash
   rm -f data/portfolio.db   # start clean
   .venv/bin/python -m portfolio.cli import-transactions sample_data/transactions_sample.csv
   .venv/bin/python -m portfolio.cli import-transactions sample_data/transactions_sample.csv  # re-run: everything should now say "Skipped"
   .venv/bin/python -m portfolio.cli list-assets
   .venv/bin/python -m portfolio.cli list-transactions

   .venv/bin/python -m portfolio.cli holdings   # 4 assets, quantities per the sample CSV
   .venv/bin/python -m portfolio.cli value      # prices missing so far — cash shows a value, everything else N/A

   .venv/bin/python -m portfolio.cli import-prices sample_data/prices_sample.csv
   .venv/bin/python -m portfolio.cli value      # now every position has a value/profit; two currency totals (EUR, USD)

   .venv/bin/streamlit run dashboard.py         # same numbers, in the browser
   ```
   You should see 4 assets and 7 transactions, matching
   `sample_data/transactions_sample.csv`, and the second transaction import
   should report `Inserted 0` / `Skipped 7`. After importing prices, `value`
   should show: IWDA qty 25 @ 96.50 = 2412.50 EUR (profit +295.60), BTC qty
   0.05 @ 45000 = 2250 EUR (profit +145.00), AAPL qty 5 @ 195 = 975 USD
   (profit +71.75), EUR_CASH 5000 EUR flat (profit 0). The dashboard should
   show the same 4 positions and two currency totals (EUR 9,662.50 /
   +440.60 profit, USD 975.00 / +71.75 profit).

3. **Try your own data** (once you're ready to use it for real — see the note
   below): copy `sample_data/transactions_template.csv` and
   `sample_data/prices_template.csv`, fill them in by hand from a broker
   statement, and import them the same way.

> **Where to put real data:** this repo is built and tested here using only
> dummy data (`sample_data/`). Your real transaction history and `.env`
> secrets should live only on your own machine, in a local clone — never
> pasted into chat or committed. `data/` and `.env` are both gitignored for
> this reason.

## Roadmap (Python/Streamlit build — frozen, not being continued)

1. ~~Transactions/prices data model + manual CSV import~~ ✅
2. ~~Manual price CSV import → computed holdings → value/profit view~~ ✅
3. ~~Streamlit dashboard (read-only)~~ ✅
4. Live price connector: yfinance, and everything after it — **not built**,
   development moved to the `web/` rewrite before this phase started. See
   [`web/README.md`](./web/README.md) for the roadmap being actively worked
   on now.
