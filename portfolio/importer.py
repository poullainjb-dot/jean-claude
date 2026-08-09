"""Manual CSV import for the `transactions` table.

This is the universal fallback import path (spec section 1's "design rule"):
every live connector added later feeds into this same canonical schema, so a
broken connector never blocks you — you can always fall back to a CSV.

See sample_data/transactions_template.csv for the column layout and
sample_data/transactions_sample.csv for a filled-in (dummy) example.
"""

import csv
import hashlib
import sqlite3
from datetime import datetime
from pathlib import Path

REQUIRED_COLUMNS = {
    "date", "asset_symbol", "asset_class", "type",
    "quantity", "price", "fees", "currency", "source",
}
OPTIONAL_COLUMNS = {"asset_name", "notes"}
VALID_ASSET_CLASSES = {"stock", "etf", "cash", "gold", "crypto"}
VALID_TYPES = {"buy", "sell", "deposit", "withdrawal", "interest", "dividend"}


class CsvValidationError(Exception):
    """Raised when the CSV is malformed. Nothing is written to the DB when this is raised."""


def _read_rows(csv_path: str) -> list[dict]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        header = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - header
        if missing:
            raise CsvValidationError(
                f"CSV is missing required column(s): {sorted(missing)}"
            )
        return list(reader)


def _validate_and_normalize_row(row: dict, line_no: int) -> tuple[dict, list[str]]:
    errors: list[str] = []

    def get(field: str) -> str:
        return (row.get(field) or "").strip()

    date_str = get("date")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        errors.append(f"line {line_no}: invalid date {date_str!r} (expected YYYY-MM-DD)")

    asset_class = get("asset_class").lower()
    if asset_class not in VALID_ASSET_CLASSES:
        errors.append(
            f"line {line_no}: invalid asset_class {asset_class!r} "
            f"(expected one of {sorted(VALID_ASSET_CLASSES)})"
        )

    txn_type = get("type").lower()
    if txn_type not in VALID_TYPES:
        errors.append(
            f"line {line_no}: invalid type {txn_type!r} (expected one of {sorted(VALID_TYPES)})"
        )

    symbol = get("asset_symbol")
    if not symbol:
        errors.append(f"line {line_no}: asset_symbol is required")

    currency = get("currency").upper()
    if len(currency) != 3 or not currency.isalpha():
        errors.append(f"line {line_no}: invalid currency {currency!r} (expected a 3-letter code)")

    quantity = None
    try:
        quantity = float(get("quantity"))
    except ValueError:
        errors.append(f"line {line_no}: quantity must be numeric")

    price = None
    try:
        price = float(get("price"))
    except ValueError:
        errors.append(f"line {line_no}: price must be numeric")

    fees_raw = get("fees")
    fees = 0.0
    try:
        fees = float(fees_raw) if fees_raw else 0.0
    except ValueError:
        errors.append(f"line {line_no}: fees must be numeric")

    source = get("source")
    if not source:
        errors.append(f"line {line_no}: source is required")

    normalized = {
        "date": date_str,
        "asset_symbol": symbol,
        "asset_name": get("asset_name"),
        "asset_class": asset_class,
        "type": txn_type,
        "quantity": quantity,
        "price": price,
        "fees": fees,
        "currency": currency,
        "source": source,
        "notes": get("notes") or None,
    }
    return normalized, errors


def _transaction_id(row: dict) -> str:
    """Deterministic id so re-importing the same (or overlapping) CSV is a no-op."""
    key = "|".join([
        row["date"], row["asset_symbol"], row["asset_class"], row["type"],
        f"{row['quantity']:.10g}", f"{row['price']:.10g}", f"{row['fees']:.10g}",
        row["currency"], row["source"],
    ])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _get_or_create_asset(
    conn: sqlite3.Connection, symbol: str, name: str, asset_class: str, currency: str
) -> tuple[int, bool]:
    row = conn.execute("SELECT id FROM assets WHERE symbol = ?", (symbol,)).fetchone()
    if row:
        return row["id"], False
    if not name:
        raise CsvValidationError(
            f"asset {symbol!r} does not exist yet — asset_name is required the first "
            f"time a new symbol appears"
        )
    cur = conn.execute(
        "INSERT INTO assets (symbol, name, asset_class, currency) VALUES (?, ?, ?, ?)",
        (symbol, name, asset_class, currency),
    )
    return cur.lastrowid, True


def import_csv(csv_path: str | Path, conn: sqlite3.Connection) -> dict:
    """Validate and import a transactions CSV. All-or-nothing: if any row fails
    validation, nothing is written. Returns a stats dict."""
    rows = _read_rows(str(csv_path))

    normalized_rows = []
    all_errors = []
    for i, raw in enumerate(rows, start=2):  # line 1 is the header
        normalized, errors = _validate_and_normalize_row(raw, i)
        if errors:
            all_errors.extend(errors)
        else:
            normalized_rows.append(normalized)

    if all_errors:
        raise CsvValidationError("CSV validation failed:\n" + "\n".join(all_errors))

    stats = {"rows_read": len(rows), "assets_created": 0, "inserted": 0, "skipped_duplicates": 0}
    try:
        for row in normalized_rows:
            asset_id, created = _get_or_create_asset(
                conn, row["asset_symbol"], row["asset_name"], row["asset_class"], row["currency"]
            )
            if created:
                stats["assets_created"] += 1

            txn_id = _transaction_id(row)
            exists = conn.execute("SELECT 1 FROM transactions WHERE id = ?", (txn_id,)).fetchone()
            if exists:
                stats["skipped_duplicates"] += 1
                continue

            conn.execute(
                """INSERT INTO transactions
                   (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    txn_id, row["date"], asset_id, row["asset_class"], row["source"], row["type"],
                    row["quantity"], row["price"], row["fees"], row["currency"], row["notes"],
                ),
            )
            stats["inserted"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return stats
