import sqlite3
from pathlib import Path

import pytest

from portfolio import db
from portfolio.importer import import_csv as import_transactions_csv
from portfolio.price_importer import import_csv as import_prices_csv
from portfolio.valuation import compute_positions, totals_by_currency

SAMPLE_TXNS = Path(__file__).parent.parent / "sample_data" / "transactions_sample.csv"
SAMPLE_PRICES = Path(__file__).parent.parent / "sample_data" / "prices_sample.csv"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    db.init_db(c)
    import_transactions_csv(SAMPLE_TXNS, c)
    yield c
    c.close()


def _positions_by_symbol(conn):
    return {p["symbol"]: p for p in compute_positions(conn)}


def test_cash_position_always_worth_par_with_zero_profit(conn):
    positions = _positions_by_symbol(conn)
    cash = positions["EUR_CASH"]
    assert cash["price"] == 1.0
    assert cash["value"] == pytest.approx(5000)
    assert cash["net_contributions"] == pytest.approx(5000)
    assert cash["profit"] == pytest.approx(0)


def test_position_without_price_has_none_value_and_profit(conn):
    # No prices imported yet at all
    positions = _positions_by_symbol(conn)
    iwda = positions["IWDA"]
    assert iwda["price"] is None
    assert iwda["value"] is None
    assert iwda["profit"] is None
    # net_contributions is still computable without a price
    assert iwda["net_contributions"] == pytest.approx(1707.90 + 882.50 - 473.50)


def test_value_and_profit_after_importing_prices(conn):
    import_prices_csv(SAMPLE_PRICES, conn)
    positions = _positions_by_symbol(conn)

    iwda = positions["IWDA"]
    # qty 25 * price 96.50
    assert iwda["value"] == pytest.approx(25 * 96.50)
    assert iwda["net_contributions"] == pytest.approx(2116.90)
    assert iwda["profit"] == pytest.approx(2412.50 - 2116.90)

    aapl = positions["US0378331005"]
    assert aapl["value"] == pytest.approx(5 * 195.00)
    assert aapl["net_contributions"] == pytest.approx(903.25)
    assert aapl["profit"] == pytest.approx(975.00 - 903.25)

    btc = positions["BTC"]
    assert btc["value"] == pytest.approx(0.05 * 45000)
    assert btc["net_contributions"] == pytest.approx(2105)
    assert btc["profit"] == pytest.approx(2250 - 2105)


def test_totals_by_currency_excludes_missing_prices(conn):
    import_prices_csv(SAMPLE_PRICES, conn)  # covers IWDA (EUR), AAPL (USD), BTC (EUR)
    positions = compute_positions(conn)
    totals = totals_by_currency(positions)

    assert set(totals.keys()) == {"EUR", "USD"}
    # EUR = EUR_CASH (5000) + IWDA (2412.50) + BTC (2250)
    assert totals["EUR"]["value"] == pytest.approx(5000 + 2412.50 + 2250)
    assert totals["EUR"]["missing_price"] == []
    # USD = AAPL only
    assert totals["USD"]["value"] == pytest.approx(975.00)


def test_totals_flag_missing_price_without_understating(conn):
    # Don't import any prices — IWDA/AAPL/BTC all lack a price, only cash has a value
    positions = compute_positions(conn)
    totals = totals_by_currency(positions)

    assert totals["EUR"]["value"] == pytest.approx(5000)  # cash only
    assert sorted(totals["EUR"]["missing_price"]) == ["BTC", "IWDA"]
    assert totals["USD"]["missing_price"] == ["US0378331005"]
