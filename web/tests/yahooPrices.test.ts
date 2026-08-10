import { describe, expect, it } from "vitest";
import { normalizeHistoricalRows } from "../src/lib/yahooPrices";

// Reproduces exactly what broke live: yahoo-finance2's default validation
// throws the whole historical() call out when ANY row has a null field
// (not just close) — real data for 'IWDA.AS' triggered this ("Historical
// returned a result with SOME (but not all) null values"). Fetching with
// validateResult: false avoids the throw; this tests that the resulting
// unvalidated rows are then filtered correctly on our end.

describe("normalizeHistoricalRows", () => {
  it("keeps rows with a valid date and close", () => {
    const rows = [
      { date: new Date("2024-06-01T00:00:00Z"), close: 190.5 },
      { date: new Date("2024-06-02T00:00:00Z"), close: 191.0 },
    ];
    expect(normalizeHistoricalRows(rows)).toEqual([
      { date: "2024-06-01", close: 190.5 },
      { date: "2024-06-02", close: 191.0 },
    ]);
  });

  it("drops a row with a null close, keeping the rest — the exact live scenario", () => {
    const rows = [
      { date: new Date("2024-06-01T00:00:00Z"), close: 190.5 },
      { date: new Date("2024-06-02T00:00:00Z"), close: null }, // e.g. a thinly-traded day
      { date: new Date("2024-06-03T00:00:00Z"), close: 192.0 },
    ];
    expect(normalizeHistoricalRows(rows)).toEqual([
      { date: "2024-06-01", close: 190.5 },
      { date: "2024-06-03", close: 192.0 },
    ]);
  });

  it("drops a row with a missing close field entirely", () => {
    const rows = [{ date: new Date("2024-06-01T00:00:00Z") }];
    expect(normalizeHistoricalRows(rows)).toEqual([]);
  });

  it("drops a row with an invalid date", () => {
    const rows = [
      { date: new Date("invalid"), close: 100 },
      { date: null, close: 100 },
      { date: new Date("2024-06-01T00:00:00Z"), close: 100 },
    ];
    expect(normalizeHistoricalRows(rows)).toEqual([{ date: "2024-06-01", close: 100 }]);
  });

  it("drops a row where close is NaN or a non-numeric value", () => {
    const rows = [
      { date: new Date("2024-06-01T00:00:00Z"), close: Number.NaN },
      { date: new Date("2024-06-02T00:00:00Z"), close: "not a number" },
      { date: new Date("2024-06-03T00:00:00Z"), close: 100 },
    ];
    expect(normalizeHistoricalRows(rows)).toEqual([{ date: "2024-06-03", close: 100 }]);
  });

  it("accepts a string date, not just a Date instance (defensive — the SDK is unvalidated here)", () => {
    const rows = [{ date: "2024-06-01", close: 100 }];
    expect(normalizeHistoricalRows(rows)).toEqual([{ date: "2024-06-01", close: 100 }]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeHistoricalRows([])).toEqual([]);
  });
});
