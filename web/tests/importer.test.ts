import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvValidationError, importTransactionsCsv } from "../src/lib/importer";
import { testPool } from "./setup";

const SAMPLE_CSV = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "transactions_sample.csv"),
  "utf8",
);
const SAMPLE_CSV_ROW_COUNT = 7;
const SAMPLE_CSV_UNIQUE_ASSETS = 4; // EUR_CASH, IWDA, US0378331005, BTC

let client: PoolClient;

beforeEach(async () => {
  client = await testPool.connect();
});

afterEach(() => {
  client.release();
});

async function count(table: "assets" | "transactions"): Promise<number> {
  const res = await client.query(`SELECT COUNT(*) FROM ${table}`);
  return Number(res.rows[0].count);
}

describe("importTransactionsCsv", () => {
  it("imports the sample CSV", async () => {
    const stats = await importTransactionsCsv(SAMPLE_CSV, client);
    expect(stats.rowsRead).toBe(SAMPLE_CSV_ROW_COUNT);
    expect(stats.inserted).toBe(SAMPLE_CSV_ROW_COUNT);
    expect(stats.skippedDuplicates).toBe(0);
    expect(stats.assetsCreated).toBe(SAMPLE_CSV_UNIQUE_ASSETS);

    expect(await count("transactions")).toBe(SAMPLE_CSV_ROW_COUNT);
    expect(await count("assets")).toBe(SAMPLE_CSV_UNIQUE_ASSETS);
  });

  it("is idempotent on re-import", async () => {
    await importTransactionsCsv(SAMPLE_CSV, client);
    const stats2 = await importTransactionsCsv(SAMPLE_CSV, client);
    expect(stats2.inserted).toBe(0);
    expect(stats2.skippedDuplicates).toBe(SAMPLE_CSV_ROW_COUNT);
    expect(stats2.assetsCreated).toBe(0);
    expect(await count("transactions")).toBe(SAMPLE_CSV_ROW_COUNT); // no duplicates
  });

  it("only creates one asset for a symbol that appears multiple times", async () => {
    await importTransactionsCsv(SAMPLE_CSV, client);
    const rows = await client.query("SELECT id FROM assets WHERE symbol = 'IWDA'");
    expect(rows.rows.length).toBe(1);
  });

  it("uses quantity=amount, price=1 for cash-flow rows", async () => {
    await importTransactionsCsv(SAMPLE_CSV, client);
    const row = await client.query("SELECT quantity, price FROM transactions WHERE type = 'deposit'");
    expect(row.rows[0].quantity).toBe(5000);
    expect(row.rows[0].price).toBe(1);
  });

  it("rejects an invalid asset_class and writes nothing", async () => {
    const bad =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      "2024-01-01,XXX,Test,not_a_class,buy,1,1,0,EUR,manual,\n";
    await expect(importTransactionsCsv(bad, client)).rejects.toThrow(CsvValidationError);
    expect(await count("transactions")).toBe(0);
  });

  it("rejects an invalid date", async () => {
    const bad =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      "15-01-2024,XXX,Test,stock,buy,1,1,0,EUR,manual,\n";
    await expect(importTransactionsCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("rejects a non-numeric quantity", async () => {
    const bad =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      "2024-01-01,XXX,Test,stock,buy,not_a_number,1,0,EUR,manual,\n";
    await expect(importTransactionsCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("rejects a CSV missing a required column", async () => {
    const bad = "date,asset_symbol\n2024-01-01,XXX\n";
    await expect(importTransactionsCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("rejects a brand-new asset with no asset_name", async () => {
    const bad =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      "2024-01-01,NEWSYM,,stock,buy,1,1,0,EUR,manual,\n";
    await expect(importTransactionsCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("does not partially commit when a later row is invalid", async () => {
    const mixed =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      "2024-01-01,GOOD,Good Asset,stock,buy,1,1,0,EUR,manual,\n" +
      "2024-01-02,BAD,Bad Asset,not_a_class,buy,1,1,0,EUR,manual,\n";
    await expect(importTransactionsCsv(mixed, client)).rejects.toThrow(CsvValidationError);
    expect(await count("assets")).toBe(0);
    expect(await count("transactions")).toBe(0);
  });

  it("handles a quoted asset_name containing a comma", async () => {
    const csv =
      "date,asset_symbol,asset_name,asset_class,type,quantity,price,fees,currency,source,notes\n" +
      '2024-01-01,QCOM,"Some Fund, Class A",etf,buy,1,10,0,EUR,manual,\n';
    const stats = await importTransactionsCsv(csv, client);
    expect(stats.inserted).toBe(1);
    const row = await client.query("SELECT name FROM assets WHERE symbol = 'QCOM'");
    expect(row.rows[0].name).toBe("Some Fund, Class A");
  });
});
