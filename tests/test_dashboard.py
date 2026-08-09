"""Headless tests for dashboard.py using Streamlit's AppTest, no browser needed."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from portfolio import db
from portfolio.importer import import_csv as import_transactions_csv
from portfolio.price_importer import import_csv as import_prices_csv

REPO_ROOT = Path(__file__).parent.parent
DASHBOARD = REPO_ROOT / "dashboard.py"
SAMPLE_TXNS = REPO_ROOT / "sample_data" / "transactions_sample.csv"
SAMPLE_PRICES = REPO_ROOT / "sample_data" / "prices_sample.csv"


def test_dashboard_shows_empty_state_with_no_data(tmp_path, monkeypatch):
    db_path = tmp_path / "empty.db"
    monkeypatch.setenv("PORTFOLIO_DB_PATH", str(db_path))

    at = AppTest.from_file(str(DASHBOARD))
    at.run()

    assert not at.exception
    assert len(at.info) == 1
    assert "No holdings yet" in at.info[0].value
    assert len(at.dataframe) == 0


def test_dashboard_renders_positions_and_totals(tmp_path, monkeypatch):
    db_path = tmp_path / "seeded.db"
    monkeypatch.setenv("PORTFOLIO_DB_PATH", str(db_path))

    conn = db.connect(str(db_path))
    db.init_db(conn)
    import_transactions_csv(SAMPLE_TXNS, conn)
    import_prices_csv(SAMPLE_PRICES, conn)
    conn.close()

    at = AppTest.from_file(str(DASHBOARD))
    at.run()

    assert not at.exception
    assert at.title[0].value == "Portfolio"

    # one metric per currency (EUR, USD in the sample data)
    assert len(at.metric) == 2
    metrics_by_label = {m.label: m for m in at.metric}
    assert "EUR value" in metrics_by_label
    assert "USD value" in metrics_by_label
    assert metrics_by_label["EUR value"].value == "9,662.50"
    assert metrics_by_label["USD value"].value == "975.00"

    # positions table has all 4 held assets
    assert len(at.dataframe) == 1
    positions_df = at.dataframe[0].value
    assert set(positions_df["Symbol"]) == {"IWDA", "US0378331005", "BTC", "EUR_CASH"}


def test_dashboard_flags_missing_prices(tmp_path, monkeypatch):
    db_path = tmp_path / "no_prices.db"
    monkeypatch.setenv("PORTFOLIO_DB_PATH", str(db_path))

    conn = db.connect(str(db_path))
    db.init_db(conn)
    import_transactions_csv(SAMPLE_TXNS, conn)  # no prices imported
    conn.close()

    at = AppTest.from_file(str(DASHBOARD))
    at.run()

    assert not at.exception
    captions = [c.value for c in at.caption]
    assert any("no price yet for" in c for c in captions)
