import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PriceProvider, refreshLivePrices } from "../src/lib/priceRefresh";
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

function provider(name: string, impl: PriceProvider["fetcher"], minSpacingMs = 0): PriceProvider {
  return { name, fetcher: vi.fn(impl), minSpacingMs };
}

const okAt = (date: string, close: number) => [{ date, close }];
const empty = async () => [];

describe("refreshLivePrices", () => {
  it("only checks stock/etf assets, skipping cash/gold/crypto", async () => {
    await createAsset("IWDA", "etf");
    await createAsset("EUR_CASH", "cash");
    await createAsset("XAU", "gold");
    await createAsset("BTC", "crypto");

    const p1 = provider("only", async () => okAt("2024-06-01", 100));
    const stats = await refreshLivePrices(client, [p1]);

    expect(stats.assetsChecked).toBe(1);
    expect(p1.fetcher).toHaveBeenCalledTimes(1);
    expect(p1.fetcher).toHaveBeenCalledWith("IWDA", expect.any(Date), expect.any(Date));
  });

  it("uses price_symbol as the lookup when set, falls back to symbol otherwise", async () => {
    await createAsset("IWDA", "etf", "IWDA.AS");
    await createAsset("AAPL", "stock");

    const p1 = provider("only", async () => okAt("2024-06-01", 50));
    const stats = await refreshLivePrices(client, [p1]);

    const lookups = stats.results.map((r) => r.lookupSymbol).sort();
    expect(lookups).toEqual(["AAPL", "IWDA.AS"]);
  });

  it("does not call the second provider when the first succeeds", async () => {
    await createAsset("AAPL", "stock");

    const first = provider("first", async () => okAt("2024-06-01", 190));
    const second = provider("second", async () => okAt("2024-06-01", 999));

    const stats = await refreshLivePrices(client, [first, second]);

    expect(first.fetcher).toHaveBeenCalledTimes(1);
    expect(second.fetcher).not.toHaveBeenCalled();
    expect(stats.results[0].provider).toBe("first");
  });

  it("falls back to the second provider when the first returns no data", async () => {
    await createAsset("IWDA", "etf");

    const first = provider("twelvedata", empty);
    const second = provider("yahoo", async () => okAt("2024-06-01", 95));

    const stats = await refreshLivePrices(client, [first, second]);

    expect(first.fetcher).toHaveBeenCalledTimes(1);
    expect(second.fetcher).toHaveBeenCalledTimes(1);
    expect(stats.results[0].status).toBe("ok");
    expect(stats.results[0].provider).toBe("yahoo");
  });

  it("falls back to the second provider when the first throws", async () => {
    await createAsset("IWDA", "etf");

    const first = provider("twelvedata", async () => {
      throw new Error("Grow/Venture plan required");
    });
    const second = provider("yahoo", async () => okAt("2024-06-01", 95));

    const stats = await refreshLivePrices(client, [first, second]);

    expect(stats.results[0].status).toBe("ok");
    expect(stats.results[0].provider).toBe("yahoo");
  });

  it("reports a combined error from every provider when all fail, without affecting other assets", async () => {
    await createAsset("BADTICKER", "stock");
    await createAsset("AAPL", "stock");

    const first = provider("twelvedata", async (symbol: string) => {
      if (symbol === "BADTICKER") throw new Error("symbol not found");
      return okAt("2024-06-01", 190);
    });
    const second = provider("yahoo", async (symbol: string) => {
      if (symbol === "BADTICKER") return [];
      return okAt("2024-06-01", 190);
    });

    const stats = await refreshLivePrices(client, [first, second]);
    expect(stats.assetsChecked).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);

    const bad = stats.results.find((r) => r.symbol === "BADTICKER");
    const good = stats.results.find((r) => r.symbol === "AAPL");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toBe("twelvedata: symbol not found; yahoo: no data");
    expect(good?.status).toBe("ok");
    expect(good?.provider).toBe("twelvedata");
  });

  it("inserts new prices, then reports unchanged on an identical re-run, then updated when the value changes", async () => {
    const assetId = await createAsset("AAPL", "stock");
    const p1 = () =>
      provider("twelvedata", async () => [
        { date: "2024-06-01", close: 190 },
        { date: "2024-06-02", close: 191 },
      ]);

    const stats1 = await refreshLivePrices(client, [p1()]);
    expect(stats1.inserted).toBe(2);
    expect(await pricesFor(assetId)).toEqual([
      { date: "2024-06-01", price: 190, source: "twelvedata" },
      { date: "2024-06-02", price: 191, source: "twelvedata" },
    ]);

    const stats2 = await refreshLivePrices(client, [p1()]);
    expect(stats2.inserted).toBe(0);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(2);

    const changed = provider("twelvedata", async () => [
      { date: "2024-06-01", close: 190 },
      { date: "2024-06-02", close: 199 },
    ]);
    const stats3 = await refreshLivePrices(client, [changed]);
    expect(stats3.updated).toBe(1);
    expect(stats3.unchanged).toBe(1);
  });

  it("does nothing and reports zero assets checked when there are no stock/etf assets", async () => {
    await createAsset("EUR_CASH", "cash");
    const p1 = provider("only", empty);
    const stats = await refreshLivePrices(client, [p1]);
    expect(stats.assetsChecked).toBe(0);
    expect(p1.fetcher).not.toHaveBeenCalled();
  });

  it("paces consecutive calls to the same provider, but a fallback to a different provider isn't delayed by it", async () => {
    await createAsset("AAPL", "stock");
    await createAsset("MSFT", "stock");

    const timestamps: Record<string, number[]> = { first: [], second: [] };
    const first = provider(
      "first",
      async (symbol: string) => {
        timestamps.first.push(Date.now());
        return symbol === "AAPL" ? [] : okAt("2024-06-01", 100); // AAPL misses on "first", falls back
      },
      60, // measurable spacing
    );
    const second = provider(
      "second",
      async () => {
        timestamps.second.push(Date.now());
        return okAt("2024-06-01", 200);
      },
      0, // no spacing required for this provider
    );

    await refreshLivePrices(client, [first, second]);

    // AAPL's fallback call to "second" shouldn't wait on "first"'s spacing —
    // it should happen right after AAPL's "first" call, not 60ms later.
    expect(timestamps.second[0] - timestamps.first[0]).toBeLessThan(60);

    // MSFT's call to "first" is the second-ever call to that provider, so
    // it should respect the 60ms spacing from AAPL's earlier "first" call.
    expect(timestamps.first[1] - timestamps.first[0]).toBeGreaterThanOrEqual(55);
  });
});
