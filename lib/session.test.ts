import { describe, it, expect, vi, beforeEach } from "vitest";

// next/headers' cookies() only works inside a real Next.js request scope
// (App Router dev/build server) — outside of it (here, under Vitest) it
// throws. This fake, Map-backed store mirrors the subset of the
// ReadonlyRequestCookies API this module actually uses (get/set), which
// is the standard way to unit-test code that touches next/headers.
const store = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
  })),
}));

// Imported after the mock so lib/session.ts picks up the mocked module.
const { getOrCreateSessionId, requireSession, SESSION_COOKIE_NAME } = await import(
  "./session"
);

const ORIGINAL_SECRET = process.env.SESSION_SECRET;

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = ORIGINAL_SECRET ?? "test-secret-for-session-unit-tests";
});

describe("getOrCreateSessionId", () => {
  it("issues a new session and sets a signed cookie when none exists", async () => {
    const result = await getOrCreateSessionId();

    expect(result.isNew).toBe(true);
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const cookie = store.get(SESSION_COOKIE_NAME);
    expect(cookie?.value).toContain(result.sessionId);
  });

  it("reuses an existing session when the cookie signature is valid", async () => {
    const first = await getOrCreateSessionId();
    const second = await getOrCreateSessionId();

    expect(second.isNew).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("issues a fresh session when the cookie signature is tampered with", async () => {
    const first = await getOrCreateSessionId();
    const cookie = store.get(SESSION_COOKIE_NAME)!;
    store.set(SESSION_COOKIE_NAME, { value: `${cookie.value}tampered` });

    const second = await getOrCreateSessionId();

    expect(second.isNew).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("issues a fresh session for a malformed cookie value", async () => {
    store.set(SESSION_COOKIE_NAME, { value: "not-a-valid-cookie-format" });

    const result = await getOrCreateSessionId();

    expect(result.isNew).toBe(true);
  });
});

describe("requireSession", () => {
  it("returns an error when no session cookie is present", async () => {
    const result = await requireSession();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("SESSION_MISSING");
    }
  });

  it("returns an error for a tampered session cookie", async () => {
    await getOrCreateSessionId();
    const cookie = store.get(SESSION_COOKIE_NAME)!;
    store.set(SESSION_COOKIE_NAME, { value: `${cookie.value}x` });

    const result = await requireSession();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("SESSION_INVALID");
    }
  });

  it("returns the sessionId for a valid cookie", async () => {
    const created = await getOrCreateSessionId();
    const result = await requireSession();

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.sessionId).toBe(created.sessionId);
    }
  });
});
