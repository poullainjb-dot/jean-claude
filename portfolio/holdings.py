"""Computed holdings: current quantity per asset, derived purely from
transactions. Never stored — always a fresh query.

This is a single-entry model, not full double-entry bookkeeping: each
transaction only affects the quantity of the asset named in its own
asset_id. Buying a stock does NOT automatically decrement a cash position —
if you want a cash balance to reflect money spent on a purchase, log that
withdrawal yourself. (This mirrors how the spec scopes cash: it's sourced
specifically from TradeRepublic's own unified transaction stream, not
modeled as a general pool funding purchases at other brokers.)

Quantity convention: buy/deposit/interest add to quantity; sell/withdrawal
subtract from it. `dividend` never changes quantity — dividends are tracked
purely as income events on the asset that paid them (for yield/history), not
as an automatic cash credit. If you want the cash from a dividend reflected
in a cash balance, log a separate deposit transaction for it.
"""

import sqlite3

_QUANTITY_SQL = """
    SELECT a.id AS asset_id, a.symbol, a.name, a.asset_class, a.currency,
           COALESCE(SUM(
               CASE t.type
                   WHEN 'buy' THEN t.quantity
                   WHEN 'deposit' THEN t.quantity
                   WHEN 'interest' THEN t.quantity
                   WHEN 'sell' THEN -t.quantity
                   WHEN 'withdrawal' THEN -t.quantity
                   ELSE 0
               END
           ), 0) AS quantity
    FROM assets a
    LEFT JOIN transactions t ON t.asset_id = a.id
    GROUP BY a.id
    ORDER BY a.symbol
"""


def compute_holdings(conn: sqlite3.Connection, include_zero: bool = False) -> list[dict]:
    """One row per asset with its current computed quantity.

    By default, closed-out positions (net quantity ~0) are omitted. Pass
    include_zero=True to see every asset that's ever appeared in a transaction.
    """
    rows = conn.execute(_QUANTITY_SQL).fetchall()
    holdings = [dict(r) for r in rows]
    if not include_zero:
        holdings = [h for h in holdings if abs(h["quantity"]) > 1e-9]
    return holdings
