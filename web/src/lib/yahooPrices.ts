/**
 * Wrapper around yahoo-finance2 — reintroduced as the fallback provider for
 * assets Twelve Data's free tier doesn't cover (most non-US exchanges; its
 * own error names the Grow/Venture plan for those). Yahoo Finance's actual
 * exchange coverage is broad and free — the earlier attempt at using it as
 * the sole provider failed on real assets not because Yahoo lacks European
 * coverage, but because the symbols themselves needed exchange suffixes
 * (e.g. 'IWDA' → 'IWDA.AS') that nothing sets automatically. That's exactly
 * what assets.price_symbol is for — see priceSymbolImporter.ts.
 *
 * No API key needed, unlike Twelve Data.
 */

import YahooFinance from "yahoo-finance2";

export interface DailyClose {
  date: string; // YYYY-MM-DD
  close: number;
}

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * Returns [] if the symbol has no data (doesn't exist on Yahoo Finance,
 * wrong format, etc.) rather than throwing — callers treat an empty result
 * as "no data," a thrown error as the request itself failing.
 */
export async function fetchDailyCloses(symbol: string, period1: Date, period2: Date): Promise<DailyClose[]> {
  const rows = await yahooFinance.historical(symbol, { period1, period2, interval: "1d" });

  return rows
    .filter((row) => typeof row.close === "number" && !Number.isNaN(row.close))
    .map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      close: row.close,
    }));
}
