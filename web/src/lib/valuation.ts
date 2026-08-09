/**
 * Value and profit computation: holdings x current price, minus net
 * contributions. Never stored — always a fresh computation from
 * transactions + prices. Direct TypeScript port of portfolio/valuation.py
 * (repo root) — see that file's docstring for the cost-basis and
 * no-FX-conversion-yet conventions this encodes.
 */

import type { Pool, PoolClient } from "pg";
import { computeHoldings, type Holding } from "./holdings";

export interface Position extends Holding {
  price: number | null;
  value: number | null;
  netContributions: number;
  profit: number | null;
  profitPct: number | null;
}

export interface CurrencyTotal {
  value: number;
  netContributions: number;
  profit: number;
  missingPrice: string[];
}

const COST_BASIS_SQL = `
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
  WHERE asset_id = $1
`;

async function netContributions(db: Pool | PoolClient, assetId: number): Promise<number> {
  const res = await db.query<{ net_contributions: number }>(COST_BASIS_SQL, [assetId]);
  return Number(res.rows[0].net_contributions);
}

async function latestPrice(db: Pool | PoolClient, assetId: number): Promise<number | null> {
  const res = await db.query<{ price: number }>(
    "SELECT price FROM prices WHERE asset_id = $1 ORDER BY date DESC LIMIT 1",
    [assetId],
  );
  return res.rows.length > 0 ? Number(res.rows[0].price) : null;
}

/**
 * One row per held asset: quantity, price, value, cost basis, profit.
 * price/value/profit/profitPct are null when no price data is available
 * yet — cash positions are the one exception, always worth 1:1 in their own
 * currency, so they never need a price import.
 */
export async function computePositions(db: Pool | PoolClient): Promise<Position[]> {
  const holdings = await computeHoldings(db);
  const positions: Position[] = [];

  for (const h of holdings) {
    const isCash = h.assetClass === "cash";
    const price = isCash ? 1 : await latestPrice(db, h.assetId);
    const contributions = await netContributions(db, h.assetId);
    const value = price !== null ? h.quantity * price : null;
    const profit = value !== null ? value - contributions : null;
    const profitPct = profit !== null && Math.abs(contributions) > 1e-9 ? (profit / contributions) * 100 : null;

    positions.push({
      ...h,
      price,
      value,
      netContributions: contributions,
      profit,
      profitPct,
    });
  }

  return positions;
}

/**
 * Sum value/profit per currency. Positions with no price yet are excluded
 * from the sum (their value is unknown, not zero) and listed under
 * missingPrice instead, so a stale/missing price never silently
 * understates the total.
 */
export function totalsByCurrency(positions: Position[]): Record<string, CurrencyTotal> {
  const totals: Record<string, CurrencyTotal> = {};

  for (const p of positions) {
    const bucket =
      totals[p.currency] ??
      (totals[p.currency] = { value: 0, netContributions: 0, profit: 0, missingPrice: [] });

    bucket.netContributions += p.netContributions;
    if (p.value === null) {
      bucket.missingPrice.push(p.symbol);
    } else {
      bucket.value += p.value;
      bucket.profit += p.profit as number;
    }
  }

  return totals;
}
