"""Command-line entry point.

Usage:
    python -m portfolio.cli init-db
    python -m portfolio.cli import-transactions sample_data/transactions_sample.csv
    python -m portfolio.cli list-assets
    python -m portfolio.cli list-transactions [--limit N]
"""

import argparse
import sys

from dotenv import load_dotenv

from . import db
from .importer import CsvValidationError, import_csv


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

    p_assets = sub.add_parser("list-assets", help="List known assets")
    p_assets.set_defaults(func=cmd_list_assets)

    p_txns = sub.add_parser("list-transactions", help="List imported transactions")
    p_txns.add_argument("--limit", type=int, default=50)
    p_txns.set_defaults(func=cmd_list_transactions)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
