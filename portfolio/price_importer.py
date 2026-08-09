"""Manual CSV import for the `prices` table.

Unlike transactions, a price row requires the asset to already exist —
import its transactions first (so we know its symbol and currency). Cash
assets never need a price import; their price is always 1 by definition.

Re-importing a (asset, date) pair updates the price if it changed, and is a
no-op if it's identical — a correction is just re-importing with a new
value.
"""

import csv
import sqlite3
from datetime import datetime
from pathlib import Path

REQUIRED_COLUMNS = {"date", "asset_symbol", "price", "source"}


class CsvValidationError(Exception):
    """Raised when the CSV is malformed. Nothing is written to the DB when this is raised."""


def _read_rows(csv_path: str) -> list[dict]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        header = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - header
        if missing:
            raise CsvValidationError(f"CSV is missing required column(s): {sorted(missing)}")
        return list(reader)


def _validate_and_normalize_row(
    conn: sqlite3.Connection, row: dict, line_no: int
) -> tuple[dict | None, list[str]]:
    errors: list[str] = []

    def get(field: str) -> str:
        return (row.get(field) or "").strip()

    date_str = get("date")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        errors.append(f"line {line_no}: invalid date {date_str!r} (expected YYYY-MM-DD)")

    symbol = get("asset_symbol")
    asset_row = None
    if not symbol:
        errors.append(f"line {line_no}: asset_symbol is required")
    else:
        asset_row = conn.execute("SELECT id FROM assets WHERE symbol = ?", (symbol,)).fetchone()
        if not asset_row:
            errors.append(
                f"line {line_no}: unknown asset_symbol {symbol!r} — import its transactions first"
            )

    price = None
    try:
        price = float(get("price"))
    except ValueError:
        errors.append(f"line {line_no}: price must be numeric")

    source = get("source")
    if not source:
        errors.append(f"line {line_no}: source is required")

    if errors:
        return None, errors

    return {
        "asset_id": asset_row["id"],
        "date": date_str,
        "price": price,
        "source": source,
    }, []


def import_csv(csv_path: str | Path, conn: sqlite3.Connection) -> dict:
    """Validate and import a prices CSV. All-or-nothing: if any row fails
    validation, nothing is written. Returns a stats dict."""
    rows = _read_rows(str(csv_path))

    normalized_rows = []
    all_errors = []
    for i, raw in enumerate(rows, start=2):  # line 1 is the header
        normalized, errors = _validate_and_normalize_row(conn, raw, i)
        if errors:
            all_errors.extend(errors)
        else:
            normalized_rows.append(normalized)

    if all_errors:
        raise CsvValidationError("CSV validation failed:\n" + "\n".join(all_errors))

    stats = {"rows_read": len(rows), "inserted": 0, "updated": 0, "unchanged": 0}
    try:
        for row in normalized_rows:
            existing = conn.execute(
                "SELECT price FROM prices WHERE asset_id = ? AND date = ?",
                (row["asset_id"], row["date"]),
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO prices (asset_id, date, price, source) VALUES (?, ?, ?, ?)",
                    (row["asset_id"], row["date"], row["price"], row["source"]),
                )
                stats["inserted"] += 1
            elif abs(existing["price"] - row["price"]) > 1e-9:
                conn.execute(
                    "UPDATE prices SET price = ?, source = ? WHERE asset_id = ? AND date = ?",
                    (row["price"], row["source"], row["asset_id"], row["date"]),
                )
                stats["updated"] += 1
            else:
                stats["unchanged"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return stats
