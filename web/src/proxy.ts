/**
 * Gates every route behind the shared password, except /login and
 * /api/login themselves (must stay reachable to log in at all).
 *
 * Named `proxy`, not `middleware` — Next.js 16 deprecated and renamed the
 * `middleware.ts` convention to `proxy.ts` (same mechanism, new name).
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, isValidAuthCookieValue } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let authorized: boolean;
  try {
    authorized = isValidAuthCookieValue(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  } catch (err) {
    // DASHBOARD_PASSWORD isn't set — fail closed, with a clear message
    // instead of either locking everyone out silently or letting everyone in.
    console.error("Auth misconfigured:", err);
    return NextResponse.json(
      { error: "Server misconfigured: DASHBOARD_PASSWORD is not set" },
      { status: 500 },
    );
  }

  if (authorized) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"],
};
