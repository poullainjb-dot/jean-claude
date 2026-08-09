/**
 * Thin wrapper around yahoo-finance2 — the TypeScript-ecosystem equivalent
 * of Python's yfinance the spec names: same idea (unofficial, free, no API
 * key), different language. Kept as a thin, swappable layer so
 * priceRefresh.ts's actual logic can be unit-tested against a fake fetcher
 * instead of the real network call — see that file for why.
 *
 * NOT verified against the live Yahoo Finance API from this dev session —
 * this session's outbound network is policy-restricted and query1.finance.
 * yahoo.com is blocked here (confirmed via the proxy's own diagnostics, not
 * a guess). The historical() call below follows yahoo-finance2's documented
 * API exactly, but the first real call (locally, or on the deployed app)
 * is the actual verification. One thing specifically worth eyeballing then:
 * the date conversion below assumes the library's Date objects represent
 * UTC midnight for the trading day — if a fetched date is off by one from
 * what Yahoo's own site shows, that assumption is the first place to check.
 */

import YahooFinance from "yahoo-finance2";

export interface DailyClose {
  date: string; // YYYY-MM-DD
  close: number;
}

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * Daily closing prices for `symbol` between period1 and period2 (inclusive
 * of trading days in that range). Returns [] if the symbol has no data
 * (e.g. it doesn't exist on Yahoo Finance) rather than throwing — callers
 * treat an empty result as "no data for this symbol," not a hard error.
 * A thrown error means the request itself failed (network, rate limit,
 * Yahoo-side error), which callers do treat as an error to report.
 */
export async function fetchDailyCloses(
  symbol: string,
  period1: Date,
  period2: Date,
): Promise<DailyClose[]> {
  const rows = await yahooFinance.historical(symbol, {
    period1,
    period2,
    interval: "1d",
  });

  return rows
    .filter((row) => typeof row.close === "number" && !Number.isNaN(row.close))
    .map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      close: row.close,
    }));
}
