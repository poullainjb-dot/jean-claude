import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importTransactionsCsv } from "../src/lib/importer";
import { CsvValidationError } from "../src/lib/csv";
import { importPriceSymbolsCsv } from "../src/lib/priceSymbolImporter";
import { testPool } from "./setup";

const SAMPLE_TXNS = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "transactions_sample.csv"),
  "utf8",
);
const SAMPLE_OVERRIDES = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "price_symbols_sample.csv"),
  "utf8",
);

let client: PoolClient;

beforeEach(async () => {
  client = await testPool.connect();
  await importTransactionsCsv(SAMPLE_TXNS, client); // overrides need existing assets
});

afterEach(() => {
  client.release();
});

async function priceSymbolFor(symbol: string): Promise<string | null> {
  const res = await client.query<{ price_symbol: string | null }>(
    "SELECT price_symbol FROM assets WHERE symbol = $1",
    [symbol],
  );
  return res.rows[0].price_symbol;
}

describe("importPriceSymbolsCsv", () => {
  it("sets overrides from the sample CSV", async () => {
    const stats = await importPriceSymbolsCsv(SAMPLE_OVERRIDES, client);
    expect(stats.rowsRead).toBe(2);
    expect(stats.updated).toBe(2);
    expect(stats.unchanged).toBe(0);
    expect(stats.cleared).toBe(0);

    expect(await priceSymbolFor("IWDA")).toBe("IWDA.AS");
    expect(await priceSymbolFor("US0378331005")).toBe("AAPL");
  });

  it("is a no-op re-importing identical overrides", async () => {
    await importPriceSymbolsCsv(SAMPLE_OVERRIDES, client);
    const stats2 = await importPriceSymbolsCsv(SAMPLE_OVERRIDES, client);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(2);
    expect(stats2.cleared).toBe(0);
  });

  it("updates an existing override to a new value", async () => {
    await importPriceSymbolsCsv(SAMPLE_OVERRIDES, client);
    const corrected = "asset_symbol,price_symbol\nIWDA,IWDA.L\n";
    const stats = await importPriceSymbolsCsv(corrected, client);
    expect(stats.updated).toBe(1);
    expect(await priceSymbolFor("IWDA")).toBe("IWDA.L");
  });

  it("clears an override when price_symbol is blank", async () => {
    await importPriceSymbolsCsv(SAMPLE_OVERRIDES, client);
    const clear = "asset_symbol,price_symbol\nIWDA,\n";
    const stats = await importPriceSymbolsCsv(clear, client);
    expect(stats.cleared).toBe(1);
    expect(await priceSymbolFor("IWDA")).toBeNull();
  });

  it("blank price_symbol on an asset with no existing override is unchanged, not cleared", async () => {
    const clear = "asset_symbol,price_symbol\nIWDA,\n";
    const stats = await importPriceSymbolsCsv(clear, client);
    expect(stats.unchanged).toBe(1);
    expect(stats.cleared).toBe(0);
  });

  it("rejects an unknown asset_symbol and writes nothing", async () => {
    const bad = "asset_symbol,price_symbol\nDOES_NOT_EXIST,FOO\n";
    await expect(importPriceSymbolsCsv(bad, client)).rejects.toThrow(CsvValidationError);
    expect(await priceSymbolFor("IWDA")).toBeNull(); // untouched
  });

  it("rejects a CSV missing a required column", async () => {
    const bad = "asset_symbol\nIWDA\n";
    await expect(importPriceSymbolsCsv(bad, client)).rejects.toThrow(CsvValidationError);
  });

  it("does not partially commit when one row is invalid", async () => {
    const mixed = "asset_symbol,price_symbol\nIWDA,IWDA.AS\nDOES_NOT_EXIST,FOO\n";
    await expect(importPriceSymbolsCsv(mixed, client)).rejects.toThrow(CsvValidationError);
    expect(await priceSymbolFor("IWDA")).toBeNull(); // the valid row didn't sneak through
  });
});
