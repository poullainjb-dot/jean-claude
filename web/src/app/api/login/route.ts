import { NextResponse } from "next/server";
import { AUTH_COOKIE_MAX_AGE, AUTH_COOKIE_NAME, checkPassword, issueAuthCookieValue } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let password: string;
  try {
    const body = await request.json();
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let ok: boolean;
  let token: string;
  try {
    ok = checkPassword(password);
    token = issueAuthCookieValue();
  } catch (err) {
    console.error("Auth misconfigured:", err);
    return NextResponse.json(
      { error: "Server misconfigured: DASHBOARD_PASSWORD is not set" },
      { status: 500 },
    );
  }

  if (!ok) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE,
  });
  return response;
}
