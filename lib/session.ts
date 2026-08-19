// Anonymous session identity (F012): a random UUID stored in an
// HTTP-only, HMAC-signed cookie. No accounts, no passwords — the
// signature only proves the server issued this UUID, so a client can't
// forge or edit another session's id to steal its queue position/hold.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { ApiErrorResponse } from "@/lib/types";

export const SESSION_COOKIE_NAME = "ticket-trainer:session";

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET env var is required to sign session cookies. Set it in .env.local.",
    );
  }
  return secret;
}

function sign(sessionId: string): string {
  const signature = createHmac("sha256", getSecret())
    .update(sessionId)
    .digest("base64url");
  return `${sessionId}.${signature}`;
}

// Returns the sessionId iff the signature is intact; null for anything
// else (missing separator, tampered value, wrong secret) so callers
// always fall back to issuing a fresh session rather than trusting a
// partially-valid cookie.
function verify(cookieValue: string): string | null {
  const separatorIndex = cookieValue.lastIndexOf(".");
  if (separatorIndex <= 0) return null;

  const sessionId = cookieValue.slice(0, separatorIndex);
  const signature = cookieValue.slice(separatorIndex + 1);
  const expected = createHmac("sha256", getSecret())
    .update(sessionId)
    .digest("base64url");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch instead of returning
  // false, and it must run on the raw signature bytes (not sessionId)
  // to actually defend the HMAC comparison against timing attacks.
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  return sessionId;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

export interface SessionResult {
  sessionId: string;
  isNew: boolean;
}

/**
 * Reads the session cookie; issues (and sets) a fresh signed cookie if
 * it's missing or fails signature verification. Only call this from a
 * context allowed to mutate outgoing cookies (Route Handlers / Server
 * Functions) — per Next.js 16 docs, `cookies()` write methods throw
 * outside of those.
 */
export async function getOrCreateSessionId(): Promise<SessionResult> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const verified = existing ? verify(existing) : null;

  if (verified) {
    return { sessionId: verified, isNew: false };
  }

  const sessionId = randomUUID();
  cookieStore.set(SESSION_COOKIE_NAME, sign(sessionId), cookieOptions());
  return { sessionId, isNew: true };
}

export type RequireSessionResult =
  | { sessionId: string }
  | { error: ApiErrorResponse };

/**
 * Read-only session check for every other route (Task 007+): does NOT
 * issue a new session on failure — an invalid/missing session is a
 * caller error (they skipped POST /api/session), not something to
 * silently paper over.
 */
export async function requireSession(): Promise<RequireSessionResult> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!existing) {
    return {
      error: {
        status: "error",
        code: "SESSION_MISSING",
        message: "No session cookie present. Call POST /api/session first.",
      },
    };
  }

  const sessionId = verify(existing);
  if (!sessionId) {
    return {
      error: {
        status: "error",
        code: "SESSION_INVALID",
        message: "Session cookie signature is invalid.",
      },
    };
  }

  return { sessionId };
}
