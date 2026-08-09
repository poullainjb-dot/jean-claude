import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as loginPost } from "../src/app/api/login/route";
import { POST as logoutPost } from "../src/app/api/logout/route";
import { AUTH_COOKIE_NAME } from "../src/lib/auth";

const ORIGINAL = process.env.DASHBOARD_PASSWORD;

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = "test-password-123";
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.DASHBOARD_PASSWORD;
  } else {
    process.env.DASHBOARD_PASSWORD = ORIGINAL;
  }
});

function loginRequest(password: unknown) {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/login", () => {
  it("sets an httpOnly auth cookie on the correct password", async () => {
    const res = await loginPost(loginRequest("test-password-123"));
    expect(res.status).toBe(200);

    const cookie = res.cookies.get(AUTH_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();

    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("HttpOnly");
  });

  it("rejects an incorrect password without setting a cookie", async () => {
    const res = await loginPost(loginRequest("wrong-password"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a malformed JSON body", async () => {
    const req = new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    const res = await loginPost(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 with a clear message if DASHBOARD_PASSWORD isn't set", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const res = await loginPost(loginRequest("anything"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("DASHBOARD_PASSWORD");
  });
});

describe("POST /api/logout", () => {
  it("clears the auth cookie", async () => {
    const res = await logoutPost();
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain(`${AUTH_COOKIE_NAME}=`);
    expect(setCookieHeader.toLowerCase()).toMatch(/max-age=0|expires=/);
  });
});
