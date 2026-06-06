import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

// Paths reachable without a session.
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/logout"]);

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    // Next injects a small bootstrap script that carries this nonce, then loads
    // chunks dynamically — 'strict-dynamic' authorizes those. 'unsafe-eval' is
    // only needed for the dev server's HMR.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function applySecurityHeaders(res: NextResponse, csp: string): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  res.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Per-request nonce for the CSP.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildCsp(nonce);

  const isPublic = PUBLIC_PATHS.has(pathname);
  const authed = isPublic
    ? false
    : await verifySession(req.cookies.get("rf_session")?.value);

  // Block protected routes when unauthenticated.
  if (!isPublic && !authed) {
    if (pathname.startsWith("/api/")) {
      return applySecurityHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        csp,
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return applySecurityHeaders(NextResponse.redirect(url), csp);
  }

  // Already logged in but hitting the login page → send home.
  if (pathname === "/login") {
    const sessionValid = await verifySession(req.cookies.get("rf_session")?.value);
    if (sessionValid) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return applySecurityHeaders(NextResponse.redirect(url), csp);
    }
  }

  // Pass through, forwarding the nonce so Next applies it to its scripts.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  return applySecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
  );
}

export const config = {
  // Run on everything except Next's static assets and public files (icons,
  // manifest) — those must stay reachable for the PWA without a session.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|manifest.webmanifest|robots.txt).*)",
  ],
};
