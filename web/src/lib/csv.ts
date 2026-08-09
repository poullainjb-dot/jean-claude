import { parse } from "csv-parse/sync";

export class CsvValidationError extends Error {}

/**
 * Parses CSV text into records keyed by header column, after validating the
 * header contains every required column. Shared by both the transactions
 * and prices importers so their CSV-parsing behavior never diverges.
 */
export function parseCsvRows(csvText: string, requiredColumns: readonly string[]): Record<string, string>[] {
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
  const missing = requiredColumns.filter((c) => !header.includes(c));
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD check — rejects e.g. 2024-02-30 rather than silently rolling it forward. */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === s;
}
