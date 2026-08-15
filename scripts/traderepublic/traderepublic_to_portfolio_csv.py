#!/usr/bin/env python3
"""
Converts pytr's `account_transactions.csv` (TradeRepublic's own transaction
timeline, exported via the third-party `pytr` CLI) into this app's canonical
transactions CSV — the same format the "Transactions" upload on /import
already accepts.

This is "Option A": TradeRepublic credentials and 2FA happen entirely inside
`pytr`, running on your own machine, and never touch this script, the app,
or Vercel. This script only reads a CSV file that's already on disk and
writes another CSV file next to it — no network access, no login, no
TradeRepublic API calls. Read it before running it if you want to verify
that yourself; it's stdlib-only Python, nothing hidden in a dependency.

Usage
-----
    1. Install pytr and log in (see ../../ README in this directory for the
       full walkthrough):
           uvx pytr@latest export_transactions --lang en account_transactions.csv

    2. Convert it:
           python3 traderepublic_to_portfolio_csv.py account_transactions.csv transactions.csv

    3. Open transactions.csv, skim it, then upload it on /import same as any
       other transactions CSV. If anything couldn't be confidently
       converted, it's listed in transactions.csv.review.csv instead of
       being silently dropped or guessed at — see "Rows that need your
       judgment" below.

Modeling choices
-----------------
- **A matching cash leg is emitted for every event with a cash effect**
  (buys/sells/dividends/deposits/withdrawals/interest/fees/taxes), on a
  synthetic `EUR_CASH` asset — not just the security-side row. The app's
  own model is single-entry by design (see web/README.md): a `buy` doesn't
  auto-decrement cash. TradeRepublic's account genuinely is a single unified
  cash+securities account, so reproducing that here is what makes the
  dashboard's per-currency totals reflect your *actual* cash balance and
  *actual* invested capital, rather than double-counting money that moved
  from cash into a position.
- **Currency is assumed EUR throughout.** TradeRepublic settles retail EU
  accounts in EUR even for non-EUR-listed instruments — pytr's `value`
  field is already the EUR cash effect, so there's no FX conversion for
  this script to get wrong. If that's not true for your account, everything
  here needs re-checking.
- **Fees and taxes are folded together** into the app's single `fees`
  column (the schema doesn't distinguish them) and backed out of the
  per-share price so `quantity * price + fees` reproduces the real cash
  amount TradeRepublic actually moved — not double-counted against the
  cash leg.
- **Re-running this is safe.** The app's transactions importer dedupes by
  a hash of every field, so uploading a newer export (which typically
  re-includes your whole history, not just new events) only inserts what's
  actually new.

Rows that need your judgment
-----------------------------
`SPINOFF`, `SPLIT`, `SWAP`, `TRANSFER_IN`, and `TRANSFER_OUT` events (real
corporate actions / cross-broker transfers, not everyday trades) aren't
translated automatically — mapping them onto this app's simple
buy/sell/deposit/withdrawal/interest/dividend model would risk silently
wrong cost-basis numbers (e.g. a stock split changing share count with no
real cash flow). They're written to the `.review.csv` file with the reason,
so you can add them to the main CSV by hand once you've decided how they
should be represented, rather than having them vanish from the import.
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# 8 decimal places is enough for a per-share price or a EUR cash amount and
# avoids Decimal division's default ~28-significant-digit results (e.g.
# 500.75 / 3 shares) showing up as unreadable repeating decimals in the CSV.
_QUANT = Decimal("0.00000001")


def _fmt(d: Decimal) -> str:
    return format(d.quantize(_QUANT, rounding=ROUND_HALF_UP).normalize(), "f")
from pathlib import Path

CASH_SYMBOL = "EUR_CASH"
CASH_NAME = "Euro Cash"
CASH_CURRENCY = "EUR"
SOURCE = "traderepublic"

OUTPUT_COLUMNS = [
    "date",
    "asset_symbol",
    "asset_name",
    "asset_class",
    "type",
    "quantity",
    "price",
    "fees",
    "currency",
    "source",
    "notes",
]

# Event types that only ever move cash — no security-side row. Maps each
# onto this app's deposit/withdrawal/interest vocabulary plus the sign the
# *quantity* column needs.
#
# This is NOT simply "credit = positive, debit = negative": 'withdrawal'
# already subtracts quantity in the app's SQL (see holdings.ts/
# valuation.ts's COST_BASIS_SQL — `WHEN 'withdrawal' THEN -quantity`), so a
# withdrawal needs a POSITIVE quantity, same as a deposit — the *type*
# carries the direction, not the sign. 'interest' has no such built-in
# flip (`WHEN 'interest' THEN quantity`, always added as-is) because the
# schema has no separate "interest charge" type — so INTEREST_CHARGE is the
# one case here that genuinely needs a negative quantity to net correctly.
# Verified empirically against a real Postgres import, not just read off
# the SQL — see the R7 writeup in scripts/traderepublic/README.md.
CASH_ONLY_TYPES: dict[str, tuple[str, int]] = {
    "DEPOSIT": ("deposit", 1),
    "REMOVAL": ("withdrawal", 1),
    "INTEREST": ("interest", 1),
    "INTEREST_CHARGE": ("interest", -1),
    "FEES": ("withdrawal", 1),
    "FEES_REFUND": ("deposit", 1),
    "TAXES": ("withdrawal", 1),
    "TAX_REFUND": ("deposit", 1),
}

# Real corporate actions / transfers pytr can emit that this script
# deliberately doesn't guess-map — see the module docstring.
NEEDS_REVIEW_TYPES = {"SPINOFF", "SPLIT", "SWAP", "TRANSFER_IN", "TRANSFER_OUT"}


@dataclass
class OutRow:
    date: str
    asset_symbol: str
    asset_name: str
    asset_class: str
    type: str
    quantity: Decimal
    price: Decimal
    fees: Decimal
    currency: str
    source: str
    notes: str


@dataclass
class ConversionResult:
    rows: list[OutRow] = field(default_factory=list)
    review: list[dict[str, str]] = field(default_factory=list)


def _decimal(raw: str | None) -> Decimal | None:
    if raw is None or raw.strip() == "":
        return None
    try:
        return Decimal(raw.strip())
    except InvalidOperation:
        return None


def _best_effort_name(isin: str, note: str | None) -> str:
    """
    pytr's CSV doesn't include an instrument name column, only ISIN — but
    `note` often looks like "Buy - Apple Inc" or just "Apple Inc". This is a
    best-effort label so the asset isn't just a bare ISIN in the app; if it
    doesn't look useful, the ISIN itself is a perfectly valid fallback name.
    """
    if not note:
        return isin
    candidate = note.split(" - ")[-1].strip()
    return candidate if candidate else isin


def convert_row(raw: dict[str, str], line_no: int) -> tuple[list[OutRow], dict[str, str] | None]:
    event_type = (raw.get("type") or "").strip().upper()
    date = (raw.get("date") or "").strip()[:10]  # drop time-of-day if --date-with-time was used
    value = _decimal(raw.get("value"))
    shares = _decimal(raw.get("shares"))
    fees = _decimal(raw.get("fees")) or Decimal(0)
    taxes = _decimal(raw.get("taxes")) or Decimal(0)
    isin = (raw.get("isin") or "").strip()
    note = (raw.get("note") or "").strip() or None
    cost = fees + taxes

    def review(reason: str) -> tuple[list[OutRow], dict[str, str] | None]:
        entry = dict(raw)
        entry["_line"] = str(line_no)
        entry["_reason"] = reason
        return [], entry

    if not date:
        return review("missing/unparseable date")

    if event_type in NEEDS_REVIEW_TYPES:
        return review(f"'{event_type}' is a corporate action/transfer — needs a manual decision, see script docstring")

    if event_type in CASH_ONLY_TYPES:
        if value is None:
            return review(f"'{event_type}' row has no value")
        cash_type, sign = CASH_ONLY_TYPES[event_type]
        signed_qty = sign * abs(value)
        rows = [
            OutRow(
                date=date,
                asset_symbol=CASH_SYMBOL,
                asset_name=CASH_NAME,
                asset_class="cash",
                type=cash_type,
                quantity=signed_qty,
                price=Decimal(1),
                fees=Decimal(0),
                currency=CASH_CURRENCY,
                source=SOURCE,
                notes=f"TradeRepublic {event_type}" + (f" — {note}" if note else ""),
            )
        ]
        return rows, None

    if event_type in ("BUY", "SELL"):
        if not isin or shares is None or shares == 0 or value is None:
            return review(f"'{event_type}' row missing isin/shares/value")
        name = _best_effort_name(isin, note)
        abs_value = abs(value)
        if event_type == "BUY":
            # quantity * price + fees == abs_value (see COST_BASIS_SQL)
            gross = abs_value - cost
        else:
            # quantity * price - fees == abs_value
            gross = abs_value + cost
        if gross <= 0:
            return review(f"'{event_type}' computed a non-positive per-share price (fees/taxes exceed trade value)")
        price = gross / shares
        rows = [
            OutRow(
                date=date,
                asset_symbol=isin,
                asset_name=name,
                asset_class="stock",  # pytr doesn't distinguish stock/ETF; correct manually on /assets if needed
                type=event_type.lower(),
                quantity=shares,
                price=price,
                fees=cost,
                currency=CASH_CURRENCY,
                source=SOURCE,
                notes=f"TradeRepublic {event_type}" + (f" — {note}" if note else ""),
            ),
            OutRow(
                date=date,
                asset_symbol=CASH_SYMBOL,
                asset_name=CASH_NAME,
                asset_class="cash",
                type="withdrawal" if event_type == "BUY" else "deposit",
                quantity=abs_value,
                price=Decimal(1),
                fees=Decimal(0),
                currency=CASH_CURRENCY,
                source=SOURCE,
                notes=f"Cash leg of {event_type} {isin} — {date}",
            ),
        ]
        return rows, None

    if event_type == "DIVIDEND":
        if not isin or value is None:
            return review("'DIVIDEND' row missing isin/value")
        name = _best_effort_name(isin, note)
        rows = [
            OutRow(
                date=date,
                asset_symbol=isin,
                asset_name=name,
                asset_class="stock",
                type="dividend",
                quantity=value,  # cash-amount convention, matches sample_data/transactions_sample.csv
                price=Decimal(1),
                fees=cost,
                currency=CASH_CURRENCY,
                source=SOURCE,
                notes="TradeRepublic DIVIDEND" + (f" — {note}" if note else ""),
            ),
            OutRow(
                date=date,
                asset_symbol=CASH_SYMBOL,
                asset_name=CASH_NAME,
                asset_class="cash",
                type="deposit",
                quantity=value,
                price=Decimal(1),
                fees=Decimal(0),
                currency=CASH_CURRENCY,
                source=SOURCE,
                notes=f"Cash leg of DIVIDEND {isin} — {date}",
            ),
        ]
        return rows, None

    return review(f"unrecognized type '{event_type}'")


def convert(input_path: Path) -> ConversionResult:
    result = ConversionResult()
    with input_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=";")
        for i, raw in enumerate(reader, start=2):  # line 1 is the header
            rows, review_entry = convert_row(raw, i)
            result.rows.extend(rows)
            if review_entry is not None:
                result.review.append(review_entry)
    return result


def write_output(rows: list[OutRow], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow(
                {
                    "date": r.date,
                    "asset_symbol": r.asset_symbol,
                    "asset_name": r.asset_name,
                    "asset_class": r.asset_class,
                    "type": r.type,
                    "quantity": _fmt(r.quantity),
                    "price": _fmt(r.price),
                    "fees": _fmt(r.fees),
                    "currency": r.currency,
                    "source": r.source,
                    "notes": r.notes,
                }
            )


def write_review(review: list[dict[str, str]], path: Path) -> None:
    if not review:
        if path.exists():
            path.unlink()
        return
    fieldnames = ["_line", "_reason", "date", "type", "value", "shares", "fees", "taxes", "isin", "note"]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(review)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="pytr's account_transactions.csv (exported with --lang en)")
    parser.add_argument("output", type=Path, help="where to write the app's canonical transactions CSV")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"error: {args.input} does not exist", file=sys.stderr)
        raise SystemExit(1)

    result = convert(args.input)
    write_output(result.rows, args.output)
    review_path = args.output.with_suffix(args.output.suffix + ".review.csv")
    write_review(result.review, review_path)

    print(f"Wrote {len(result.rows)} row(s) to {args.output}")
    if result.review:
        print(f"{len(result.review)} row(s) need your judgment — see {review_path}")
    else:
        print("Nothing needed manual review.")


if __name__ == "__main__":
    main()
