import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CsvValidationError } from "../src/lib/csv";
import { importTransactionsCsv } from "../src/lib/importer";
import { importPricesCsv } from "../src/lib/priceImporter";
import { testPool } from "./setup";

const SAMPLE_TXNS = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "transactions_sample.csv"),
  "utf8",
);
const SAMPLE_PRICES = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "prices_sample.csv"),
  "utf8",
);

let client: PoolClient;

beforeEach(async () => {
  client = await testPool.connect();
  await importTransactionsCsv(SAMPLE_TXNS, client); // prices need existing assets
});

afterEach(() => {
  client.release();
});

async function priceCount(): Promise<number> {
  const res = await client.query("SELECT COUNT(*) FROM prices");
  return Number(res.rows[0].count);
}

describe("importPricesCsv", () => {
  it("imports the sample prices", async () => {
    const stats = await importPricesCsv(SAMPLE_PRICES, client);
    expect(stats.rowsRead).toBe(3);
    expect(stats.inserted).toBe(3);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(await priceCount()).toBe(3);
  });

  it("is a no-op re-importing identical prices", async () => {
    await importPricesCsv(SAMPLE_PRICES, client);
    const stats2 = await importPricesCsv(SAMPLE_PRICES, client);
    expect(stats2.inserted).toBe(0);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(3);
  });

  it("updates a price that changed", async () => {
    await importPricesCsv(SAMPLE_PRICES, client);
    const corrected = "date,asset_symbol,price,source\n2024-06-15,IWDA,99.00,manual\n";
    const stats = await importPricesCsv(corrected, client);
    expect(stats.updated).toBe(1);

    const row = await client.query(
      "SELECT p.price FROM prices p JOIN assets a ON a.id = p.asset_id WHERE a.symbol = 'IWDA'",
    );
    expect(Number(row.rows[0].price)).toBe(99.0);
  });

  it("rejects an unknown asset and writes nothing", async () => {
    const bad = "date,asset_symbol,price,source\n2024-06-15,DOES_NOT_EXIST,10,manual\n";
    await expect(importPricesCsv(bad, client)).rejects.toThrow(CsvValidationError);
    expect(await priceCount()).toBe(0);
  });

  it("rejects an invalid date", async () => {
    const bad = "date,asset_symbol,price,source\n15-06-2024,IWDA,10,manual\n";
    await expect(importPricesCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("rejects a CSV missing a required column", async () => {
    const bad = "date,asset_symbol\n2024-06-15,IWDA\n";
    await expect(importPricesCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });
});
