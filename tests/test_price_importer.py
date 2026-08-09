import sqlite3
from pathlib import Path

import pytest

from portfolio import db
from portfolio.importer import import_csv as import_transactions_csv
from portfolio.price_importer import CsvValidationError, import_csv

SAMPLE_TXNS = Path(__file__).parent.parent / "sample_data" / "transactions_sample.csv"
SAMPLE_PRICES = Path(__file__).parent.parent / "sample_data" / "prices_sample.csv"


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    db.init_db(c)
    import_transactions_csv(SAMPLE_TXNS, c)  # prices need existing assets
    yield c
    c.close()


def test_import_sample_prices(conn):
    stats = import_csv(SAMPLE_PRICES, conn)
    assert stats["rows_read"] == 3
    assert stats["inserted"] == 3
    assert stats["updated"] == 0
    assert stats["unchanged"] == 0

    price_count = conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
    assert price_count == 3


def test_reimport_identical_prices_is_unchanged(conn):
    import_csv(SAMPLE_PRICES, conn)
    stats2 = import_csv(SAMPLE_PRICES, conn)
    assert stats2["inserted"] == 0
    assert stats2["updated"] == 0
    assert stats2["unchanged"] == 3


def test_reimport_with_new_price_updates(conn, tmp_path):
    import_csv(SAMPLE_PRICES, conn)
    corrected = tmp_path / "corrected.csv"
    corrected.write_text(
        "date,asset_symbol,price,source\n2024-06-15,IWDA,99.00,manual\n"
    )
    stats = import_csv(corrected, conn)
    assert stats["updated"] == 1
    row = conn.execute(
        "SELECT p.price FROM prices p JOIN assets a ON a.id = p.asset_id WHERE a.symbol = 'IWDA'"
    ).fetchone()
    assert row["price"] == 99.00


def test_unknown_asset_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,price,source\n2024-06-15,DOES_NOT_EXIST,10,manual\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)
    assert conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0] == 0


def test_invalid_date_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,price,source\n15-06-2024,IWDA,10,manual\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)


def test_missing_required_column_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("date,asset_symbol\n2024-06-15,IWDA\n")
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)
