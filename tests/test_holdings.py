import sqlite3
from pathlib import Path

import pytest

from portfolio import db
from portfolio.holdings import compute_holdings
from portfolio.importer import import_csv as import_transactions_csv

SAMPLE_TXNS = Path(__file__).parent.parent / "sample_data" / "transactions_sample.csv"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    db.init_db(c)
    import_transactions_csv(SAMPLE_TXNS, c)
    yield c
    c.close()


def _quantities(conn):
    return {h["symbol"]: h["quantity"] for h in compute_holdings(conn)}


def test_buy_sell_nets_correctly(conn):
    qty = _quantities(conn)
    # IWDA: buy 20 + buy 10 - sell 5 = 25
    assert qty["IWDA"] == pytest.approx(25)


def test_cash_deposit_counted(conn):
    qty = _quantities(conn)
    assert qty["EUR_CASH"] == pytest.approx(5000)


def test_dividend_does_not_change_share_count(conn):
    qty = _quantities(conn)
    # AAPL: buy 5 only — the dividend row must NOT add to share count
    assert qty["US0378331005"] == pytest.approx(5)


def test_crypto_buy(conn):
    qty = _quantities(conn)
    assert qty["BTC"] == pytest.approx(0.05)


def test_closed_position_omitted_by_default(conn):
    # sell everything held in a fresh asset -> net zero -> should not appear
    conn.execute(
        "INSERT INTO assets (symbol, name, asset_class, currency) VALUES ('ZERO', 'Zero Co', 'stock', 'EUR')"
    )
    asset_id = conn.execute("SELECT id FROM assets WHERE symbol = 'ZERO'").fetchone()["id"]
    conn.execute(
        "INSERT INTO transactions (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency) "
        "VALUES ('t1', '2024-01-01', ?, 'stock', 'manual', 'buy', 10, 5, 0, 'EUR')",
        (asset_id,),
    )
    conn.execute(
        "INSERT INTO transactions (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency) "
        "VALUES ('t2', '2024-01-02', ?, 'stock', 'manual', 'sell', 10, 6, 0, 'EUR')",
        (asset_id,),
    )
    conn.commit()
    qty = _quantities(conn)
    assert "ZERO" not in qty

    all_holdings = compute_holdings(conn, include_zero=True)
    zero_row = next(h for h in all_holdings if h["symbol"] == "ZERO")
    assert zero_row["quantity"] == pytest.approx(0)
