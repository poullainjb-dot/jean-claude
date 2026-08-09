/**
 * Manual CSV import for the `transactions` table. Direct TypeScript port of
 * portfolio/importer.py (repo root) — same validation rules, same
 * all-or-nothing behavior, same dedup approach. See that file's docstring
 * and the README for the conventions this encodes (cash-flow quantity/price
 * convention, single-entry model, etc.).
 */

import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { PoolClient } from "pg";
import type { AssetClass, ImportStats, TransactionType } from "./types";

const REQUIRED_COLUMNS = [
  "date",
  "asset_symbol",
  "asset_class",
  "type",
  "quantity",
  "price",
  "fees",
  "currency",
  "source",
] as const;

const VALID_ASSET_CLASSES: readonly AssetClass[] = ["stock", "etf", "cash", "gold", "crypto"];
const VALID_TYPES: readonly TransactionType[] = [
  "buy",
  "sell",
  "deposit",
  "withdrawal",
  "interest",
  "dividend",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CsvValidationError extends Error {}

interface NormalizedRow {
  date: string;
  assetSymbol: string;
  assetName: string | null;
  assetClass: AssetClass;
  type: TransactionType;
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  source: string;
  notes: string | null;
}

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  // Reject e.g. 2024-02-30 — Date would otherwise silently roll it forward
  // to March 1st instead of rejecting it.
  const d = new Date(`${s}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === s;
}

/** Parses the CSV and returns one plain object per data row, keyed by header. */
function parseRows(csvText: string): Record<string, string>[] {
  let rawRows: string[][];
  try {
    rawRows = parse(csvText, { skip_empty_lines: true, trim: false }) as string[][];
  } catch (err) {
    throw new CsvValidationError(`Failed to parse CSV: ${(err as Error).message}`);
  }

  if (rawRows.length === 0) {
    throw new CsvValidationError("CSV is empty");
  }

  const header = rawRows[0];
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new CsvValidationError(`CSV is missing required column(s): ${JSON.stringify(missing)}`);
  }

  return rawRows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((col, i) => {
      record[col] = row[i] ?? "";
    });
    return record;
  });
}

function validateAndNormalizeRow(
  row: Record<string, string>,
  lineNo: number,
): { normalized: NormalizedRow | null; errors: string[] } {
  const errors: string[] = [];
  const get = (field: string) => (row[field] ?? "").trim();

  const dateStr = get("date");
  if (!isValidDate(dateStr)) {
    errors.push(`line ${lineNo}: invalid date ${JSON.stringify(dateStr)} (expected YYYY-MM-DD)`);
  }

  const assetClass = get("asset_class").toLowerCase() as AssetClass;
  if (!VALID_ASSET_CLASSES.includes(assetClass)) {
    errors.push(
      `line ${lineNo}: invalid asset_class ${JSON.stringify(assetClass)} (expected one of ${JSON.stringify(VALID_ASSET_CLASSES)})`,
    );
  }

  const type = get("type").toLowerCase() as TransactionType;
  if (!VALID_TYPES.includes(type)) {
    errors.push(
      `line ${lineNo}: invalid type ${JSON.stringify(type)} (expected one of ${JSON.stringify(VALID_TYPES)})`,
    );
  }

  const symbol = get("asset_symbol");
  if (!symbol) {
    errors.push(`line ${lineNo}: asset_symbol is required`);
  }

  const currency = get("currency").toUpperCase();
  if (currency.length !== 3 || !/^[A-Z]{3}$/.test(currency)) {
    errors.push(`line ${lineNo}: invalid currency ${JSON.stringify(currency)} (expected a 3-letter code)`);
  }

  const quantityRaw = get("quantity");
  const quantity = Number(quantityRaw);
  if (quantityRaw === "" || Number.isNaN(quantity)) {
    errors.push(`line ${lineNo}: quantity must be numeric`);
  }

  const priceRaw = get("price");
  const price = Number(priceRaw);
  if (priceRaw === "" || Number.isNaN(price)) {
    errors.push(`line ${lineNo}: price must be numeric`);
  }

  const feesRaw = get("fees");
  let fees = 0;
  if (feesRaw !== "") {
    fees = Number(feesRaw);
    if (Number.isNaN(fees)) {
      errors.push(`line ${lineNo}: fees must be numeric`);
    }
  }

  const source = get("source");
  if (!source) {
    errors.push(`line ${lineNo}: source is required`);
  }

  if (errors.length > 0) {
    return { normalized: null, errors };
  }

  return {
    normalized: {
      date: dateStr,
      assetSymbol: symbol,
      assetName: get("asset_name") || null,
      assetClass,
      type,
      quantity,
      price,
      fees,
      currency,
      source,
      notes: get("notes") || null,
    },
    errors: [],
  };
}

/** Deterministic id so re-importing the same (or overlapping) CSV is a no-op. */
function transactionId(row: NormalizedRow): string {
  const key = [
    row.date,
    row.assetSymbol,
    row.assetClass,
    row.type,
    String(row.quantity),
    String(row.price),
    String(row.fees),
    row.currency,
    row.source,
  ].join("|");
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function getOrCreateAsset(
  client: PoolClient,
  symbol: string,
  name: string | null,
  assetClass: AssetClass,
  currency: string,
): Promise<{ id: number; created: boolean }> {
  const existing = await client.query<{ id: number }>("SELECT id FROM assets WHERE symbol = $1", [symbol]);
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false };
  }
  if (!name) {
    throw new CsvValidationError(
      `asset ${JSON.stringify(symbol)} does not exist yet — asset_name is required the first time a new symbol appears`,
    );
  }
  const inserted = await client.query<{ id: number }>(
    "INSERT INTO assets (symbol, name, asset_class, currency) VALUES ($1, $2, $3, $4) RETURNING id",
    [symbol, name, assetClass, currency],
  );
  return { id: inserted.rows[0].id, created: true };
}

/**
 * Validate and import a transactions CSV. All-or-nothing: if any row fails
 * validation, nothing is written. `client` must be a checked-out PoolClient
 * (not the Pool itself) so BEGIN/COMMIT/ROLLBACK apply to a single connection.
 */
export async function importTransactionsCsv(csvText: string, client: PoolClient): Promise<ImportStats> {
  const rawRecords = parseRows(csvText);

  const normalizedRows: NormalizedRow[] = [];
  const allErrors: string[] = [];
  rawRecords.forEach((raw, i) => {
    const lineNo = i + 2; // line 1 is the header
    const { normalized, errors } = validateAndNormalizeRow(raw, lineNo);
    if (errors.length > 0) {
      allErrors.push(...errors);
    } else if (normalized) {
      normalizedRows.push(normalized);
    }
  });

  if (allErrors.length > 0) {
    throw new CsvValidationError(`CSV validation failed:\n${allErrors.join("\n")}`);
  }

  const stats: ImportStats = { rowsRead: rawRecords.length, assetsCreated: 0, inserted: 0, skippedDuplicates: 0 };

  await client.query("BEGIN");
  try {
    for (const row of normalizedRows) {
      const { id: assetId, created } = await getOrCreateAsset(
        client,
        row.assetSymbol,
        row.assetName,
        row.assetClass,
        row.currency,
      );
      if (created) stats.assetsCreated += 1;

      const txnId = transactionId(row);
      const existing = await client.query("SELECT 1 FROM transactions WHERE id = $1", [txnId]);
      if (existing.rows.length > 0) {
        stats.skippedDuplicates += 1;
        continue;
      }

      await client.query(
        `INSERT INTO transactions
           (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          txnId,
          row.date,
          assetId,
          row.assetClass,
          row.source,
          row.type,
          row.quantity,
          row.price,
          row.fees,
          row.currency,
          row.notes,
        ],
      );
      stats.inserted += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return stats;
}
