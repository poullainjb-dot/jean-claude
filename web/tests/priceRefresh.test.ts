import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshLivePrices } from "../src/lib/priceRefresh";
import { testPool } from "./setup";

let client: PoolClient;

beforeEach(async () => {
  client = await testPool.connect();
});

afterEach(() => {
  client.release();
});

async function createAsset(
  symbol: string,
  assetClass: string,
  priceSymbol: string | null = null,
): Promise<number> {
  const res = await client.query<{ id: number }>(
    "INSERT INTO assets (symbol, name, asset_class, currency, price_symbol) VALUES ($1, $1, $2, 'EUR', $3) RETURNING id",
    [symbol, assetClass, priceSymbol],
  );
  return res.rows[0].id;
}

async function pricesFor(assetId: number) {
  const res = await client.query<{ date: string; price: number; source: string }>(
    "SELECT date, price, source FROM prices WHERE asset_id = $1 ORDER BY date",
    [assetId],
  );
  return res.rows;
}

// delayMs: 0 throughout — these tests exercise the rate-limit pacing logic
// separately (see "paces requests..." below); everywhere else, waiting the
// real ~8s/asset would make the suite unusably slow for no benefit.

describe("refreshLivePrices", () => {
  it("only checks stock/etf assets, skipping cash/gold/crypto", async () => {
    await createAsset("IWDA", "etf");
    await createAsset("EUR_CASH", "cash");
    await createAsset("XAU", "gold");
    await createAsset("BTC", "crypto");

    const fetcher = vi.fn().mockResolvedValue([{ date: "2024-06-01", close: 100 }]);
    const stats = await refreshLivePrices(client, fetcher, 0);

    expect(stats.assetsChecked).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("IWDA", expect.any(Date), expect.any(Date));
  });

  it("uses price_symbol as the lookup when set, falls back to symbol otherwise", async () => {
    await createAsset("IWDA", "etf", "IWDA.AS");
    await createAsset("AAPL", "stock"); // no override

    const fetcher = vi.fn().mockResolvedValue([{ date: "2024-06-01", close: 50 }]);
    const stats = await refreshLivePrices(client, fetcher, 0);

    const lookups = stats.results.map((r) => r.lookupSymbol).sort();
    expect(lookups).toEqual(["AAPL", "IWDA.AS"]);
  });

  it("inserts new prices, then reports unchanged on an identical re-run, then updated when the value changes", async () => {
    const assetId = await createAsset("AAPL", "stock");

    const firstFetch = vi.fn().mockResolvedValue([
      { date: "2024-06-01", close: 190 },
      { date: "2024-06-02", close: 191 },
    ]);
    const stats1 = await refreshLivePrices(client, firstFetch, 0);
    expect(stats1.inserted).toBe(2);
    expect(stats1.updated).toBe(0);
    expect(stats1.unchanged).toBe(0);
    expect(await pricesFor(assetId)).toEqual([
      { date: "2024-06-01", price: 190, source: "twelvedata" },
      { date: "2024-06-02", price: 191, source: "twelvedata" },
    ]);

    // identical re-run
    const sameFetch = vi.fn().mockResolvedValue([
      { date: "2024-06-01", close: 190 },
      { date: "2024-06-02", close: 191 },
    ]);
    const stats2 = await refreshLivePrices(client, sameFetch, 0);
    expect(stats2.inserted).toBe(0);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(2);

    // one value changed (e.g. corrected close)
    const changedFetch = vi.fn().mockResolvedValue([
      { date: "2024-06-01", close: 190 },
      { date: "2024-06-02", close: 199 }, // changed
    ]);
    const stats3 = await refreshLivePrices(client, changedFetch, 0);
    expect(stats3.inserted).toBe(0);
    expect(stats3.updated).toBe(1);
    expect(stats3.unchanged).toBe(1);
  });

  it("reports no_data for a symbol with an empty result, without affecting other assets", async () => {
    await createAsset("BADTICKER", "stock");
    await createAsset("AAPL", "stock");

    const fetcher = vi.fn().mockImplementation(async (symbol: string) => {
      if (symbol === "BADTICKER") return [];
      return [{ date: "2024-06-01", close: 190 }];
    });

    const stats = await refreshLivePrices(client, fetcher, 0);
    expect(stats.assetsChecked).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);

    const bad = stats.results.find((r) => r.symbol === "BADTICKER");
    const good = stats.results.find((r) => r.symbol === "AAPL");
    expect(bad?.status).toBe("no_data");
    expect(good?.status).toBe("ok");
    expect(good?.inserted).toBe(1);
  });

  it("catches a fetcher error for one asset without aborting the batch", async () => {
    await createAsset("BROKEN", "stock");
    await createAsset("AAPL", "stock");

    const fetcher = vi.fn().mockImplementation(async (symbol: string) => {
      if (symbol === "BROKEN") throw new Error("network timeout");
      return [{ date: "2024-06-01", close: 190 }];
    });

    const stats = await refreshLivePrices(client, fetcher, 0);
    expect(stats.assetsChecked).toBe(2);

    const broken = stats.results.find((r) => r.symbol === "BROKEN");
    const good = stats.results.find((r) => r.symbol === "AAPL");
    expect(broken?.status).toBe("error");
    expect(broken?.error).toBe("network timeout");
    expect(good?.status).toBe("ok"); // the other asset still succeeded
  });

  it("does nothing and reports zero assets checked when there are no stock/etf assets", async () => {
    await createAsset("EUR_CASH", "cash");
    const fetcher = vi.fn();
    const stats = await refreshLivePrices(client, fetcher, 0);
    expect(stats.assetsChecked).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("paces requests to respect the rate limit: no delay before the first request, delayMs between the rest", async () => {
    await createAsset("AAPL", "stock");
    await createAsset("MSFT", "stock");
    await createAsset("GOOG", "stock");

    const timestamps: number[] = [];
    const fetcher = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return [{ date: "2024-06-01", close: 100 }];
    });

    const start = Date.now();
    await refreshLivePrices(client, fetcher, 50); // small but measurable delay
    expect(fetcher).toHaveBeenCalledTimes(3);

    // first request shouldn't wait on the initial delay
    expect(timestamps[0] - start).toBeLessThan(50);
    // second and third should each be spaced by roughly delayMs
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(45);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(45);
  });
});
