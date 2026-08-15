/**
 * Bolero "Portfolio Positions" snapshot import. Bolero (KBC's execution-only
 * broker) doesn't offer a low-friction transaction-history export in
 * practice — the format this was actually built against is the "Positions"
 * export (Portfolio → Posities → export → Excel), a point-in-time snapshot
 * of current holdings with average cost, not a list of individual buy/sell
 * events. This importer works with that constraint rather than around it:
 * each holding becomes one synthetic "buy" transaction at its average cost,
 * dated to the export's own "Imprimé le" (printed on) timestamp.
 *
 * This trades away real transaction history (exact trade dates, per-trade
 * fees, realized P&L, dividends before the first import) for zero-friction
 * onboarding — paste in whatever Bolero will actually export, done. Ongoing
 * valuation from here on is accurate; it's only the cost-basis and history
 * *before* the first snapshot that's approximated as "as if bought today".
 *
 * Snapshot semantics, not additive: re-importing a later export must
 * reflect reality (a sold position should disappear, a changed quantity
 * should update in place) rather than piling up duplicate buys on re-import.
 * So every row is upserted by a deterministic id keyed on the asset only
 * (not on date/quantity/price like the regular transactions importer), and
 * any previous snapshot row for an asset that's no longer in this export is
 * deleted. All synthetic rows carry source = SNAPSHOT_SOURCE so this only
 * ever touches rows it created — manually-imported transactions for the
 * same asset are untouched.
 *
 * Symbol: Bolero's export gives ISIN, not a ticker — so ISIN is used as the
 * asset's `symbol`. Price providers don't resolve ISINs directly; use the
 * existing "Price symbols" tool (priceSymbolImporter.ts) to map each ISIN to
 * a working ticker (see /assets for the exchange each position trades on).
 *
 * Uses exceljs, not the more common `xlsx` (SheetJS) package — the npm
 * `xlsx` release is stuck on a version with known, unfixed prototype
 * pollution / ReDoS advisories (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9)
 * that a malicious upload could hit directly, since parsing an uploaded
 * file is exactly the attack surface those bugs are in.
 */

import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { CsvValidationError } from "./csv";
import { getOrCreateAsset } from "./importer";
import type { AssetClass, BoleroPositionsStats } from "./types";

export const SNAPSHOT_SOURCE = "bolero-snapshot";

const TYPE_MAP: Record<string, AssetClass> = {
  Actions: "stock",
  ETF: "etf",
};

