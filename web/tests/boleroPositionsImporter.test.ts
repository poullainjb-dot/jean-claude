import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importBoleroPositionsXlsx,
  parseBoleroPositionsWorkbook,
  SNAPSHOT_SOURCE,
} from "../src/lib/boleroPositionsImporter";
import { CsvValidationError } from "../src/lib/csv";
import { testPool } from "./setup";

// Mirrors the real export's structure: metadata rows, a header row, then
// position rows — with every real value in an even-numbered column and
// every odd column left blank (the artifact of the merged header cells in
// Bolero's own Excel export). Values are entirely synthetic.
const HEADER = [
  "Type",
  "Dev.",
  "Nombre",
  "Bloqué",
  "Nom",
  "Alertes",
  "Cours d'achat moyen",
  "Cours de clôture",
  "Valeur d'achat totale",
  "Cours",
  "Variation (%)",
  "Variation",
  "Valeur courante",
  "Valeur en EUR",
  "Rendement %",
  "Marché",
  "Rendement (devise orig.)",
  "ISIN",
];

interface FixtureRow {
  type: string;
  currency: string;
  quantity: number;
  name: string;
  avgPrice: number;
  isin: string;
}

function writeSpaced(row: ExcelJS.Row, values: unknown[]) {
  values.forEach((v, i) => {
    row.getCell(2 + i * 2).value = v as ExcelJS.CellValue;
  });
  row.commit();
}

async function buildWorkbook(
  rows: FixtureRow[],
  opts: { asOf?: Date; skipFooter?: boolean } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet0");

  writeSpaced(sheet.getRow(3), ["User-ID", "TEST0001"]);
  writeSpaced(sheet.getRow(4), ["Imprimé le", opts.asOf ?? new Date("2026-01-15T09:00:00Z")]);
  writeSpaced(sheet.getRow(6), ["Portfolio Positions"]);
  writeSpaced(sheet.getRow(9), HEADER);

  rows.forEach((r, i) => {
    writeSpaced(sheet.getRow(11 + i), [
      r.type,
      r.currency,
      r.quantity,
      0.0,
      r.name,
      "Non",
      r.avgPrice,
      r.avgPrice * 1.01,
      r.avgPrice * r.quantity,
      r.avgPrice * 1.02,
      1.0,
      2.0,
      r.avgPrice * r.quantity * 1.02,
      r.avgPrice * r.quantity * 1.02,
      5.0,
      "Euronext Paris",
      10.0,
      r.isin,
    ]);
  });

  if (!opts.skipFooter) {
    const footerRow = sheet.getRow(11 + rows.length + 2);
    writeSpaced(footerRow, ["Bolero est la plateforme « execution-only »..."]);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const SCHNEIDER: FixtureRow = {
  type: "Actions",
  currency: "EUR",
  quantity: 7,
  name: "SCHNEIDER ELECTRIC SE",
  avgPrice: 240.21571,
  isin: "FR0000121972",
};

const ALIBABA: FixtureRow = {
  type: "Actions",
  currency: "USD",
  quantity: 12,
  name: "ALIBABA GRP HOLD ADR",
  avgPrice: 135.2075,
  isin: "US01609W1027",
};

const AMUNDI_ETF: FixtureRow = {
  type: "ETF",
  currency: "EUR",
  quantity: 20,
  name: "AMUNDI JAPAN TOPIX ETF",
  avgPrice: 95.289,
  isin: "LU1681037609",
};

describe("parseBoleroPositionsWorkbook", () => {
  it("parses positions and the export date from a realistic workbook", async () => {
    const buf = await buildWorkbook([SCHNEIDER, ALIBABA, AMUNDI_ETF], {
      asOf: new Date("2026-08-15T13:16:35Z"),
    });
    const { rows, asOfDate } = await parseBoleroPositionsWorkbook(buf);

    expect(asOfDate).toBe("2026-08-15");
    expect(rows).toEqual([
      { isin: "FR0000121972", name: "SCHNEIDER ELECTRIC SE", assetClass: "stock", currency: "EUR", quantity: 7, avgPrice: 240.21571 },
      { isin: "US01609W1027", name: "ALIBABA GRP HOLD ADR", assetClass: "stock", currency: "USD", quantity: 12, avgPrice: 135.2075 },
      { isin: "LU1681037609", name: "AMUNDI JAPAN TOPIX ETF", assetClass: "etf", currency: "EUR", quantity: 20, avgPrice: 95.289 },
    ]);
  });

  it("stops at the footer row without requiring one", async () => {
    const buf = await buildWorkbook([SCHNEIDER], { skipFooter: true });
    const { rows } = await parseBoleroPositionsWorkbook(buf);
    expect(rows).toHaveLength(1);
  });

  it("rejects a row with an unsupported Type instead of silently dropping it", async () => {
    const buf = await buildWorkbook([SCHNEIDER, { ...ALIBABA, type: "Obligations" }]);
    await expect(parseBoleroPositionsWorkbook(buf)).rejects.toThrow(CsvValidationError);
    await expect(parseBoleroPositionsWorkbook(buf)).rejects.toThrow(/unsupported Type "Obligations"/);
  });

  it("treats a blank ISIN as the end of the table, not a row to import", async () => {
    // ISIN is the rightmost column and never blank on a genuine position in
    // the real export — a blank one is what actually distinguishes "table
    // ended" from "a row with some other field wrong" (see below).
    const buf = await buildWorkbook([SCHNEIDER, { ...ALIBABA, isin: "" }, AMUNDI_ETF]);
    const { rows } = await parseBoleroPositionsWorkbook(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].isin).toBe(SCHNEIDER.isin);
  });

  it("rejects a row with an invalid currency", async () => {
    const buf = await buildWorkbook([{ ...SCHNEIDER, currency: "EU" }]);
    await expect(parseBoleroPositionsWorkbook(buf)).rejects.toThrow(/invalid currency/);
  });

  it("rejects a workbook with no 'Imprimé le' date", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet0");
    writeSpaced(sheet.getRow(9), HEADER);
    writeSpaced(sheet.getRow(11), [
      SCHNEIDER.type,
      SCHNEIDER.currency,
      SCHNEIDER.quantity,
      0,
      SCHNEIDER.name,
      "Non",
      SCHNEIDER.avgPrice,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      "Euronext Paris",
      0,
      SCHNEIDER.isin,
    ]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseBoleroPositionsWorkbook(buf)).rejects.toThrow(/Imprimé le/);
  });

  it("rejects a workbook with no position rows at all", async () => {
    const buf = await buildWorkbook([]);
    await expect(parseBoleroPositionsWorkbook(buf)).rejects.toThrow(/No position rows/);
  });
});

