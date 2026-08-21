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

async function createActiveRun(sessionId: string, openAt = new Date("2000-01-01T00:00:00.000Z")) {
  const concert = await db.concert.create({
    data: { title: "queue-route-test", venue: "test-venue", openAt },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: { concertId: concert.id, sessionId, tier: Tier.SMALL, status: SimulationRunStatus.ACTIVE },
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

  it("joins the queue at the tier's virtualQueueSize", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.position).toBe(500); // SMALL tier virtualQueueSize
    expect(json.status).toBe("WAITING");
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
    // A few ms of real elapsed time pass between the POST and GET calls
    // above, so the position decays very slightly below its 500 starting
    // value (SMALL tier: 5/sec) rather than staying exactly 500.
    expect(json.position).toBeLessThanOrEqual(500);
    expect(json.position).toBeGreaterThan(499);
    expect(json.status).toBe("WAITING");
  });
});
