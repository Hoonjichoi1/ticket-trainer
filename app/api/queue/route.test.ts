import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier, SimulationRunStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";

const store = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
  })),
}));

const { getOrCreateSessionId } = await import("@/lib/session");
const { POST, GET } = await import("./route");

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-queue-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.queueEntry.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  if (createdConcertIds.length > 0) {
    await db.concert.deleteMany({ where: { id: { in: createdConcertIds } } });
  }
  createdSessionIds.length = 0;
  createdRunIds.length = 0;
  createdConcertIds.length = 0;
});

/** Establishes a session cookie (via the real session helper) and returns its sessionId. */
async function establishSession(): Promise<string> {
  const { sessionId } = await getOrCreateSessionId();
  createdSessionIds.push(sessionId);
  return sessionId;
}

// Default openAt is ~100s before "now" (computed at call time, not a fixed
// date). D-23: SMALL's surgeBaseline (400) + arrivalRatePerSec (2/sec) * 100s
// = ~600 — the route computes its own `now` a few ms later than this default
// is evaluated, so assertions below tolerate that small drift instead of
// asserting an exact value.
async function createActiveRun(sessionId: string, openAt = new Date(Date.now() - 100_000)) {
  const concert = await db.concert.create({
    data: { title: "queue-route-test", venue: "test-venue", openAt },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: Tier.SMALL,
      status: SimulationRunStatus.ACTIVE,
      // D-14: joinQueue reads SimulationRun.queueOpenAt, not Concert.openAt.
      queueOpenAt: openAt,
    },
  });
  createdRunIds.push(run.id);
  return run;
}

describe("POST /api/queue", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session has no active simulation run", async () => {
    await establishSession();
    const res = await POST();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_RUN");
  });

  it("joins the queue with a position derived from surgeBaseline + arrivalRatePerSec × elapsed time since open", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    // SMALL surgeBaseline (400) + arrivalRatePerSec (2/sec) * ~100s since
    // open = ~600; tolerate a few ms of real-clock drift between the
    // fixture's openAt and the route's own `new Date()`.
    expect(json.position).toBeGreaterThanOrEqual(600);
    expect(json.position).toBeLessThanOrEqual(601);
    expect(json.status).toBe("WAITING");
  });

  it("assigns a larger initial position the later the session joins after open (D-4)", async () => {
    const earlySessionId = await establishSession();
    await createActiveRun(earlySessionId, new Date(Date.now() - 5_000)); // 5s since open
    const earlyRes = await POST();
    const earlyJson = await earlyRes.json();

    // establishSession() reuses an existing valid cookie rather than
    // issuing a new one — clear the mocked cookie store first so this
    // second call actually creates a distinct second session.
    store.clear();
    const lateSessionId = await establishSession();
    await createActiveRun(lateSessionId, new Date(Date.now() - 300_000)); // 300s since open
    const lateRes = await POST();
    const lateJson = await lateRes.json();

    expect(lateJson.position).toBeGreaterThan(earlyJson.position);
  });

  it("rejects joining before the concert's openAt (F002 server check)", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId, new Date("2999-01-01T00:00:00.000Z"));

    const res = await POST();
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("SALE_NOT_OPEN");
  });
});

describe("GET /api/queue", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session hasn't joined the queue yet", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await GET();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_ENTRY");
  });

  it("reflects the position after joining", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);
    await POST();

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    // Starting position is ~600 (D-23: surgeBaseline 400 + arrivalRatePerSec
    // 2/sec * ~100s since open). A few ms of real elapsed time pass between
    // the POST and GET calls above, decaying it slightly further
    // (admissionRatePerSec 2/sec) — tolerate both that decay and the
    // join-time rounding drift.
    expect(json.position).toBeLessThanOrEqual(601);
    expect(json.position).toBeGreaterThan(598);
    expect(json.status).toBe("WAITING");
  });
});
