import sqlite3
from pathlib import Path

import pytest

from portfolio import db
from portfolio.importer import CsvValidationError, import_csv

SAMPLE_CSV = Path(__file__).parent.parent / "sample_data" / "transactions_sample.csv"
SAMPLE_CSV_ROW_COUNT = 7
SAMPLE_CSV_UNIQUE_ASSETS = 4  # EUR_CASH, IWDA, US0378331005, BTC


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    db.init_db(c)
    yield c
    c.close()


def test_import_sample_csv(conn):
    stats = import_csv(SAMPLE_CSV, conn)
    assert stats["rows_read"] == SAMPLE_CSV_ROW_COUNT
    assert stats["inserted"] == SAMPLE_CSV_ROW_COUNT
    assert stats["skipped_duplicates"] == 0
    assert stats["assets_created"] == SAMPLE_CSV_UNIQUE_ASSETS

    txn_count = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    asset_count = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
    assert txn_count == SAMPLE_CSV_ROW_COUNT
    assert asset_count == SAMPLE_CSV_UNIQUE_ASSETS


def test_reimport_is_idempotent(conn):
    import_csv(SAMPLE_CSV, conn)
    stats2 = import_csv(SAMPLE_CSV, conn)
    assert stats2["inserted"] == 0
    assert stats2["skipped_duplicates"] == SAMPLE_CSV_ROW_COUNT
    assert stats2["assets_created"] == 0

    txn_count = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    assert txn_count == SAMPLE_CSV_ROW_COUNT  # no duplicates


def test_second_asset_row_can_omit_name_and_currency_matches_first(conn):
    import_csv(SAMPLE_CSV, conn)
    # IWDA appears 3 times in the sample; only the first row supplies asset_name.
    rows = conn.execute("SELECT id FROM assets WHERE symbol = 'IWDA'").fetchall()
    assert len(rows) == 1


def test_cash_flow_convention_quantity_is_amount(conn):
    import_csv(SAMPLE_CSV, conn)
    row = conn.execute(
        "SELECT quantity, price FROM transactions WHERE type = 'deposit'"
    ).fetchone()
    assert row["quantity"] == 5000
    assert row["price"] == 1


def test_invalid_asset_class_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n"
        "2024-01-01,XXX,Test,not_a_class,buy,1,1,0,EUR,manual,\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)
    # nothing should have been written
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0


def test_invalid_date_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n"
        "15-01-2024,XXX,Test,stock,buy,1,1,0,EUR,manual,\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)


def test_non_numeric_quantity_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n"
        "2024-01-01,XXX,Test,stock,buy,not_a_number,1,0,EUR,manual,\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)


def test_missing_required_column_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("date,asset_symbol\n2024-01-01,XXX\n")
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)


def test_new_asset_without_name_rejected(conn, tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n"
        "2024-01-01,NEWSYM,,stock,buy,1,1,0,EUR,manual,\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(bad_csv, conn)


def test_partial_failure_does_not_partially_commit(conn, tmp_path):
    # First row valid, second row invalid — nothing at all should be inserted.
    mixed_csv = tmp_path / "mixed.csv"
    mixed_csv.write_text(
        "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n"
        "2024-01-01,GOOD,Good Asset,stock,buy,1,1,0,EUR,manual,\n"
        "2024-01-02,BAD,Bad Asset,not_a_class,buy,1,1,0,EUR,manual,\n"
    )
    with pytest.raises(CsvValidationError):
        import_csv(mixed_csv, conn)
    assert conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0
