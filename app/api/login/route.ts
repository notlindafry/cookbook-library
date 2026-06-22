import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  authConfigured,
  createSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  type Role,
} from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { clientIp, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Constant-time comparison via fixed-length digests (no length leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Map a submitted password to a role: the owner password (APP_PASSWORD) grants
 * full access; the optional guest password (APP_GUEST_PASSWORD) grants
 * read-only access. Returns null when it matches neither.
 *
 * Surrounding whitespace is trimmed from both the configured values and the
 * submission. Env vars pasted into a host dashboard very often pick up a
 * trailing newline, which would otherwise make a correct password never match.
 */
function roleForPassword(submitted: string): Role | null {
  const candidate = submitted.trim();
  if (!candidate) return null;
  const owner = process.env.APP_PASSWORD?.trim();
  const guest = process.env.APP_GUEST_PASSWORD?.trim();
  if (owner && safeEqual(candidate, owner)) return "owner";
  if (guest && safeEqual(candidate, guest)) return "guest";
  return null;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  }

  // Throttle login attempts per IP to blunt brute force.
  const ip = clientIp(req);
  const limit = rateLimit(`login:${ip}`, 10, 10 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const submitted = typeof body.password === "string" ? body.password : "";

  if (!authConfigured()) {
    return NextResponse.json(
      { error: "Login is not configured on the server." },
      { status: 503 },
    );
  }

  const role = roleForPassword(submitted);
  if (!role) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const token = await createSession(role);
  if (!token) {
    return NextResponse.json(
      { error: "Login is not configured on the server." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
