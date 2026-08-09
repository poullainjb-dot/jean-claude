/**
 * Live price refresh for stocks/ETFs — the yfinance-equivalent connector
 * from the roadmap (R5). Fetches recent daily closes from Twelve Data and
 * upserts them into `prices`, same table the manual CSV importer writes to
 * (source differs: 'twelvedata' here vs whatever the CSV said). Manual CSV
 * import remains the fallback per the spec's design rule — this doesn't
 * replace it, it just means you don't have to use it for stocks/ETFs
 * day-to-day anymore.
 *
 * Scope: only asset_class IN ('stock', 'etf'). Crypto and gold get their
 * own connectors later (CoinGecko, a spot-price API) per the roadmap.
 *
 * Deliberately NOT all-or-nothing, unlike the CSV importers: one asset with
 * a bad symbol shouldn't block every other asset's prices from updating.
 * Each asset is fetched and written independently; failures are collected
 * per-asset in the result instead of aborting the batch.
 *
 * Rate limiting: Twelve Data's free tier allows 8 requests/minute. One
 * asset = one request, so a refresh covering many assets has to pace
 * itself rather than fire everything at once — REQUEST_SPACING_MS below
 * keeps it under that cap with some margin (7.5/min effective rate), which
 * means a 20-asset refresh takes a couple of minutes. `delayMs` is
 * injectable so tests don't actually wait — see priceRefresh.test.ts.
 */

import type { PoolClient } from "pg";
import { fetchDailyCloses } from "./twelveDataPrices";
import type { RefreshAssetResult, RefreshStats } from "./types";

const SOURCE = "twelvedata";
const LOOKBACK_DAYS = 10; // covers weekends/holidays so at least one trading day is always included
const REQUEST_SPACING_MS = 8_000; // ~7.5 requests/min, under Twelve Data's free-tier 8/min cap

export type PriceFetcher = (
  symbol: string,
  period1: Date,
  period2: Date,
) => Promise<{ date: string; close: number }[]>;

interface AssetRow {
  id: number;
  symbol: string;
  price_symbol: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertPrice(
  client: PoolClient,
  assetId: number,
  date: string,
  price: number,
): Promise<"inserted" | "updated" | "unchanged"> {
  const existing = await client.query<{ price: number }>(
    "SELECT price FROM prices WHERE asset_id = $1 AND date = $2",
    [assetId, date],
  );

  if (existing.rows.length === 0) {
    await client.query("INSERT INTO prices (asset_id, date, price, source) VALUES ($1, $2, $3, $4)", [
      assetId,
      date,
      price,
      SOURCE,
    ]);
    return "inserted";
  }

  if (Math.abs(Number(existing.rows[0].price) - price) > 1e-9) {
    await client.query("UPDATE prices SET price = $1, source = $2 WHERE asset_id = $3 AND date = $4", [
      price,
      SOURCE,
      assetId,
      date,
    ]);
    return "updated";
  }

  return "unchanged";
}

export async function refreshLivePrices(
  client: PoolClient,
  fetcher: PriceFetcher = fetchDailyCloses,
  delayMs: number = REQUEST_SPACING_MS,
): Promise<RefreshStats> {
  const assetsRes = await client.query<AssetRow>(
    "SELECT id, symbol, price_symbol FROM assets WHERE asset_class IN ('stock', 'etf') ORDER BY symbol",
  );

  const period2 = new Date();
  const period1 = new Date(period2);
  period1.setDate(period1.getDate() - LOOKBACK_DAYS);

  const results: RefreshAssetResult[] = [];

  for (let i = 0; i < assetsRes.rows.length; i++) {
    const asset = assetsRes.rows[i];
    const lookupSymbol = asset.price_symbol ?? asset.symbol;

    if (i > 0) {
      await sleep(delayMs);
    }

    let closes: { date: string; close: number }[];
    try {
      closes = await fetcher(lookupSymbol, period1, period2);
    } catch (err) {
      results.push({
        symbol: asset.symbol,
        lookupSymbol,
        status: "error",
        inserted: 0,
        updated: 0,
        unchanged: 0,
        error: (err as Error).message,
      });
      continue;
    }

    if (closes.length === 0) {
      results.push({
        symbol: asset.symbol,
        lookupSymbol,
        status: "no_data",
        inserted: 0,
        updated: 0,
        unchanged: 0,
      });
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const { date, close } of closes) {
      const outcome = await upsertPrice(client, asset.id, date, close);
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "updated") updated += 1;
      else unchanged += 1;
    }

    results.push({ symbol: asset.symbol, lookupSymbol, status: "ok", inserted, updated, unchanged });
  }

  return {
    assetsChecked: results.length,
    succeeded: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status !== "ok").length,
    inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    updated: results.reduce((sum, r) => sum + r.updated, 0),
    unchanged: results.reduce((sum, r) => sum + r.unchanged, 0),
    results,
  };
}
