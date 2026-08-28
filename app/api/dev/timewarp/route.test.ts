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
const { POST } = await import("./route");

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-timewarp-route-tests";
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.queueEntry.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.hold.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
    await db.seat.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  if (createdConcertIds.length > 0) {
    await db.concert.deleteMany({ where: { id: { in: createdConcertIds } } });
  }
  createdSessionIds.length = 0;
  createdRunIds.length = 0;
  createdConcertIds.length = 0;
});

async function establishSession(): Promise<string> {
  const { sessionId } = await getOrCreateSessionId();
  createdSessionIds.push(sessionId);
  return sessionId;
}

async function createActiveRun(sessionId: string, opts: { tier?: Tier } = {}) {
  const concert = await db.concert.create({
    data: { title: "timewarp-route-test", venue: "test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: opts.tier ?? Tier.SMALL,
      status: SimulationRunStatus.ACTIVE,
    },
  });
  createdRunIds.push(run.id);
  return run;
}

async function joinQueueDirectly(params: {
  sessionId: string;
  runId: string;
  concertId: string;
  position: number;
  joinedAt?: Date;
}) {
  return db.queueEntry.create({
    data: {
      concertId: params.concertId,
      simulationRunId: params.runId,
      sessionId: params.sessionId,
      position: params.position,
      joinedAt: params.joinedAt ?? new Date(),
    },
  });
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/dev/timewarp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/dev/timewarp", () => {
  it("always 404s when NODE_ENV is production, regardless of session/body", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const res = await POST(jsonRequest({ openInMs: -1000 }));
    expect(res.status).toBe(404);
  });

  it("rejects a request with no session cookie", async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 404 NO_ACTIVE_RUN when the session has no active simulation run", async () => {
    await establishSession();
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_RUN");
  });

  it("openInMs pushes SimulationRun.queueOpenAt to now + openInMs (future -> 'N ms before open' scenario)", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ openInMs: 30_000 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queueOpen.applied).toBe(true);
    // D-14: queueOpenAt is per-run, not the shared Concert row, so there's
    // no cross-session footgun left to warn about.
    expect(json.warnings).toEqual([]);

    const openAt = new Date(json.queueOpen.openAt).getTime();
    expect(openAt).toBeGreaterThan(Date.now());
    expect(openAt).toBeLessThan(Date.now() + 31_000);

    const persistedRun = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.queueOpenAt.getTime()).toBe(openAt);
  });

  it("negative openInMs pushes SimulationRun.queueOpenAt into the past ('already open' scenario)", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ openInMs: -3_600_000 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(new Date(json.queueOpen.openAt).getTime()).toBeLessThan(Date.now());
  });

  it("queueRewindMs sets QueueEntry.joinedAt to exactly now - queueRewindMs", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const entry = await joinQueueDirectly({ sessionId, runId: run.id, concertId: run.concertId, position: 500 });

    const res = await POST(jsonRequest({ queueRewindMs: 60_000 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queue.applied).toBe(true);

    const joinedAtMs = new Date(json.queue.joinedAt).getTime();
    expect(Date.now() - joinedAtMs).toBeGreaterThanOrEqual(59_000);
    expect(Date.now() - joinedAtMs).toBeLessThan(61_000);

    const persisted = await db.queueEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(persisted.joinedAt.getTime()).toBe(joinedAtMs);
  });

  it("queueConsumedPct computes the rewind from admissionRatePerSec so pollQueue reads back ~that % consumed", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId, { tier: Tier.SMALL }); // admissionRatePerSec 5
    await joinQueueDirectly({ sessionId, runId: run.id, concertId: run.concertId, position: 500 }); // position set directly, bypassing joinQueue's arrivalRatePerSec derivation

    const res = await POST(jsonRequest({ queueConsumedPct: 90 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queue.applied).toBe(true);

    const { pollQueue } = await import("@/lib/queue");
    const polled = await pollQueue({ sessionId, runId: run.id, now: new Date() });
    expect(polled.ok).toBe(true);
    if (polled.ok) {
      // 90% of 500 consumed -> ~50 remaining.
      expect(polled.snapshot.position).toBeGreaterThan(45);
      expect(polled.snapshot.position).toBeLessThanOrEqual(50);
    }
  });

  it("queue field set with no active QueueEntry doesn't block the rest of the request", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ openInMs: 30_000, queueRewindMs: 60_000 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queue).toEqual({ applied: false, reason: "NO_ACTIVE_QUEUE_ENTRY" });
    expect(json.queueOpen.applied).toBe(true);
  });

  it("rejects queueRewindMs and queueConsumedPct given together", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ queueRewindMs: 1000, queueConsumedPct: 50 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("AMBIGUOUS_QUEUE_PARAMS");
  });

  it("lastTickRewindMs sets SimulationRun.lastTickAt to now - lastTickRewindMs, but no longer affects advanceTick's claim (D-21)", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId, { tier: Tier.MEGA });

    const res = await POST(jsonRequest({ lastTickRewindMs: 60_000 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.simulationRun.applied).toBe(true);

    const persisted = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.lastTickAt.getTime()).toBeLessThanOrEqual(Date.now() - 59_000);

    // D-21: advanceTick now measures elapsed from queueOpenAt, not
    // lastTickAt — queueOpenAt is untouched here (still ~now, from
    // createActiveRun's default), so elapsed is ~0 and the claim is 0
    // regardless of the lastTickAt rewind above.
    const { advanceTick } = await import("@/lib/tick");
    const { prisma } = await import("@/lib/db");
    const tick = await prisma.$transaction((tx) => advanceTick({ runId: run.id, now: new Date(), tx }));
    expect(tick.botClaim.claimCount).toBe(0);
  });

  it("openInMs (rewinding queueOpenAt) is what now drives advanceTick's claim, per D-21", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId, { tier: Tier.MEGA });
    // D-22: advanceTick reads availableSeatCount from real Seat rows now —
    // this tiny 1-seat fixture is far below MEGA's real configured
    // poolSize (15,000), so a merely-large rewind (e.g. 60s) isn't enough:
    // computeBotClaimCount infers ~15,000 already claimed (poolSize minus
    // this fixture's availableSeatCount) and floors the claim to 0. A
    // saturating rewind (curve target ~= poolSize regardless of k) sidesteps
    // the mismatch, same pattern as lib/seats.test.ts's SATURATING_ELAPSED_MS.
    await db.seat.create({ data: { concertId: run.concertId, simulationRunId: run.id, row: "1", number: 1 } });
    const SATURATING_REWIND_MS = 100_000_000; // ~3.2 years

    const res = await POST(jsonRequest({ openInMs: -SATURATING_REWIND_MS }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queueOpen.applied).toBe(true);

    const { advanceTick } = await import("@/lib/tick");
    const { prisma } = await import("@/lib/db");
    const tick = await prisma.$transaction((tx) => advanceTick({ runId: run.id, now: new Date(), tx }));
    expect(tick.botClaim.claimCount).toBeGreaterThan(0);
  });

  it("applies a combined request (openInMs + queueConsumedPct + lastTickRewindMs) atomically", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId, { tier: Tier.SMALL });
    await joinQueueDirectly({ sessionId, runId: run.id, concertId: run.concertId, position: 500 });

    const res = await POST(
      jsonRequest({ openInMs: -1000, queueConsumedPct: 50, lastTickRewindMs: 10_000 }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queueOpen.applied).toBe(true);
    expect(json.queue.applied).toBe(true);
    expect(json.simulationRun.applied).toBe(true);
  });

  it("rejects a non-numeric field", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ openInMs: "soon" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_BODY");
  });
});