describe("importBoleroPositionsXlsx", () => {
  let client: PoolClient;

  beforeEach(async () => {
    client = await testPool.connect();
  });

  afterEach(() => {
    client.release();
  });

  it("creates assets and one synthetic buy transaction per position", async () => {
    const buf = await buildWorkbook([SCHNEIDER, ALIBABA]);
    const stats = await importBoleroPositionsXlsx(buf, client);

    expect(stats).toEqual({ rowsRead: 2, assetsCreated: 2, inserted: 2, updated: 0, removed: 0 });

    const assets = await client.query("SELECT symbol, name, asset_class, currency FROM assets ORDER BY symbol");
    expect(assets.rows).toEqual([
      { symbol: "FR0000121972", name: "SCHNEIDER ELECTRIC SE", asset_class: "stock", currency: "EUR" },
      { symbol: "US01609W1027", name: "ALIBABA GRP HOLD ADR", asset_class: "stock", currency: "USD" },
    ]);

    const txns = await client.query(
      "SELECT source, type, quantity, price, fees, currency FROM transactions ORDER BY currency",
    );
    for (const t of txns.rows) {
      expect(t.source).toBe(SNAPSHOT_SOURCE);
      expect(t.type).toBe("buy");
      expect(Number(t.fees)).toBe(0);
    }
    expect(Number(txns.rows[0].quantity)).toBe(7); // EUR row = Schneider
    expect(Number(txns.rows[0].price)).toBeCloseTo(240.21571, 5);
  });

  it("re-importing the same snapshot updates in place — no duplicate transactions", async () => {
    const buf = await buildWorkbook([SCHNEIDER]);
    await importBoleroPositionsXlsx(buf, client);

    const buf2 = await buildWorkbook([{ ...SCHNEIDER, quantity: 9, avgPrice: 250 }], {
      asOf: new Date("2026-02-01T09:00:00Z"),
    });
    const stats2 = await importBoleroPositionsXlsx(buf2, client);

    expect(stats2).toEqual({ rowsRead: 1, assetsCreated: 0, inserted: 0, updated: 1, removed: 0 });

    const txns = await client.query("SELECT quantity, price, date FROM transactions");
    expect(txns.rows).toHaveLength(1);
    expect(Number(txns.rows[0].quantity)).toBe(9);
    expect(Number(txns.rows[0].price)).toBe(250);
  });

  it("removes a snapshot transaction for a position no longer in the new export", async () => {
    const buf = await buildWorkbook([SCHNEIDER, ALIBABA]);
    await importBoleroPositionsXlsx(buf, client);

    const buf2 = await buildWorkbook([SCHNEIDER]); // Alibaba sold off entirely
    const stats2 = await importBoleroPositionsXlsx(buf2, client);

    expect(stats2.removed).toBe(1);
    const txns = await client.query("SELECT a.symbol FROM transactions t JOIN assets a ON a.id = t.asset_id");
    expect(txns.rows).toEqual([{ symbol: "FR0000121972" }]);
    // The asset itself isn't deleted, just its snapshot transaction — avoids
    // cascading complexity and keeps price history intact if it's re-added later.
    const assets = await client.query("SELECT symbol FROM assets ORDER BY symbol");
    expect(assets.rows).toEqual([{ symbol: "FR0000121972" }, { symbol: "US01609W1027" }]);
  });

  it("doesn't touch a manually-imported transaction for the same asset", async () => {
    await client.query("BEGIN");
    const asset = await client.query(
      "INSERT INTO assets (symbol, name, asset_class, currency) VALUES ($1, $2, $3, $4) RETURNING id",
      [SCHNEIDER.isin, SCHNEIDER.name, "stock", "EUR"],
    );
    await client.query(
      `INSERT INTO transactions (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency)
       VALUES ('manual-1', '2020-01-01', $1, 'stock', 'manual', 'buy', 3, 200, 5, 'EUR')`,
      [asset.rows[0].id],
    );
    await client.query("COMMIT");

    const buf = await buildWorkbook([SCHNEIDER]);
    await importBoleroPositionsXlsx(buf, client);

    const txns = await client.query("SELECT source FROM transactions ORDER BY source");
    expect(txns.rows.map((r) => r.source)).toEqual(["bolero-snapshot", "manual"]);
  });

  it("is all-or-nothing: a bad row leaves the DB untouched", async () => {
    const buf = await buildWorkbook([SCHNEIDER, { ...ALIBABA, currency: "US" }]);
    await expect(importBoleroPositionsXlsx(buf, client)).rejects.toThrow(CsvValidationError);

    const assets = await client.query("SELECT COUNT(*) FROM assets");
    expect(Number(assets.rows[0].count)).toBe(0);
  });
});
