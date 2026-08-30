// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier, SimulationRunStatus, SeatStatus, type JudgmentEvent } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { recordJudgmentEvent } from "@/lib/session-result";

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

async function createHeldSeat(
  sessionId: string,
  run: { id: string; concertId: string },
  expiresAt: Date = new Date(Date.now() + 5 * 60_000),
) {
  const seat = await db.seat.create({
    data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.HELD },
  });
  await db.hold.create({ data: { seatId: seat.id, sessionId, expiresAt } });
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

  it("ends the session's hold but leaves the seat HELD (D-5: no seat release)", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const seat = await createHeldSeat(sessionId, run);

    const res = await POST();

    expect(res.status).toBe(204);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
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

  // Regression for the bug where releaseHold skipped the expireStaleHolds
  // sweep that getOwnedHold's contract requires callers to run first
  // (unlike attemptPayment/confirmBookingInfo, which both sweep before
  // reading the hold). Without the sweep, a hold that's already past its
  // expiresAt but not yet marked releasedAt gets treated as a live
  // session-initiated release instead of an expiry, so it wrongly records
  // payment_abandoned (since the prior event was payment_error) instead of
  // hold_expired.
  it("releases an already-expired-but-unswept hold as hold_expired, not payment_abandoned", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const alreadyExpired = new Date(Date.now() - 1000);
    await createHeldSeat(sessionId, run, alreadyExpired);
    await recordJudgmentEvent(db, sessionId, {
      type: "payment_error",
      stage: "payment",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      errorType: "server_error",
    });

    const res = await POST();
    expect(res.status).toBe(204);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as JudgmentEvent[];
    expect(events.some((event) => event.type === "hold_expired")).toBe(true);
    expect(events.some((event) => event.type === "payment_abandoned")).toBe(false);
  });

  it("records payment_abandoned when a still-active hold is released right after a payment_error", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const stillValid = new Date(Date.now() + 5 * 60_000);
    await createHeldSeat(sessionId, run, stillValid);
    await recordJudgmentEvent(db, sessionId, {
      type: "payment_error",
      stage: "payment",
      timestamp: new Date().toISOString(),
      errorType: "server_error",
    });

    const res = await POST();
    expect(res.status).toBe(204);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as JudgmentEvent[];
    expect(events.some((event) => event.type === "payment_abandoned")).toBe(true);
  });
});
