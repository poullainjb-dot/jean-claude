import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPassword, issueAuthCookieValue, isValidAuthCookieValue } from "../src/lib/auth";

const ORIGINAL = process.env.DASHBOARD_PASSWORD;

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.DASHBOARD_PASSWORD;
  } else {
    process.env.DASHBOARD_PASSWORD = ORIGINAL;
  }
});

describe("checkPassword", () => {
  it("accepts the correct password", () => {
    expect(checkPassword("correct-horse-battery-staple")).toBe(true);
  });

  it("rejects an incorrect password", () => {
    expect(checkPassword("wrong")).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(checkPassword("")).toBe(false);
  });

  it("rejects a password that's a prefix of the real one", () => {
    expect(checkPassword("correct-horse")).toBe(false);
  });
});

describe("auth cookie token", () => {
  it("round-trips: an issued token validates", () => {
    const token = issueAuthCookieValue();
    expect(isValidAuthCookieValue(token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = issueAuthCookieValue();
    const tampered = token.slice(0, -1) + (token.at(-1) === "0" ? "1" : "0");
    expect(isValidAuthCookieValue(tampered)).toBe(false);
  });

  it("rejects undefined (no cookie present)", () => {
    expect(isValidAuthCookieValue(undefined)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAuthCookieValue("")).toBe(false);
  });

  it("produces a different token for a different password", () => {
    const token1 = issueAuthCookieValue();
    process.env.DASHBOARD_PASSWORD = "a-completely-different-password";
    const token2 = issueAuthCookieValue();
    expect(token1).not.toBe(token2);
    // and the old token no longer validates against the new password
    expect(isValidAuthCookieValue(token1)).toBe(false);
  });
});

describe("missing DASHBOARD_PASSWORD", () => {
  it("throws rather than silently allowing or denying everyone", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(() => checkPassword("anything")).toThrow();
    expect(() => issueAuthCookieValue()).toThrow();
    expect(() => isValidAuthCookieValue("anything")).toThrow();
  });
});
