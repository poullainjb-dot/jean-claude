import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importTransactionsCsv } from "../src/lib/importer";
import { importPricesCsv } from "../src/lib/priceImporter";
import { computePositions, type Position, totalsByCurrency } from "../src/lib/valuation";
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
  await importTransactionsCsv(SAMPLE_TXNS, client);
});

afterEach(() => {
  client.release();
});

async function positionsBySymbol(): Promise<Record<string, Position>> {
  const positions = await computePositions(client);
  return Object.fromEntries(positions.map((p) => [p.symbol, p]));
}

describe("computePositions", () => {
  it("values cash at par with zero profit", async () => {
    const positions = await positionsBySymbol();
    const cash = positions.EUR_CASH;
    expect(cash.price).toBe(1);
    expect(cash.value).toBeCloseTo(5000);
    expect(cash.netContributions).toBeCloseTo(5000);
    expect(cash.profit).toBeCloseTo(0);
  });

  it("leaves value/profit null when there's no price yet", async () => {
    const positions = await positionsBySymbol();
    const iwda = positions.IWDA;
    expect(iwda.price).toBeNull();
    expect(iwda.value).toBeNull();
    expect(iwda.profit).toBeNull();
    // net contributions is still computable without a price
    expect(iwda.netContributions).toBeCloseTo(1707.9 + 882.5 - 473.5);
  });

  it("computes value and profit after prices are imported", async () => {
    await importPricesCsv(SAMPLE_PRICES, client);
    const positions = await positionsBySymbol();

    const iwda = positions.IWDA;
    expect(iwda.value).toBeCloseTo(25 * 96.5);
    expect(iwda.netContributions).toBeCloseTo(2116.9);
    expect(iwda.profit).toBeCloseTo(2412.5 - 2116.9);

    const aapl = positions.US0378331005;
    expect(aapl.value).toBeCloseTo(5 * 195.0);
    expect(aapl.netContributions).toBeCloseTo(903.25);
    expect(aapl.profit).toBeCloseTo(975.0 - 903.25);

    const btc = positions.BTC;
    expect(btc.value).toBeCloseTo(0.05 * 45000);
    expect(btc.netContributions).toBeCloseTo(2105);
    expect(btc.profit).toBeCloseTo(2250 - 2105);
  });

  it("excludes positions with missing prices from currency totals", async () => {
    await importPricesCsv(SAMPLE_PRICES, client); // covers IWDA (EUR), AAPL (USD), BTC (EUR)
    const positions = await computePositions(client);
    const totals = totalsByCurrency(positions);

    expect(Object.keys(totals).sort()).toEqual(["EUR", "USD"]);
    // EUR = EUR_CASH (5000) + IWDA (2412.50) + BTC (2250)
    expect(totals.EUR.value).toBeCloseTo(5000 + 2412.5 + 2250);
    expect(totals.EUR.missingPrice).toEqual([]);
    expect(totals.USD.value).toBeCloseTo(975.0);
  });

  it("flags missing prices without understating the total", async () => {
    // no prices imported — only cash has a value
    const positions = await computePositions(client);
    const totals = totalsByCurrency(positions);

    expect(totals.EUR.value).toBeCloseTo(5000); // cash only
    expect([...totals.EUR.missingPrice].sort()).toEqual(["BTC", "IWDA"]);
    expect(totals.USD.missingPrice).toEqual(["US0378331005"]);
  });
});
