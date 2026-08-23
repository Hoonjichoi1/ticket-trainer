import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier, SimulationRunStatus, SeatStatus, SessionOutcome } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { recordStageEntered, recordStageExited } from "@/lib/session-result";

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
const { GET } = await import("./route");

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-result-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.booking.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
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

async function createRun(sessionId: string) {
  const concert = await db.concert.create({
    data: { title: "result-route-test", venue: "test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
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

describe("GET /api/result", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session has no SessionResult row yet", async () => {
    await establishSession();
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("returns the aggregated result once a Booking exists for the current run", async () => {
    const sessionId = await establishSession();
    const run = await createRun(sessionId);
    const seat = await db.seat.create({
      data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.SOLD },
    });
    await db.booking.create({ data: { concertId: run.concertId, seatId: seat.id, sessionId } });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "payment", now);
    await recordStageExited(db, sessionId, "payment", now);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe(SessionOutcome.SUCCESS);
    expect(body.stageTimings.payment?.durationMs).toBe(0);
  });

  it("still returns the result after the run has already transitioned to COMPLETED on a prior visit", async () => {
    const sessionId = await establishSession();
    const run = await createRun(sessionId);
    const seat = await db.seat.create({
      data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.SOLD },
    });
    await db.booking.create({ data: { concertId: run.concertId, seatId: seat.id, sessionId } });
    await recordStageEntered(db, sessionId, "payment", new Date("2026-01-01T00:10:00.000Z"));

    const first = await GET();
    expect(first.status).toBe(200);
    const persistedRun = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe(SimulationRunStatus.COMPLETED);

    const second = await GET();
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.outcome).toBe(SessionOutcome.SUCCESS);
  });
});
