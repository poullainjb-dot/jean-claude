/**
 * Computed holdings: current quantity per asset, derived purely from
 * transactions. Never stored — always a fresh query. Direct TypeScript port
 * of portfolio/holdings.py (repo root); see that file's docstring for the
 * single-entry-model / dividend conventions this encodes.
 */

import type { Pool, PoolClient } from "pg";
import type { AssetClass } from "./types";

export interface Holding {
  assetId: number;
  symbol: string;
  name: string | null;
  assetClass: AssetClass;
  currency: string;
  quantity: number;
}

const QUANTITY_SQL = `
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
`;

interface QuantityRow {
  asset_id: number;
  symbol: string;
  name: string | null;
  asset_class: AssetClass;
  currency: string;
  quantity: number;
}

/**
 * One row per asset with its current computed quantity. By default,
 * closed-out positions (net quantity ~0) are omitted — pass
 * includeZero: true to see every asset that's ever appeared in a transaction.
 */
export async function computeHoldings(
  db: Pool | PoolClient,
  { includeZero = false }: { includeZero?: boolean } = {},
): Promise<Holding[]> {
  const res = await db.query<QuantityRow>(QUANTITY_SQL);
  const holdings: Holding[] = res.rows.map((r) => ({
    assetId: r.asset_id,
    symbol: r.symbol,
    name: r.name,
    assetClass: r.asset_class,
    currency: r.currency,
    quantity: Number(r.quantity),
  }));
  if (includeZero) return holdings;
  return holdings.filter((h) => Math.abs(h.quantity) > 1e-9);
}
