import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDailyCloses, parseTimeSeriesResponse } from "../src/lib/twelveDataPrices";

// Fixtures shaped to match Twelve Data's documented time_series response —
// see https://twelvedata.com/docs#time-series. Not verified against a live
// response from this dev session (network blocked here) — this is the best
// available check until someone runs it with real network access.

const PERIOD1 = new Date("2024-05-25T00:00:00Z");
const PERIOD2 = new Date("2024-06-05T00:00:00Z");

describe("parseTimeSeriesResponse", () => {
  it("parses a normal success response into ascending-date closes", () => {
    const response = {
      meta: { symbol: "AAPL" },
      values: [
        { datetime: "2024-06-03", close: "190.50" },
        { datetime: "2024-06-02", close: "189.00" },
        { datetime: "2024-06-01", close: "188.25" },
      ],
      status: "ok",
    };

    const result = parseTimeSeriesResponse(response, PERIOD1, PERIOD2);
    expect(result).toEqual([
      { date: "2024-06-01", close: 188.25 },
      { date: "2024-06-02", close: 189.0 },
      { date: "2024-06-03", close: 190.5 },
    ]);
  });

  it("filters out dates outside the requested period", () => {
    const response = {
      values: [
        { datetime: "2024-06-01", close: "100" },
        { datetime: "2024-07-15", close: "999" }, // outside PERIOD2
        { datetime: "2024-01-01", close: "999" }, // outside PERIOD1
      ],
      status: "ok",
    };

    const result = parseTimeSeriesResponse(response, PERIOD1, PERIOD2);
    expect(result).toEqual([{ date: "2024-06-01", close: 100 }]);
  });

  it("throws with the API's own message for an error-status response", () => {
    const response = {
      code: 400,
      message: "**symbol** not found: BADTICKER",
      status: "error",
    };

    expect(() => parseTimeSeriesResponse(response, PERIOD1, PERIOD2)).toThrow(
      "**symbol** not found: BADTICKER",
    );
  });

  it("throws a fallback message for an error-status response with no message", () => {
    const response = { status: "error", code: 429 };
    expect(() => parseTimeSeriesResponse(response, PERIOD1, PERIOD2)).toThrow(/429/);
  });

  it("returns an empty array when values is missing", () => {
    const response = { status: "ok" };
    expect(parseTimeSeriesResponse(response, PERIOD1, PERIOD2)).toEqual([]);
  });

  it("returns an empty array when values is empty", () => {
    const response = { status: "ok", values: [] };
    expect(parseTimeSeriesResponse(response, PERIOD1, PERIOD2)).toEqual([]);
  });

  it("drops rows with a non-numeric close instead of throwing", () => {
    const response = {
      values: [
        { datetime: "2024-06-01", close: "100" },
        { datetime: "2024-06-02", close: "n/a" },
      ],
      status: "ok",
    };
    expect(parseTimeSeriesResponse(response, PERIOD1, PERIOD2)).toEqual([{ date: "2024-06-01", close: 100 }]);
  });
});

describe("fetchDailyCloses", () => {
  const ORIGINAL_KEY = process.env.TWELVEDATA_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TWELVEDATA_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.TWELVEDATA_API_KEY = ORIGINAL_KEY;
    global.fetch = originalFetch;
  });

  it("throws a clear, specific error instead of a JSON-parse error when the response isn't JSON", async () => {
    // Reproduces exactly what this dev sandbox's own network policy returns:
    // a plain-text block page, not the JSON body Twelve Data itself always
    // sends. See the comment in src/lib/twelveDataPrices.ts for why this
    // needed its own defensive handling.
    global.fetch = vi.fn().mockResolvedValue({
      status: 403,
      statusText: "Forbidden",
      text: async () => "Host not in allowlist: api.twelvedata.com",
    }) as unknown as typeof fetch;

    await expect(fetchDailyCloses("AAPL", PERIOD1, PERIOD2)).rejects.toThrow(
      /HTTP 403 Forbidden.*Host not in allowlist/,
    );
  });

  it("throws when TWELVEDATA_API_KEY isn't set, without making a request", async () => {
    delete process.env.TWELVEDATA_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(fetchDailyCloses("AAPL", PERIOD1, PERIOD2)).rejects.toThrow("TWELVEDATA_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
