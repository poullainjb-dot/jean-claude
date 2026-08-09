/**
 * Single shared password gating the whole app — this is a personal,
 * single-user tool, not a multi-account system, so there's no user table,
 * no per-user sessions, no password hashing library. Deliberately simple:
 *
 * - The cookie holds an HMAC of a fixed string, keyed by DASHBOARD_PASSWORD
 *   — not the password itself, so a leaked cookie doesn't leak the
 *   password — but it also never expires server-side and there's no
 *   session store, so a leaked cookie *is* still valid on its own until it
 *   expires (30 days) or the password changes. Acceptable for a personal
 *   tool behind HTTPS; worth knowing if that threat model ever changes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "portfolio_auth";
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

function getPasswordOrThrow(): string {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error("DASHBOARD_PASSWORD environment variable is not set");
  }
  return password;
}

function computeToken(password: string): string {
  return createHmac("sha256", password).update("portfolio-auth-v1").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths — different-length inputs
  // are already distinguishable by length alone, so a fast-path return here
  // leaks nothing an attacker couldn't already infer.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Throws if DASHBOARD_PASSWORD isn't configured — fail loudly, not open. */
export function checkPassword(candidate: string): boolean {
  return timingSafeStringEqual(candidate, getPasswordOrThrow());
}

/** Throws if DASHBOARD_PASSWORD isn't configured. */
export function issueAuthCookieValue(): string {
  return computeToken(getPasswordOrThrow());
}

/** Throws if DASHBOARD_PASSWORD isn't configured. */
export function isValidAuthCookieValue(value: string | undefined): boolean {
  if (!value) return false;
  return timingSafeStringEqual(value, computeToken(getPasswordOrThrow()));
}
