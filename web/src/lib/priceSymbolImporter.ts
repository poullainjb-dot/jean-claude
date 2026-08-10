/**
 * Bulk-set (or clear) assets.price_symbol via CSV — the self-service tool
 * for the ISIN/ticker-format mismatch problem (e.g. asset_symbol='IWDA'
 * needs price_symbol='IWDA.AS' for a live price provider to find it).
 * Follows the same CSV-first convention as transactions/prices import,
 * since that's the pattern this app already uses everywhere else.
 *
 * A blank price_symbol clears an existing override (reverts to using
 * `symbol` directly) rather than being rejected as invalid — that's a
 * legitimate action, not a mistake.
 */

import type { PoolClient } from "pg";
import { CsvValidationError, parseCsvRows } from "./csv";
import type { PriceSymbolStats } from "./types";

const REQUIRED_COLUMNS = ["asset_symbol", "price_symbol"] as const;

interface NormalizedRow {
  assetId: number;
  assetSymbol: string;
  priceSymbol: string | null; // null = clear the override
}

async function validateAndNormalizeRow(
  client: PoolClient,
  row: Record<string, string>,
  lineNo: number,
): Promise<{ normalized: NormalizedRow | null; errors: string[] }> {
  const errors: string[] = [];
  const get = (field: string) => (row[field] ?? "").trim();

  const assetSymbol = get("asset_symbol");
  let assetId: number | null = null;
  if (!assetSymbol) {
    errors.push(`line ${lineNo}: asset_symbol is required`);
  } else {
    const res = await client.query<{ id: number }>("SELECT id FROM assets WHERE symbol = $1", [assetSymbol]);
    if (res.rows.length === 0) {
      errors.push(
        `line ${lineNo}: unknown asset_symbol ${JSON.stringify(assetSymbol)} — import its transactions first`,
      );
    } else {
      assetId = res.rows[0].id;
    }
  }

  if (errors.length > 0 || assetId === null) {
    return { normalized: null, errors };
  }

  const priceSymbolRaw = get("price_symbol");
  return {
    normalized: { assetId, assetSymbol, priceSymbol: priceSymbolRaw || null },
    errors: [],
  };
}

export async function importPriceSymbolsCsv(csvText: string, client: PoolClient): Promise<PriceSymbolStats> {
  const rawRecords = parseCsvRows(csvText, REQUIRED_COLUMNS);

  const normalizedRows: NormalizedRow[] = [];
  const allErrors: string[] = [];
  for (let i = 0; i < rawRecords.length; i++) {
    const lineNo = i + 2;
    const { normalized, errors } = await validateAndNormalizeRow(client, rawRecords[i], lineNo);
    if (errors.length > 0) {
      allErrors.push(...errors);
    } else if (normalized) {
      normalizedRows.push(normalized);
    }
  }

  if (allErrors.length > 0) {
    throw new CsvValidationError("CSV validation failed:\n" + allErrors.join("\n"));
  }

  const stats: PriceSymbolStats = { rowsRead: rawRecords.length, updated: 0, unchanged: 0, cleared: 0 };

  await client.query("BEGIN");
  try {
    for (const row of normalizedRows) {
      const existing = await client.query<{ price_symbol: string | null }>(
        "SELECT price_symbol FROM assets WHERE id = $1",
        [row.assetId],
      );
      const current = existing.rows[0].price_symbol;

      if (current === row.priceSymbol) {
        stats.unchanged += 1;
        continue;
      }

      await client.query("UPDATE assets SET price_symbol = $1 WHERE id = $2", [row.priceSymbol, row.assetId]);
      if (row.priceSymbol === null) {
        stats.cleared += 1;
      } else {
        stats.updated += 1;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return stats;
}
