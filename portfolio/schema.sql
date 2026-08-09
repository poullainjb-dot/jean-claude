-- Core data model (spec section 2).
-- transactions is the source of truth; holdings/value/P&L are always
-- computed from transactions + prices, never stored.

CREATE TABLE IF NOT EXISTS assets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL UNIQUE,     -- ticker or ISIN, e.g. 'IWDA', 'US0378331005', 'BTC', 'EUR_CASH'
    name        TEXT,
    asset_class TEXT NOT NULL CHECK (asset_class IN ('stock', 'etf', 'cash', 'gold', 'crypto')),
    currency    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,   -- sha256 of (date, symbol, asset_class, type, quantity, price, fees, currency, source) — makes re-importing idempotent
    date        TEXT NOT NULL,      -- ISO date, YYYY-MM-DD
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    asset_class TEXT NOT NULL CHECK (asset_class IN ('stock', 'etf', 'cash', 'gold', 'crypto')),
    source      TEXT NOT NULL,      -- manual / bolero / traderepublic / binance / coinbase / kraken / ...
    type        TEXT NOT NULL CHECK (type IN ('buy', 'sell', 'deposit', 'withdrawal', 'interest', 'dividend')),
    -- Convention: for buy/sell, quantity = units traded and price = per-unit price.
    -- For deposit/withdrawal/interest/dividend (pure cash flows), quantity = cash
    -- amount and price = 1. This keeps "value moved" always = quantity * price.
    quantity    REAL NOT NULL,
    price       REAL NOT NULL,
    fees        REAL NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL,
    notes       TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_asset_id ON transactions(asset_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

CREATE TABLE IF NOT EXISTS prices (
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    date     TEXT NOT NULL,     -- ISO date, YYYY-MM-DD
    price    REAL NOT NULL,
    source   TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (asset_id, date)
);
