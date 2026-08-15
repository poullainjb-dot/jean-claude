# TradeRepublic import (local, credentials never leave your machine)

This is "Option A" from the roadmap: TradeRepublic doesn't have a public
export button like Bolero's, so the only practical way to get your data out
is a small third-party tool, [`pytr`](https://github.com/pytr-org/pytr),
that talks to TradeRepublic's own app API the same way the TradeRepublic
app does. It runs entirely on **your** machine — your phone number, PIN,
and 2FA approval never touch this app, Vercel, or this repo's code. All
this repo adds is a converter that turns pytr's own export into the format
`/import` already accepts.

```
TradeRepublic app  →  pytr (your machine, your login)  →  account_transactions.csv
                                                                    │
                                                    traderepublic_to_portfolio_csv.py
                                                                    │
                                                            transactions.csv
                                                                    │
                                                    upload on /import, same as any CSV
```

## 1. Install and log in to pytr

```bash
uvx pytr@latest login --v2
```

`--v2` uses TradeRepublic's push-notification approval (confirm the login
from the TR app on your phone) instead of typing a 4-digit code, and
doesn't need a browser installed. Leave off `--store_credentials` unless
you want pytr to remember your login for next time — by default it doesn't.

## 2. Export your transaction history

```bash
uvx pytr@latest export_transactions --lang en account_transactions.csv
```

`--lang en` matters — this converter expects the English event-type names
pytr writes with that flag (`BUY`, `SELL`, `DIVIDEND`, ...); a different
`--lang` would produce localized values this script doesn't recognize, and
every row would end up in the review file instead of converting.

## 3. Convert it

```bash
python3 traderepublic_to_portfolio_csv.py account_transactions.csv transactions.csv
```

Pure stdlib Python, no install needed. Produces:
- `transactions.csv` — ready to upload on `/import` → "Transactions"
- `transactions.csv.review.csv` — only created if something needed a
  judgment call (see below); if everything converted cleanly, no file

## 4. Skim, then upload

Open `transactions.csv` before uploading — it's a plain CSV, worth a look.
Then upload it on `/import` same as any transactions CSV. Re-running this
whole process later (e.g. monthly) is safe: the app's importer dedupes by
a hash of every field, so re-uploading an export that includes transactions
you've already imported just skips them — only genuinely new ones insert.

## What this converts, and how

pytr's CSV has one row per event with a `value` (the real cash effect) and
no distinct security-side "price" — this converter derives everything else
from that:

| pytr `type`                         | becomes                                                          |
|--------------------------------------|-------------------------------------------------------------------|
| `BUY` / `SELL`                       | a `buy`/`sell` row on the ISIN, **plus** a matching `EUR_CASH` `withdrawal`/`deposit` leg |
| `DIVIDEND`                           | a `dividend` row on the ISIN (cash-amount convention), **plus** an `EUR_CASH` `deposit` leg |
| `DEPOSIT`, `FEES_REFUND`, `TAX_REFUND` | `EUR_CASH` `deposit`                                             |
| `REMOVAL`, `FEES`, `TAXES`           | `EUR_CASH` `withdrawal`                                          |
| `INTEREST`                           | `EUR_CASH` `interest` (positive)                                 |
| `INTEREST_CHARGE`                    | `EUR_CASH` `interest` (**negative** — see below)                 |
| `SPINOFF`, `SPLIT`, `SWAP`, `TRANSFER_IN`, `TRANSFER_OUT` | → review file, not guessed (see below)      |

**Why every trade/dividend gets a matching cash leg, not just the security
row:** the app's model is deliberately single-entry — a `buy` doesn't
auto-decrement cash (see the main README's "Holdings & value/profit
conventions"). TradeRepublic is a genuinely unified cash+securities
account though, and pytr's `value` field is exactly the real cash effect
of each event, so reproducing that here is what makes your dashboard's
per-currency totals reflect actual cash and actual invested capital,
instead of double-counting money that moved from cash into a position.

**Why `INTEREST_CHARGE` is the one type with a negative quantity, and
`REMOVAL`/`FEES`/`TAXES` are *not*:** the app's `withdrawal` type already
subtracts `quantity` in its own SQL, so it needs a *positive* quantity —
same as a deposit. `interest` has no such built-in flip (it's always added
as-is), and the schema has no separate "interest charge" type, so a
negative quantity is the only way to represent a debit there. This was
verified empirically against a real Postgres import of the app's actual
importer/holdings/valuation code (not just read off the SQL) after an
earlier version of this script got it backwards — see the R7 status entry
in `web/README.md`.

**Rows that land in `transactions.csv.review.csv` instead of the main
output:** `SPINOFF`, `SPLIT`, `SWAP`, `TRANSFER_IN`, `TRANSFER_OUT` (real
corporate actions / cross-broker transfers — mapping them onto a simple
buy/sell/deposit/withdrawal model risks silently wrong cost-basis numbers,
e.g. a split changing share count with no real cash flow), plus any row
missing a field it needs (date, or shares/value for a trade). Nothing is
silently dropped — decide by hand and add it to `transactions.csv`
yourself if it applies to you.

**Everything is priced/valued in EUR.** TradeRepublic settles retail EU
accounts in EUR regardless of what currency the underlying instrument
trades in, and pytr's `value` is already that EUR cash effect — there's no
FX conversion for this script to get wrong. If your account isn't EUR-based
this assumption doesn't hold and needs revisiting.

**Asset names are best-effort.** pytr's CSV has an ISIN but no separate
instrument-name column; the converter tries to pull one out of the `note`
field (e.g. `"Buy - Apple Inc"` → `"Apple Inc"`) and falls back to the ISIN
itself if that doesn't look useful. Set `asset_class` to `etf` by hand on
`/assets` afterward for anything that isn't actually a stock — pytr doesn't
distinguish the two, so everything lands as `stock` by default.

## Testing

```bash
python3 -m ruff check .                                        # lint
python3 -m unittest discover -s . -p 'test_*.py' -v             # 22 tests, no DB needed
```

The unit tests cover the type-mapping/sign-convention table above directly.
The sign conventions themselves were additionally checked against a real
local Postgres import (not just asserted in these tests) — see the R7 entry
in `web/README.md` for that verification.
