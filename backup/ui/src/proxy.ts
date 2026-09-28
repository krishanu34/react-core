/**
 * src/proxy.ts
 * Next.js 16+ edge proxy — redirect unauthenticated users to /login.
 * (Replaces the deprecated src/middleware.ts convention)
 */
import { NextRequest, NextResponse } from "next/server";

// Self-service auth routes must be reachable while signed OUT, or the proxy
// bounces them straight back to /login.
const PUBLIC_PATHS = ["/login", "/register", "/forgot-username", "/integrate", "/_next", "/favicon.ico", "/cb-api", "/workspace-api", "/devsphere-api", "/api", "/lm-api", "/ws"];
// Static asset extensions that are always public
const PUBLIC_EXTENSIONS = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico", ".woff", ".woff2"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets through (images, fonts, etc.)
  if (PUBLIC_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("auth_token")?.value;

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Minimal expiry check — inspect exp claim from JWT payload without crypto
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) throw new Error("bad token");
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    );
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("from", pathname);
      const res = NextResponse.redirect(loginUrl);
      res.cookies.delete("auth_token");
      return res;
    }
  } catch {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
