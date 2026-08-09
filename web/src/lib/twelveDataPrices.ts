/**
 * Wrapper around Twelve Data's REST API (https://twelvedata.com) — an
 * official, documented, API-key-based data source, swapped in for the
 * unofficial Yahoo Finance connector after seeing Yahoo's error surface up
 * for two mismatched symbols. Free tier: 800 requests/day, 8/minute — see
 * priceRefresh.ts for how the 8/minute cap is respected across a refresh
 * covering many assets.
 *
 * NOT verified against the live API from this dev session — this session's
 * outbound network is policy-restricted and api.twelvedata.com is blocked
 * here too (confirmed via the proxy's own diagnostics). parseTimeSeriesResponse
 * below is split out and unit-tested against a fixture matching Twelve
 * Data's documented response shape; the actual network call and the real
 * shape of a live response are what's unverified — see the README.
 */

export interface DailyClose {
  date: string; // YYYY-MM-DD
  close: number;
}

interface TimeSeriesValue {
  datetime: string;
  close: string;
}

interface TimeSeriesSuccess {
  status?: "ok";
  values?: TimeSeriesValue[];
}

interface TimeSeriesError {
  status: "error";
  code?: number;
  message?: string;
}

type TimeSeriesResponse = TimeSeriesSuccess | TimeSeriesError;

function isErrorResponse(data: TimeSeriesResponse): data is TimeSeriesError {
  return data.status === "error";
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure parsing/validation, deliberately separate from the network call so
 * it's unit-testable without hitting the real API. Throws for an
 * API-reported error (bad symbol, bad key, rate limit, etc. all come back
 * as `{status: "error", message}` from Twelve Data rather than an HTTP
 * error code) — callers treat that the same as a thrown fetch error.
 */
export function parseTimeSeriesResponse(data: unknown, period1: Date, period2: Date): DailyClose[] {
  const parsed = data as TimeSeriesResponse;

  if (isErrorResponse(parsed)) {
    throw new Error(parsed.message ?? `Twelve Data error (code ${parsed.code ?? "unknown"})`);
  }

  if (!parsed.values || parsed.values.length === 0) {
    return [];
  }

  const from = toDateOnly(period1);
  const to = toDateOnly(period2);

  return parsed.values
    .map((v) => ({ date: v.datetime.slice(0, 10), close: Number(v.close) }))
    .filter((v) => !Number.isNaN(v.close) && v.date >= from && v.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchDailyCloses(symbol: string, period1: Date, period2: Date): Promise<DailyClose[]> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVEDATA_API_KEY environment variable is not set");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("start_date", toDateOnly(period1));
  url.searchParams.set("end_date", toDateOnly(period2));
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString());
  const bodyText = await res.text();

  // Twelve Data itself always returns JSON, even for its own errors — but
  // anything sitting in front of it (a proxy, a CDN block page, a DNS
  // hijack landing page) might not. Caught for real: this dev sandbox's
  // network policy returns a plain-text block message here, and blindly
  // calling res.json() surfaced a useless "Unexpected token" error instead
  // of the actual cause. Parse defensively so *that* class of failure is
  // legible too, not just Twelve Data's own {status:"error"} responses.
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Twelve Data request failed: HTTP ${res.status} ${res.statusText} — ${bodyText.slice(0, 200)}`);
  }

  return parseTimeSeriesResponse(data, period1, period2);
}
