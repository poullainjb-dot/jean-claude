# Portfolio App — Build Spec

A local app (built with Claude Code) that replaces Finary: tracks value/profit, forecasts future wealth, and provides an ad-hoc research tool per ticker. Runs locally with your own API keys — nothing routed through a third party.

## 1. Asset classes & data sources

| Asset class | Source | Access method | Notes |
|---|---|---|---|
| Stocks & ETF | Bolero | Official Excel/CSV export (Portfolio → Securities → Excel) | Reliable, no ToS risk |
| Stocks & ETF | TradeRepublic | `pytr` (unofficial Python lib, private API) | Handles login + 2FA, exports transactions/portfolio to CSV |
| Savings/cash | TradeRepublic | Same `pytr` export | Interest, deposits, withdrawals are in the same account transaction stream |
| Gold | Manual | Manual entry (quantity, purchase price) | Live valuation via a gold spot price API (pick one at build time) |
| Crypto | Exchanges (Binance/Coinbase/Kraken) | Official read-only API keys | Balances + trade history both available from the same key |
| Crypto | CoinGecko | Free Demo API (10k calls/month, 100 calls/min) | Price/market data only — does NOT know your holdings |

**Design rule:** build a CSV-first import layer regardless of connector. Every live integration (pytr, exchange APIs) should have a manual CSV fallback, so a broken unofficial connector never blocks you.

## 2. Core data model

**`transactions`** (the source of truth — everything else derives from this)
- `id`, `date`, `asset_id`, `asset_class` (stock/etf/cash/gold/crypto), `source` (bolero/traderepublic/binance/.../manual)
- `type` (buy/sell/deposit/withdrawal/interest/dividend)
- `quantity`, `price`, `fees`, `currency`

**`assets`**
- `id`, `symbol/ISIN`, `name`, `asset_class`, `currency`
- For ETFs: link to a `holdings_breakdown` table (country/sector weights, pulled from the issuer's public holdings file — see look-through note below)

**`prices`** (historical, daily)
- `asset_id`, `date`, `price` — from yfinance (stocks/ETF), CoinGecko (crypto), spot API (gold)

Current holdings, value, and P&L are all *computed* from `transactions` + `prices` — never stored directly, so they're always consistent.

## 3. Computed metrics

- **Value & profit**: per position and total, from holdings × current price minus cost basis.
- **Forecast**: monthly-contribution compounding, shown as a range (pessimistic/base/optimistic or a simple Monte Carlo using historical volatility) — not a single point estimate.
- **Historical growth (day/week/month/YTD)**: two views, not one —
  - raw wealth trajectory (answers "how much richer am I")
  - time-weighted return, TWR (answers "did my investments actually perform well" — isolates market performance from the effect of adding new money)
- **Risk/diversification**: correlation across positions, sector concentration, currency exposure, and geography based on each ETF holding's real domicile/listing country (parsed from issuer holdings files) — not the ETF's own domicile.
- **Dividend tracking**: yield + payment history + rolling income view, from the same transaction stream.
- **Rebalancing flags**: vs. a target allocation you set, rather than prescriptive buy/sell calls.

## 4. Ad-hoc research tool (health check)

Input: a ticker/ISIN. Output:
1. Quant dashboard — price chart, valuation vs. own history, geo/sector breakdown, dividend history
2. Short written analysis — pulled via the Claude API with web search enabled, for recent news/earnings/macro context
3. **Signal summary** (bullish factors / bearish factors / what to watch) rather than a directive buy/sell verdict — same underlying analysis, more honest about the actual confidence level

## 5. Security

- All API keys (data providers, exchanges, TradeRepublic login) live in a local `.env` file, never touch Claude.ai
- Exchange keys: read-only permissions only, trading and withdrawal explicitly disabled, IP-whitelisted where supported
- Unofficial connectors (pytr) can break on platform updates — CSV fallback exists for this reason

## 6. Suggested stack

- Backend: Python (pandas for the transaction/price math, `pytr` + `yfinance` + exchange SDKs for data)
- Storage: SQLite (local, simple, no server needed)
- Dashboard: Streamlit (fastest path to a usable local UI) or a small Flask/React app if you want more control
- Scheduling: none needed for the ad-hoc model — everything runs on demand

## 7. Open items for build time

- Pick the gold spot price API
- Confirm which exchange(s) specifically (Binance/Coinbase/Kraken) to wire up first
- Decide target allocation (for rebalancing flags) once the tracker is live
