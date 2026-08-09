"""Read-only Streamlit dashboard: holdings + value/profit view.

Run with:
    streamlit run dashboard.py

Data is read from the same SQLite DB the CLI uses (see README /
PORTFOLIO_DB_PATH in .env). This dashboard is read-only — importing data
still goes through:
    python -m portfolio.cli import-transactions <csv>
    python -m portfolio.cli import-prices <csv>
"""

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from portfolio import db
from portfolio.valuation import compute_positions, totals_by_currency

load_dotenv()

st.set_page_config(page_title="Portfolio", page_icon="📈", layout="wide")
st.title("Portfolio")

conn = db.connect()
db.init_db(conn)  # idempotent — in case the dashboard is launched before any CLI import

positions = compute_positions(conn)

if not positions:
    st.info(
        "No holdings yet. Import a transactions CSV first, then rerun this dashboard:\n\n"
        "```\npython -m portfolio.cli import-transactions sample_data/transactions_sample.csv\n```"
    )
    st.stop()

totals = totals_by_currency(positions)

st.subheader("Totals by currency")
st.caption("No FX conversion yet, so totals are shown per currency rather than combined into one number.")

cols = st.columns(len(totals))
for col, (ccy, t) in zip(cols, totals.items()):
    with col:
        st.metric(label=f"{ccy} value", value=f"{t['value']:,.2f}", delta=f"{t['profit']:+,.2f} profit")
        if t["missing_price"]:
            st.caption(f"⚠️ no price yet for: {', '.join(t['missing_price'])}")

st.subheader("Positions")

df = pd.DataFrame(positions)[[
    "symbol", "name", "asset_class", "currency", "quantity",
    "price", "value", "net_contributions", "profit", "profit_pct",
]].rename(columns={
    "symbol": "Symbol",
    "name": "Name",
    "asset_class": "Class",
    "currency": "Currency",
    "quantity": "Quantity",
    "price": "Price",
    "value": "Value",
    "net_contributions": "Net contributions",
    "profit": "Profit",
    "profit_pct": "Profit %",
})

st.dataframe(
    df,
    use_container_width=True,
    hide_index=True,
    column_config={
        "Quantity": st.column_config.NumberColumn(format="%.6g"),
        "Price": st.column_config.NumberColumn(format="%.4f"),
        "Value": st.column_config.NumberColumn(format="%.2f"),
        "Net contributions": st.column_config.NumberColumn(format="%.2f"),
        "Profit": st.column_config.NumberColumn(format="%.2f"),
        "Profit %": st.column_config.NumberColumn(format="%.1f%%"),
    },
)

st.caption(f"DB: {db.get_db_path()}")