interface NormalizedRow {
  isin: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  quantity: number;
  avgPrice: number;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/**
 * Non-empty (index, text) pairs in a raw row, in column order. Used only to
 * *search* for marker rows ("Imprimé le", the header) — never to extract
 * data-row values, since dropping blanks independently per row would
 * misalign any row where a real field happens to be blank (see
 * columnIndex below for the position-anchored approach that avoids that).
 */
function nonEmptyPairs(raw: unknown[]): { index: number; text: string }[] {
  const pairs: { index: number; text: string }[] = [];
  raw.forEach((v, index) => {
    const text = cellText(v);
    if (text !== "") pairs.push({ index, text });
  });
  return pairs;
}

const REQUIRED_HEADERS = ["Type", "Dev.", "Nombre", "Nom", "Cours d'achat moyen", "ISIN"] as const;

/**
 * Parses the workbook into normalized rows plus the export's own "printed
 * on" date, used as the synthetic transactions' date. Pure aside from the
 * exceljs load call, so it's the part covered by unit tests without a DB.
 */
export async function parseBoleroPositionsWorkbook(
  buffer: Buffer,
): Promise<{ rows: NormalizedRow[]; asOfDate: string }> {
  const workbook = new ExcelJS.Workbook();
  try {
    // Cast: TS 5.7+'s generic Uint8Array/Buffer lib types vs. exceljs's
    // older non-generic Buffer declaration — a known ecosystem type
    // mismatch (not a real runtime issue; a Buffer is a Buffer).
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (err) {
    throw new CsvValidationError(`Failed to read .xlsx file: ${(err as Error).message}`);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new CsvValidationError("Workbook has no sheets");
  }

  // Keyed by actual row number (not array index) since eachRow skips rows
  // with no cells at all, and row.values is itself a sparse, 1-indexed
  // array (index 0 is always undefined) — both preserved here so column
  // *position* stays meaningful for every row.
  const rowsByNumber = new Map<number, unknown[]>();
  sheet.eachRow((row) => {
    rowsByNumber.set(row.number, row.values as unknown[]);
  });
  const rowNumbers = [...rowsByNumber.keys()].sort((a, b) => a - b);

  let asOfDate: string | null = null;
  for (const n of rowNumbers) {
    const pairs = nonEmptyPairs(rowsByNumber.get(n)!);
    if (pairs[0]?.text === "Imprimé le" && rowsByNumber.get(n)![pairs[1]?.index] instanceof Date) {
      asOfDate = (rowsByNumber.get(n)![pairs[1].index] as Date).toISOString().slice(0, 10);
      break;
    }
  }
  if (!asOfDate) {
    throw new CsvValidationError('Could not find the "Imprimé le" export date in the workbook');
  }

  const headerRowNumber = rowNumbers.find((n) => {
    const texts = nonEmptyPairs(rowsByNumber.get(n)!).map((p) => p.text);
    return texts.includes("Type") && texts.includes("ISIN");
  });
  if (headerRowNumber === undefined) {
    throw new CsvValidationError('Could not find a header row containing "Type" and "ISIN" columns');
  }
  const headerRaw = rowsByNumber.get(headerRowNumber)!;
  const columnIndex = new Map(nonEmptyPairs(headerRaw).map((p) => [p.text, p.index]));

  const missing = REQUIRED_HEADERS.filter((c) => !columnIndex.has(c));
  if (missing.length > 0) {
    throw new CsvValidationError(`Workbook is missing expected column(s): ${JSON.stringify(missing)}`);
  }
  // Non-null: presence of every REQUIRED_HEADERS key was just checked above.
  const isinIndex = columnIndex.get("ISIN")!;
  const typeIndex = columnIndex.get("Type")!;
  const devIndex = columnIndex.get("Dev.")!;
  const nombreIndex = columnIndex.get("Nombre")!;
  const nomIndex = columnIndex.get("Nom")!;
  const avgPriceIndex = columnIndex.get("Cours d'achat moyen")!;

  const rows: NormalizedRow[] = [];
  const errors: string[] = [];

  for (const excelRowNo of rowNumbers) {
    if (excelRowNo <= headerRowNumber) continue;
    const raw = rowsByNumber.get(excelRowNo)!;
    // ISIN is the rightmost column in the real export and never blank on a
    // genuine position — the footer/disclaimer text below the table never
    // reaches that far right, so this is what actually distinguishes "end
    // of table" from "a row with some other field missing" (the latter
    // should be a clear per-field error below, not silently dropped).
    if (cellText(raw[isinIndex]) === "") break;

    const typeText = cellText(raw[typeIndex]);
    const isin = cellText(raw[isinIndex]);
    const name = cellText(raw[nomIndex]);
    const currency = cellText(raw[devIndex]).toUpperCase();
    const quantity = Number(raw[nombreIndex]);
    const avgPrice = Number(raw[avgPriceIndex]);

    const rowErrors: string[] = [];
    if (!(typeText in TYPE_MAP)) {
      rowErrors.push(
        `row ${excelRowNo}: unsupported Type ${JSON.stringify(typeText)} (only Actions/ETF are supported here — import this position via the Transactions CSV instead)`,
      );
    }
    if (!name) rowErrors.push(`row ${excelRowNo}: missing Nom`);
    if (currency.length !== 3 || !/^[A-Z]{3}$/.test(currency)) {
      rowErrors.push(`row ${excelRowNo}: invalid currency ${JSON.stringify(currency)}`);
    }
    if (!Number.isFinite(quantity)) {
      rowErrors.push(`row ${excelRowNo}: Nombre is not numeric`);
    }
    if (!Number.isFinite(avgPrice)) {
      rowErrors.push(`row ${excelRowNo}: Cours d'achat moyen is not numeric`);
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      rows.push({ isin, name, assetClass: TYPE_MAP[typeText], currency, quantity, avgPrice });
    }
  }

  if (errors.length > 0) {
    throw new CsvValidationError(`Bolero positions workbook failed validation:\n${errors.join("\n")}`);
  }
  if (rows.length === 0) {
    throw new CsvValidationError("No position rows found in the workbook");
  }

  return { rows, asOfDate };
}

function snapshotTransactionId(isin: string): string {
  return createHash("sha256").update(`${SNAPSHOT_SOURCE}|${isin}`, "utf8").digest("hex");
}

/**
 * Imports a Bolero "Portfolio Positions" .xlsx export as one synthetic buy
 * transaction per holding, upserted (see module docstring for why this
 * isn't additive like the regular CSV importers).
 */
export async function importBoleroPositionsXlsx(
  buffer: Buffer,
  client: PoolClient,
): Promise<BoleroPositionsStats> {
  const { rows, asOfDate } = await parseBoleroPositionsWorkbook(buffer);

  const stats: BoleroPositionsStats = { rowsRead: rows.length, assetsCreated: 0, inserted: 0, updated: 0, removed: 0 };

  await client.query("BEGIN");
  try {
    const seenIds: string[] = [];

    for (const row of rows) {
      const { id: assetId, created } = await getOrCreateAsset(
        client,
        row.isin,
        row.name,
        row.assetClass,
        row.currency,
      );
      if (created) stats.assetsCreated += 1;

      const txnId = snapshotTransactionId(row.isin);
      seenIds.push(txnId);

      const existing = await client.query("SELECT 1 FROM transactions WHERE id = $1", [txnId]);
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE transactions
             SET date = $2, asset_id = $3, asset_class = $4, quantity = $5, price = $6, fees = 0, currency = $7,
                 notes = $8
           WHERE id = $1`,
          [
            txnId,
            asOfDate,
            assetId,
            row.assetClass,
            row.quantity,
            row.avgPrice,
            row.currency,
            `Bolero positions snapshot (${asOfDate}) — average cost, not a real trade date`,
          ],
        );
        stats.updated += 1;
      } else {
        await client.query(
          `INSERT INTO transactions
             (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency, notes)
           VALUES ($1, $2, $3, $4, $5, 'buy', $6, $7, 0, $8, $9)`,
          [
            txnId,
            asOfDate,
            assetId,
            row.assetClass,
            SNAPSHOT_SOURCE,
            row.quantity,
            row.avgPrice,
            row.currency,
            `Bolero positions snapshot (${asOfDate}) — average cost, not a real trade date`,
          ],
        );
        stats.inserted += 1;
      }
    }

    const removedRes = await client.query(
      `DELETE FROM transactions WHERE source = $1 AND NOT (id = ANY($2::text[])) RETURNING id`,
      [SNAPSHOT_SOURCE, seenIds],
    );
    stats.removed = removedRes.rowCount ?? 0;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return stats;
}
