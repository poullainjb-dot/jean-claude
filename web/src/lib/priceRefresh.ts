/**
 * Live price refresh for stocks/ETFs — the yfinance-equivalent connector
 * from the roadmap (R5). Fetches recent daily closes and upserts them into
 * `prices`, same table the manual CSV importer writes to. Manual CSV import
 * remains the fallback per the spec's design rule — this doesn't replace
 * it, it means you don't have to use it for stocks/ETFs day-to-day.
 *
 * Two providers, tried in order per asset:
 *   1. Twelve Data — official, documented, needs an API key. Reliable for
 *      US tickers; its free tier paywalls most non-US exchanges (confirmed
 *      live: its own error names the Grow/Venture plan for a European ETF).
 *   2. Yahoo Finance — unofficial, no key needed, broad exchange coverage
 *      including Europe/international. Falls back to this specifically for
 *      what Twelve Data's free tier can't reach.
 * The asset's `price_symbol` override (see priceSymbolImporter.ts) is used
 * for both providers — exchange-suffix conventions (e.g. '.AS') are shared
 * across most data providers, so one override usually works for both.
 *
 * Scope: only asset_class IN ('stock', 'etf'). Crypto and gold get their
 * own connectors later per the roadmap.
 *
 * Deliberately NOT all-or-nothing, unlike the CSV importers: one asset with
 * a bad symbol shouldn't block every other asset's prices from updating.
 *
 * Rate limiting: paced per-provider, not globally — Twelve Data's free
 * tier is 8 requests/minute, Yahoo has no published limit but still gets a
 * conservative spacing to avoid hammering it. Pacing consecutive calls to
 * the *same* provider (not consecutive calls overall) means an asset that
 * fails over to Yahoo doesn't also inherit Twelve Data's slower pace for
 * that second call — important given most assets here are expected to need
 * the fallback.
 */

import type { PoolClient } from "pg";
import { fetchDailyCloses as fetchTwelveData } from "./twelveDataPrices";
import type { RefreshAssetResult, RefreshStats } from "./types";
import { fetchDailyCloses as fetchYahoo } from "./yahooPrices";

const LOOKBACK_DAYS = 10; // covers weekends/holidays so at least one trading day is always included

export type PriceFetcher = (
  symbol: string,
  period1: Date,
  period2: Date,
) => Promise<{ date: string; close: number }[]>;

export interface PriceProvider {
  name: string;
  fetcher: PriceFetcher;
  minSpacingMs: number;
}

export const DEFAULT_PROVIDERS: PriceProvider[] = [
  { name: "twelvedata", fetcher: fetchTwelveData, minSpacingMs: 8_000 }, // free tier: 8/min
  { name: "yahoo", fetcher: fetchYahoo, minSpacingMs: 1_000 }, // no published limit; still paced, conservatively
];

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
  source: string,
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
      source,
    ]);
    return "inserted";
  }

  if (Math.abs(Number(existing.rows[0].price) - price) > 1e-9) {
    await client.query("UPDATE prices SET price = $1, source = $2 WHERE asset_id = $3 AND date = $4", [
      price,
      source,
      assetId,
      date,
    ]);
    return "updated";
  }

  return "unchanged";
}

export async function refreshLivePrices(
  client: PoolClient,
  providers: PriceProvider[] = DEFAULT_PROVIDERS,
): Promise<RefreshStats> {
  const assetsRes = await client.query<AssetRow>(
    "SELECT id, symbol, price_symbol FROM assets WHERE asset_class IN ('stock', 'etf') ORDER BY symbol",
  );

  const period2 = new Date();
  const period1 = new Date(period2);
  period1.setDate(period1.getDate() - LOOKBACK_DAYS);

  const results: RefreshAssetResult[] = [];
  const lastCallAt = new Map<string, number>(); // provider name -> timestamp of its last call, across all assets

  for (const asset of assetsRes.rows) {
    const lookupSymbol = asset.price_symbol ?? asset.symbol;
    const providerMessages: string[] = [];
    let succeeded: { provider: string; closes: { date: string; close: number }[] } | null = null;

    for (const provider of providers) {
      const last = lastCallAt.get(provider.name);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < provider.minSpacingMs) {
          await sleep(provider.minSpacingMs - elapsed);
        }
      }
      lastCallAt.set(provider.name, Date.now());

      try {
        const closes = await provider.fetcher(lookupSymbol, period1, period2);
        if (closes.length > 0) {
          succeeded = { provider: provider.name, closes };
          break;
        }
        providerMessages.push(`${provider.name}: no data`);
      } catch (err) {
        providerMessages.push(`${provider.name}: ${(err as Error).message}`);
      }
    }

    if (!succeeded) {
      results.push({
        symbol: asset.symbol,
        lookupSymbol,
        status: "failed",
        inserted: 0,
        updated: 0,
        unchanged: 0,
        error: providerMessages.join("; "),
      });
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const { date, close } of succeeded.closes) {
      const outcome = await upsertPrice(client, asset.id, date, close, succeeded.provider);
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "updated") updated += 1;
      else unchanged += 1;
    }

    results.push({
      symbol: asset.symbol,
      lookupSymbol,
      status: "ok",
      provider: succeeded.provider,
      inserted,
      updated,
      unchanged,
    });
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
