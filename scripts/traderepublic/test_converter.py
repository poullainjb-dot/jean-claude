"""
Unit tests for traderepublic_to_portfolio_csv.py — stdlib unittest, no
extra dependencies, matching the script's own "nothing hidden in a
dependency" design goal. Run with:

    python3 -m unittest discover -s scripts/traderepublic -p 'test_*.py' -v

The sign conventions asserted here (why 'withdrawal' wants a *positive*
quantity, why INTEREST_CHARGE is the one type that wants negative) were
verified empirically against a real Postgres import of the app's actual
importer/holdings/valuation code, not just read off the SQL — see the R7
entry in scripts/traderepublic/README.md for that verification.
"""

import contextlib
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from traderepublic_to_portfolio_csv import (
    CASH_SYMBOL,
    _best_effort_name,
    _fmt,
    convert,
    convert_row,
)


def row(**overrides):
    base = {
        "date": "2026-01-10T10:15:00",
        "type": "",
        "value": "",
        "note": "",
        "isin": "",
        "shares": "",
        "fees": "",
        "taxes": "",
        "isin2": "",
        "shares2": "",
    }
    base.update(overrides)
    return base


class TestFmt(unittest.TestCase):
    def test_strips_trailing_zeros(self):
        self.assertEqual(_fmt(Decimal("100.00000000")), "100")

    def test_rounds_to_eight_places(self):
        # A repeating decimal — the exact case that motivated quantizing at
        # all (Decimal division's default ~28-digit precision otherwise).
        self.assertEqual(_fmt(Decimal(500) / Decimal(3)), "166.66666667")

    def test_preserves_negative(self):
        self.assertEqual(_fmt(Decimal("-0.30")), "-0.3")


class TestBestEffortName(unittest.TestCase):
    def test_extracts_after_dash(self):
        self.assertEqual(_best_effort_name("US0378331005", "Buy - Apple Inc"), "Apple Inc")

    def test_falls_back_to_isin_when_no_note(self):
        self.assertEqual(_best_effort_name("US0378331005", None), "US0378331005")

    def test_falls_back_to_isin_when_note_is_blank_after_split(self):
        self.assertEqual(_best_effort_name("US0378331005", " - "), "US0378331005")


