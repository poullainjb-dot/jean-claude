import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeHoldings } from "../src/lib/holdings";
import { importTransactionsCsv } from "../src/lib/importer";
import { testPool } from "./setup";

const SAMPLE_TXNS = fs.readFileSync(
  path.join(__dirname, "..", "..", "sample_data", "transactions_sample.csv"),
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

async function quantities(): Promise<Record<string, number>> {
  const holdings = await computeHoldings(client);
  return Object.fromEntries(holdings.map((h) => [h.symbol, h.quantity]));
}

describe("computeHoldings", () => {
  it("nets buy/sell correctly", async () => {
    const qty = await quantities();
    // IWDA: buy 20 + buy 10 - sell 5 = 25
    expect(qty.IWDA).toBeCloseTo(25);
  });

  it("counts cash deposits", async () => {
    const qty = await quantities();
    expect(qty.EUR_CASH).toBeCloseTo(5000);
  });

  it("does not let a dividend change share count", async () => {
    const qty = await quantities();
    // AAPL: buy 5 only — the dividend row must NOT add to share count
    expect(qty.US0378331005).toBeCloseTo(5);
  });

  it("counts a crypto buy", async () => {
    const qty = await quantities();
    expect(qty.BTC).toBeCloseTo(0.05);
  });

  it("omits a closed position by default, but includes it with includeZero", async () => {
    const assetRes = await client.query<{ id: number }>(
      "INSERT INTO assets (symbol, name, asset_class, currency) VALUES ('ZERO', 'Zero Co', 'stock', 'EUR') RETURNING id",
    );
    const assetId = assetRes.rows[0].id;
    await client.query(
      `INSERT INTO transactions (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency)
       VALUES ('t1', '2024-01-01', $1, 'stock', 'manual', 'buy', 10, 5, 0, 'EUR')`,
      [assetId],
    );
    await client.query(
      `INSERT INTO transactions (id, date, asset_id, asset_class, source, type, quantity, price, fees, currency)
       VALUES ('t2', '2024-01-02', $1, 'stock', 'manual', 'sell', 10, 6, 0, 'EUR')`,
      [assetId],
    );

    const qty = await quantities();
    expect(qty.ZERO).toBeUndefined();

    const all = await computeHoldings(client, { includeZero: true });
    const zeroRow = all.find((h) => h.symbol === "ZERO");
    expect(zeroRow?.quantity).toBeCloseTo(0);
  });
});
