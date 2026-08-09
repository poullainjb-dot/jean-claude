"""Value and profit computation: holdings x current price, minus net
contributions. Never stored — always a fresh computation from transactions +
prices.

Cost-basis convention: "net contributions" is the running net cash moved
into a position — buys/deposits/interest add (quantity*price + fees),
sells/withdrawals subtract (quantity*price - fees). This is a simplification,
not full FIFO/average-cost lot accounting: it's exact for a position that's
only ever been added to, and a reasonable approximation once partial sells
are involved (it tracks "money still tied up," not a precise realized vs.
unrealized split). Flagging this now — revisit if that approximation stops
being good enough once there's real trading history to check it against.

Currency: values are computed in each asset's own currency. This module does
NOT convert to a single base currency — no FX rate source is wired up yet
(an open item from the spec). Totals are therefore reported per-currency
rather than as one combined number, so we never show a total that's silently
wrong.
"""

import sqlite3

from .holdings import compute_holdings

_COST_BASIS_SQL = """
    SELECT COALESCE(SUM(
        CASE type
            WHEN 'buy' THEN quantity * price + fees
            WHEN 'deposit' THEN quantity * price + fees
            WHEN 'interest' THEN quantity * price + fees
            WHEN 'sell' THEN -(quantity * price - fees)
            WHEN 'withdrawal' THEN -(quantity * price - fees)
            ELSE 0
        END
    ), 0) AS net_contributions
    FROM transactions
    WHERE asset_id = ?
"""


def _net_contributions(conn: sqlite3.Connection, asset_id: int) -> float:
    return conn.execute(_COST_BASIS_SQL, (asset_id,)).fetchone()["net_contributions"]


def _latest_price(conn: sqlite3.Connection, asset_id: int) -> float | None:
    row = conn.execute(
        "SELECT price FROM prices WHERE asset_id = ? ORDER BY date DESC LIMIT 1",
        (asset_id,),
    ).fetchone()
    return row["price"] if row else None


def compute_positions(conn: sqlite3.Connection) -> list[dict]:
    """One row per held asset: quantity, price, value, cost basis, profit.

    `price`/`value`/`profit`/`profit_pct` are None when no price data is
    available yet — cash positions are the one exception, always worth 1:1
    in their own currency, so they never need a price import.
    """
    positions = []
    for h in compute_holdings(conn):
        asset_id = h["asset_id"]
        is_cash = h["asset_class"] == "cash"
        price = 1.0 if is_cash else _latest_price(conn, asset_id)
        net_contributions = _net_contributions(conn, asset_id)
        value = h["quantity"] * price if price is not None else None
        profit = (value - net_contributions) if value is not None else None
        profit_pct = (
            (profit / net_contributions * 100)
            if profit is not None and abs(net_contributions) > 1e-9
            else None
        )
        positions.append({
            **h,
            "price": price,
            "value": value,
            "net_contributions": net_contributions,
            "profit": profit,
            "profit_pct": profit_pct,
        })
    return positions


def totals_by_currency(positions: list[dict]) -> dict[str, dict]:
    """Sum value/profit per currency. Positions with no price yet are
    excluded from the sum (their value is unknown, not zero) and listed
    under `missing_price` instead, so a stale/missing price never silently
    understates the total."""
    totals: dict[str, dict] = {}
    for p in positions:
        ccy = p["currency"]
        bucket = totals.setdefault(
            ccy, {"value": 0.0, "net_contributions": 0.0, "profit": 0.0, "missing_price": []}
        )
        bucket["net_contributions"] += p["net_contributions"]
        if p["value"] is None:
            bucket["missing_price"].append(p["symbol"])
        else:
            bucket["value"] += p["value"]
            bucket["profit"] += p["profit"]
    return totals
