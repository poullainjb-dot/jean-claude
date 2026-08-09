/**
 * Core data model, ported from the original SQLite version
 * (see the repo root's portfolio/schema.sql, kept as reference).
 *
 * transactions is the source of truth; holdings/value/P&L are computed from
 * transactions + prices at query time, never stored.
 *
 * Kept as an inline string (not a .sql file read from disk) so it bundles
 * reliably into Vercel's serverless function output — no filesystem path
 * resolution to worry about at runtime.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assets (
    id           SERIAL PRIMARY KEY,
    symbol       TEXT NOT NULL UNIQUE,
    name         TEXT,
    asset_class  TEXT NOT NULL CHECK (asset_class IN ('stock', 'etf', 'cash', 'gold', 'crypto')),
    currency     TEXT NOT NULL,
    -- The ticker a live price connector should look up, if it differs from
    -- \`symbol\` (e.g. symbol is an ISIN, or Yahoo Finance needs an exchange
    -- suffix like '.AS'). NULL means "use symbol as-is". Added for R5 — see
    -- priceRefresh.ts.
    price_symbol TEXT
);

-- Idempotent, so it also applies to databases that already had \`assets\`
-- before price_symbol existed (CREATE TABLE IF NOT EXISTS above is a no-op
-- on those).
ALTER TABLE assets ADD COLUMN IF NOT EXISTS price_symbol TEXT;

CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    date        DATE NOT NULL,
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    asset_class TEXT NOT NULL CHECK (asset_class IN ('stock', 'etf', 'cash', 'gold', 'crypto')),
    source      TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('buy', 'sell', 'deposit', 'withdrawal', 'interest', 'dividend')),
    quantity    DOUBLE PRECISION NOT NULL,
    price       DOUBLE PRECISION NOT NULL,
    fees        DOUBLE PRECISION NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL,
    notes       TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_asset_id ON transactions (asset_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);

CREATE TABLE IF NOT EXISTS prices (
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    date     DATE NOT NULL,
    price    DOUBLE PRECISION NOT NULL,
    source   TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (asset_id, date)
);
`;
