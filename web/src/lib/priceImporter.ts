/**
 * Manual CSV import for the `prices` table. Direct TypeScript port of
 * portfolio/price_importer.py (repo root).
 *
 * Unlike transactions, a price row requires the asset to already exist —
 * import its transactions first. Cash assets never need a price import;
 * their price is always 1 by definition (see valuation.ts).
 *
 * Re-importing a (asset, date) pair updates the price if it changed, and is
 * a no-op if it's identical — a correction is just re-importing with a new
 * value.
 */

import type { PoolClient } from "pg";
import { CsvValidationError, isValidDate, parseCsvRows } from "./csv";
import type { ImportPricesStats } from "./types";

const REQUIRED_COLUMNS = ["date", "asset_symbol", "price", "source"] as const;

interface NormalizedPriceRow {
  assetId: number;
  date: string;
  price: number;
  source: string;
}

async function validateAndNormalizeRow(
  client: PoolClient,
  row: Record<string, string>,
  lineNo: number,
): Promise<{ normalized: NormalizedPriceRow | null; errors: string[] }> {
  const errors: string[] = [];
  const get = (field: string) => (row[field] ?? "").trim();

  const dateStr = get("date");
  if (!isValidDate(dateStr)) {
    errors.push(`line ${lineNo}: invalid date ${JSON.stringify(dateStr)} (expected YYYY-MM-DD)`);
  }

  const symbol = get("asset_symbol");
  let assetId: number | null = null;
  if (!symbol) {
    errors.push(`line ${lineNo}: asset_symbol is required`);
  } else {
    const res = await client.query<{ id: number }>("SELECT id FROM assets WHERE symbol = $1", [symbol]);
    if (res.rows.length === 0) {
      errors.push(`line ${lineNo}: unknown asset_symbol ${JSON.stringify(symbol)} — import its transactions first`);
    } else {
      assetId = res.rows[0].id;
    }
  }

  const priceRaw = get("price");
  const price = Number(priceRaw);
  if (priceRaw === "" || Number.isNaN(price)) {
    errors.push(`line ${lineNo}: price must be numeric`);
  }

  const source = get("source");
  if (!source) {
    errors.push(`line ${lineNo}: source is required`);
  }

  if (errors.length > 0 || assetId === null) {
    return { normalized: null, errors };
  }

  return { normalized: { assetId, date: dateStr, price, source }, errors: [] };
}

/**
 * Validate and import a prices CSV. All-or-nothing: if any row fails
 * validation, nothing is written.
 */
export async function importPricesCsv(csvText: string, client: PoolClient): Promise<ImportPricesStats> {
  const rawRecords = parseCsvRows(csvText, REQUIRED_COLUMNS);

  const normalizedRows: NormalizedPriceRow[] = [];
  const allErrors: string[] = [];
  for (let i = 0; i < rawRecords.length; i++) {
    const lineNo = i + 2; // line 1 is the header
    const { normalized, errors } = await validateAndNormalizeRow(client, rawRecords[i], lineNo);
    if (errors.length > 0) {
      allErrors.push(...errors);
    } else if (normalized) {
      normalizedRows.push(normalized);
    }
  }

  if (allErrors.length > 0) {
    throw new CsvValidationError(`CSV validation failed:\n${allErrors.join("\n")}`);
  }

  const stats: ImportPricesStats = { rowsRead: rawRecords.length, inserted: 0, updated: 0, unchanged: 0 };

  await client.query("BEGIN");
  try {
    for (const row of normalizedRows) {
      const existing = await client.query<{ price: number }>(
        "SELECT price FROM prices WHERE asset_id = $1 AND date = $2",
        [row.assetId, row.date],
      );
      if (existing.rows.length === 0) {
        await client.query("INSERT INTO prices (asset_id, date, price, source) VALUES ($1, $2, $3, $4)", [
          row.assetId,
          row.date,
          row.price,
          row.source,
        ]);
        stats.inserted += 1;
      } else if (Math.abs(Number(existing.rows[0].price) - row.price) > 1e-9) {
        await client.query("UPDATE prices SET price = $1, source = $2 WHERE asset_id = $3 AND date = $4", [
          row.price,
          row.source,
          row.assetId,
          row.date,
        ]);
        stats.updated += 1;
      } else {
        stats.unchanged += 1;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return stats;
}
