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

interface RawHistoricalRow {
  date?: unknown;
  close?: unknown;
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Pure, testable normalization — separated out because yahoo-finance2's
 * default schema validation throws the *entire* call out if any row has a
 * null field (open/high/low/volume, not just close), which real Yahoo data
 * legitimately has for some tickers. Caught live: 'IWDA.AS' produced
 * "Historical returned a result with SOME (but not all) null values." We
 * fetch with validateResult: false (see fetchDailyCloses below) and filter
 * defensively ourselves instead — we only actually need date + close, so a
 * null volume/open/high/low elsewhere in the row shouldn't cost us the
 * whole request.
 */
export function normalizeHistoricalRows(rows: RawHistoricalRow[]): DailyClose[] {
  const result: DailyClose[] = [];
  for (const row of rows) {
    const date = toValidDate(row.date);
    const close = typeof row.close === "number" && !Number.isNaN(row.close) ? row.close : null;
    if (date && close !== null) {
      result.push({ date: date.toISOString().slice(0, 10), close });
    }
  }
  return result;
}

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * Returns [] if the symbol has no data at all (doesn't exist on Yahoo
 * Finance, wrong format, etc.) rather than throwing — callers treat an
 * empty result as "no data," a thrown error as the request itself failing.
 */
export async function fetchDailyCloses(symbol: string, period1: Date, period2: Date): Promise<DailyClose[]> {
  const rows = await yahooFinance.historical(
    symbol,
    { period1, period2, interval: "1d" },
    { validateResult: false },
  );
  return normalizeHistoricalRows(rows as RawHistoricalRow[]);
}
