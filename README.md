# Portfolio App

A local app that replaces Finary: tracks value/profit, forecasts future
wealth, and provides an ad-hoc research tool per ticker. Runs locally with
your own API keys — nothing routed through a third party.

See [`portfolio-app-spec.md`](./portfolio-app-spec.md) for the full spec
this is built from (data sources, schema, computed metrics, research tool).

## Status

**Phase 2 complete: manual price CSV import → computed holdings → value/profit view.**
Phase 1 (transactions data model + manual CSV import) is the foundation every
later source (Bolero export, TradeRepublic via `pytr`, exchange APIs) will
feed into — CSV import is the universal fallback, so a broken live connector
never blocks you.

Not built yet: dashboard, live connectors, and the research tool. See
**Roadmap** below.

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

## How to test this slice

1. **Automated tests** — schema creation, import, idempotent re-import, all
   validation rules, all-or-nothing rollback, holdings computation, and
   value/profit math (checked against hand-calculated numbers):
   ```bash
   .venv/bin/python -m pytest -v
   ```
   Expect 26 passed.

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
   ```
   You should see 4 assets and 7 transactions, matching
   `sample_data/transactions_sample.csv`, and the second transaction import
   should report `Inserted 0` / `Skipped 7`. After importing prices, `value`
   should show: IWDA qty 25 @ 96.50 = 2412.50 EUR (profit +295.60), BTC qty
   0.05 @ 45000 = 2250 EUR (profit +145.00), AAPL qty 5 @ 195 = 975 USD
   (profit +71.75), EUR_CASH 5000 EUR flat (profit 0).

3. **Try your own data** (once you're ready to use it for real — see the note
   below): copy `sample_data/transactions_template.csv` and
   `sample_data/prices_template.csv`, fill them in by hand from a broker
   statement, and import them the same way.

> **Where to put real data:** this repo is built and tested here using only
> dummy data (`sample_data/`). Your real transaction history and `.env`
> secrets should live only on your own machine, in a local clone — never
> pasted into chat or committed. `data/` and `.env` are both gitignored for
> this reason.

## Roadmap

1. ~~Transactions/prices data model + manual CSV import~~ ✅
2. ~~Manual price CSV import → computed holdings → value/profit view~~ ✅
3. Streamlit dashboard (read-only)
4. Live price connector: yfinance
5. Bolero CSV/Excel import adapter
6. TradeRepublic via `pytr`
7. Crypto: exchange API(s) + CoinGecko prices
8. Gold: manual entry + spot price API
9. Remaining computed metrics: forecast, TWR, dividends, risk/diversification (incl. ETF look-through), rebalancing flags — this phase also needs an FX rate source to produce a single combined total across currencies
10. Ad-hoc research tool (Claude API + web search)
