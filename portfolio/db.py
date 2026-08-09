"""SQLite connection + schema management."""

import os
import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).parent / "schema.sql"
DEFAULT_DB_PATH = "./data/portfolio.db"


def get_db_path() -> str:
    return os.environ.get("PORTFOLIO_DB_PATH", DEFAULT_DB_PATH)


def connect(db_path: str | None = None) -> sqlite3.Connection:
    """Open a connection to the portfolio DB, creating the parent dir if needed."""
    db_path = db_path or get_db_path()
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create the schema if it doesn't exist yet. Safe to call repeatedly."""
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