class TestConvertRow(unittest.TestCase):
    def test_buy_produces_security_and_cash_leg(self):
        rows, review = convert_row(
            row(type="BUY", value="-500.75", isin="US0378331005", shares="3", fees="0.75", note="Buy - Apple Inc"),
            line_no=2,
        )
        self.assertIsNone(review)
        self.assertEqual(len(rows), 2)

        security, cash = rows
        self.assertEqual(security.asset_symbol, "US0378331005")
        self.assertEqual(security.asset_name, "Apple Inc")
        self.assertEqual(security.type, "buy")
        self.assertEqual(security.quantity, Decimal(3))
        self.assertEqual(security.fees, Decimal("0.75"))
        # quantity * price + fees must reproduce the real cash amount moved
        self.assertAlmostEqual(security.quantity * security.price + security.fees, Decimal("500.75"), places=6)

        self.assertEqual(cash.asset_symbol, CASH_SYMBOL)
        self.assertEqual(cash.type, "withdrawal")
        self.assertEqual(cash.quantity, Decimal("500.75"))

    def test_sell_produces_security_and_cash_leg(self):
        rows, review = convert_row(
            row(type="SELL", value="210.25", isin="US0378331005", shares="1", fees="0.75"),
            line_no=2,
        )
        self.assertIsNone(review)
        security, cash = rows
        self.assertEqual(security.type, "sell")
        # quantity * price - fees must reproduce the real cash amount received
        self.assertAlmostEqual(security.quantity * security.price - security.fees, Decimal("210.25"), places=6)
        self.assertEqual(cash.type, "deposit")
        self.assertEqual(cash.quantity, Decimal("210.25"))

    def test_dividend_produces_informational_row_and_cash_deposit(self):
        rows, review = convert_row(
            row(type="DIVIDEND", value="4.20", isin="US0378331005", taxes="0.63", note="Dividend - Apple Inc"),
            line_no=2,
        )
        self.assertIsNone(review)
        security, cash = rows
        self.assertEqual(security.type, "dividend")
        self.assertEqual(security.quantity, Decimal("4.20"))
        self.assertEqual(security.fees, Decimal("0.63"))
        self.assertEqual(cash.type, "deposit")
        self.assertEqual(cash.quantity, Decimal("4.20"))

    def test_deposit_is_cash_only_positive(self):
        rows, review = convert_row(row(type="DEPOSIT", value="1000"), line_no=2)
        self.assertIsNone(review)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].type, "deposit")
        self.assertEqual(rows[0].quantity, Decimal(1000))

    def test_removal_is_positive_quantity_not_negative(self):
        # The one sign convention that's easy to get backwards: 'withdrawal'
        # already subtracts in the app's SQL, so a *positive* quantity is
        # what correctly decreases the cash balance.
        rows, review = convert_row(row(type="REMOVAL", value="-100"), line_no=2)
        self.assertIsNone(review)
        self.assertEqual(rows[0].type, "withdrawal")
        self.assertEqual(rows[0].quantity, Decimal(100))

    def test_interest_charge_is_the_one_negative_quantity_case(self):
        rows, review = convert_row(row(type="INTEREST_CHARGE", value="-0.30"), line_no=2)
        self.assertIsNone(review)
        self.assertEqual(rows[0].type, "interest")
        self.assertEqual(rows[0].quantity, Decimal("-0.30"))

    def test_interest_earned_is_positive(self):
        rows, _review = convert_row(row(type="INTEREST", value="2.15"), line_no=2)
        self.assertEqual(rows[0].quantity, Decimal("2.15"))

    def test_fees_and_taxes_map_to_withdrawal(self):
        for t in ("FEES", "TAXES"):
            rows, review = convert_row(row(type=t, value="-1.5"), line_no=2)
            self.assertIsNone(review)
            self.assertEqual(rows[0].type, "withdrawal")
            self.assertEqual(rows[0].quantity, Decimal("1.5"))

    def test_fees_refund_and_tax_refund_map_to_deposit(self):
        for t in ("FEES_REFUND", "TAX_REFUND"):
            rows, review = convert_row(row(type=t, value="1.5"), line_no=2)
            self.assertIsNone(review)
            self.assertEqual(rows[0].type, "deposit")
            self.assertEqual(rows[0].quantity, Decimal("1.5"))

    def test_corporate_actions_are_sent_to_review_not_guessed(self):
        for t in ("SPINOFF", "SPLIT", "SWAP", "TRANSFER_IN", "TRANSFER_OUT"):
            rows, review = convert_row(row(type=t, value="1", isin="DE0007236101", shares="2"), line_no=2)
            self.assertEqual(rows, [])
            self.assertIsNotNone(review)
            self.assertIn(t, review["_reason"])

    def test_unrecognized_type_goes_to_review(self):
        rows, review = convert_row(row(type="SOMETHING_NEW", value="1"), line_no=2)
        self.assertEqual(rows, [])
        self.assertIsNotNone(review)

    def test_buy_missing_shares_goes_to_review(self):
        rows, review = convert_row(row(type="BUY", value="-100", isin="US0378331005"), line_no=2)
        self.assertEqual(rows, [])
        self.assertIsNotNone(review)

    def test_missing_date_goes_to_review(self):
        rows, review = convert_row(row(date="", type="DEPOSIT", value="100"), line_no=2)
        self.assertEqual(rows, [])
        self.assertIsNotNone(review)

    def test_date_with_time_is_truncated_to_date_only(self):
        rows, _review = convert_row(row(date="2026-01-10T10:15:00", type="DEPOSIT", value="100"), line_no=2)
        self.assertEqual(rows[0].date, "2026-01-10")


class TestConvertEndToEnd(unittest.TestCase):
    def test_full_csv_round_trip(self):
        source = (
            "date;type;value;note;isin;shares;fees;taxes;isin2;shares2\n"
            "2026-01-05T09:00:00;DEPOSIT;1000;Bank transfer;;;;;;\n"
            "2026-01-10T10:15:00;BUY;-500.75;Buy - Apple Inc;US0378331005;3;0.75;;;\n"
            "2026-08-01T09:00:00;SPINOFF;;Spinoff event;DE0007236101;2;;;DE000A3E5D64;5\n"
        )
        tmp = Path(self.enterContext(_tmp_dir()))
        input_path = tmp / "account_transactions.csv"
        input_path.write_text(source, encoding="utf-8")

        result = convert(input_path)
        self.assertEqual(len(result.rows), 3)  # deposit + buy security-leg + buy cash-leg
        self.assertEqual(len(result.review), 1)
        self.assertEqual(result.review[0]["type"], "SPINOFF")

    def test_output_csv_has_expected_header(self):
        from traderepublic_to_portfolio_csv import OUTPUT_COLUMNS

        self.assertEqual(
            OUTPUT_COLUMNS,
            ["date", "asset_symbol", "asset_name", "asset_class", "type", "quantity", "price", "fees", "currency", "source", "notes"],
        )


@contextlib.contextmanager
def _tmp_dir():
    with tempfile.TemporaryDirectory() as d:
        yield d


if __name__ == "__main__":
    unittest.main()
