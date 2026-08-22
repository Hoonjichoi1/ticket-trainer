import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier, SimulationRunStatus, SeatStatus } from "@/lib/types";
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
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-holds-release-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
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

async function createActiveRun(sessionId: string) {
  const concert = await db.concert.create({
    data: { title: "holds-release-route-test", venue: "test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: Tier.SMALL,
      status: SimulationRunStatus.ACTIVE,
      lastTickAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);

  return run;
}

async function createHeldSeat(sessionId: string, run: { id: string; concertId: string }) {
  const seat = await db.seat.create({
    data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.HELD },
  });
  await db.hold.create({ data: { seatId: seat.id, sessionId, expiresAt: new Date(Date.now() + 5 * 60_000) } });
  return seat;
}

describe("POST /api/holds/release", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 204 when the session has no active simulation run", async () => {
    await establishSession();
    const res = await POST();
    expect(res.status).toBe(204);
  });

  it("returns 204 when the session has an active run but no active hold", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST();
    expect(res.status).toBe(204);
  });

  it("releases the session's held seat back to AVAILABLE", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const seat = await createHeldSeat(sessionId, run);

    const res = await POST();

    expect(res.status).toBe(204);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.AVAILABLE);
    const hold = await db.hold.findFirstOrThrow({ where: { seatId: seat.id } });
    expect(hold.releasedAt).not.toBeNull();
  });

  it("is idempotent against a second call after the hold is already released", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    await createHeldSeat(sessionId, run);

    await POST();
    const res = await POST();

    expect(res.status).toBe(204);
  });
});
