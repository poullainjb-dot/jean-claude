"""Command-line entry point.

Usage:
    python -m portfolio.cli init-db
    python -m portfolio.cli import-transactions sample_data/transactions_sample.csv
    python -m portfolio.cli import-prices sample_data/prices_sample.csv
    python -m portfolio.cli list-assets
    python -m portfolio.cli list-transactions [--limit N]
    python -m portfolio.cli holdings
    python -m portfolio.cli value
"""

import argparse
import sys

from dotenv import load_dotenv

from . import db
from .holdings import compute_holdings
from .importer import CsvValidationError, import_csv
from .price_importer import CsvValidationError as PriceCsvValidationError
from .price_importer import import_csv as import_prices_csv
from .valuation import compute_positions, totals_by_currency


def cmd_init_db(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    db.init_db(conn)
    print(f"Initialized database at {args.db or db.get_db_path()}")


def cmd_import_transactions(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    db.init_db(conn)  # idempotent — ensures schema exists before importing
    try:
        stats = import_csv(args.csv_path, conn)
    except CsvValidationError as e:
        print(f"Import failed:\n{e}", file=sys.stderr)
        sys.exit(1)
    print(f"Read {stats['rows_read']} row(s)")
    print(f"Created {stats['assets_created']} new asset(s)")
    print(f"Inserted {stats['inserted']} new transaction(s)")
    print(f"Skipped {stats['skipped_duplicates']} duplicate(s)")


def cmd_import_prices(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    db.init_db(conn)  # idempotent — ensures schema exists before importing
    try:
        stats = import_prices_csv(args.csv_path, conn)
    except PriceCsvValidationError as e:
        print(f"Import failed:\n{e}", file=sys.stderr)
        sys.exit(1)
    print(f"Read {stats['rows_read']} row(s)")
    print(f"Inserted {stats['inserted']} new price(s)")
    print(f"Updated {stats['updated']} existing price(s)")
    print(f"Unchanged {stats['unchanged']} price(s)")


def cmd_list_assets(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    rows = conn.execute(
        "SELECT id, symbol, name, asset_class, currency FROM assets ORDER BY symbol"
    ).fetchall()
    if not rows:
        print("No assets yet.")
        return
    for r in rows:
        print(f"{r['id']:>3}  {r['symbol']:<14} {r['asset_class']:<6} {r['currency']:<3}  {r['name'] or ''}")


def cmd_list_transactions(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    rows = conn.execute(
        """SELECT t.date, a.symbol, t.type, t.quantity, t.price, t.fees, t.currency, t.source
           FROM transactions t JOIN assets a ON a.id = t.asset_id
           ORDER BY t.date, a.symbol
           LIMIT ?""",
        (args.limit,),
    ).fetchall()
    if not rows:
        print("No transactions yet.")
        return
    for r in rows:
        print(
            f"{r['date']}  {r['symbol']:<14} {r['type']:<10} "
            f"qty={r['quantity']:<12g} price={r['price']:<10g} fees={r['fees']:<8g} "
            f"{r['currency']} [{r['source']}]"
        )


def cmd_holdings(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    holdings = compute_holdings(conn)
    if not holdings:
        print("No holdings yet.")
        return
    for h in holdings:
        print(f"{h['symbol']:<14} {h['asset_class']:<6} qty={h['quantity']:<14g} {h['currency']}")


def cmd_value(args: argparse.Namespace) -> None:
    conn = db.connect(args.db)
    positions = compute_positions(conn)
    if not positions:
        print("No holdings yet.")
        return
    for p in positions:
        price_str = f"{p['price']:g}" if p["price"] is not None else "N/A"
        value_str = f"{p['value']:.2f}" if p["value"] is not None else "N/A"
        profit_str = (
            f"{p['profit']:+.2f} ({p['profit_pct']:+.1f}%)" if p["profit"] is not None else "N/A"
        )
        print(
            f"{p['symbol']:<14} qty={p['quantity']:<12g} price={price_str:<10} "
            f"value={value_str:<12} {p['currency']:<3} profit={profit_str}"
        )

    print()
    print("Totals by currency (no FX conversion applied — see README):")
    for ccy, t in totals_by_currency(positions).items():
        missing = f"  [no price yet for: {', '.join(t['missing_price'])}]" if t["missing_price"] else ""
        print(f"  {ccy}: value={t['value']:.2f}  profit={t['profit']:+.2f}{missing}")


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(prog="portfolio", description="Personal portfolio tracker")
    parser.add_argument(
        "--db", help="Path to the SQLite DB file (default: $PORTFOLIO_DB_PATH or ./data/portfolio.db)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init-db", help="Create the database schema")
    p_init.set_defaults(func=cmd_init_db)

    p_import = sub.add_parser("import-transactions", help="Import a transactions CSV")
    p_import.add_argument("csv_path")
    p_import.set_defaults(func=cmd_import_transactions)

    p_import_prices = sub.add_parser("import-prices", help="Import a prices CSV")
    p_import_prices.add_argument("csv_path")
    p_import_prices.set_defaults(func=cmd_import_prices)

    p_holdings = sub.add_parser("holdings", help="Show computed holdings (quantity per asset)")
    p_holdings.set_defaults(func=cmd_holdings)

    p_value = sub.add_parser("value", help="Show value/profit per position and totals by currency")
    p_value.set_defaults(func=cmd_value)

    p_assets = sub.add_parser("list-assets", help="List known assets")
    p_assets.set_defaults(func=cmd_list_assets)

    p_txns = sub.add_parser("list-transactions", help="List imported transactions")
    p_txns.add_argument("--limit", type=int, default=50)
    p_txns.set_defaults(func=cmd_list_transactions)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
