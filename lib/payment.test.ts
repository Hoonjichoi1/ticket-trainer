// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { Tier, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { recordJudgmentEvent } from "@/lib/session-result";
import { attemptPayment, shouldInjectPaymentError } from "@/lib/payment";

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.booking.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
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

function freshSessionId(): string {
  const id = `payment-test-${crypto.randomUUID()}`;
  createdSessionIds.push(id);
  return id;
}

// SMALL's seeded latencyMs (50ms per prisma/seed.ts) keeps every real
// attemptPayment() call in this file fast without needing to mock it out.
async function createRun(tier: Tier = Tier.SMALL) {
  const concert = await db.concert.create({
    data: { title: "payment-test-concert", venue: "payment-test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: `payment-test-owner-${crypto.randomUUID()}`,
      tier,
      lastTickAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);

  return run;
}

async function createHeldSeat(params: { runId: string; concertId: string; sessionId: string; expiresAt: Date }) {
  const seat = await db.seat.create({
    data: { concertId: params.concertId, simulationRunId: params.runId, row: "A", number: 1, status: SeatStatus.HELD },
  });
  const hold = await db.hold.create({
    data: { seatId: seat.id, sessionId: params.sessionId, expiresAt: params.expiresAt },
  });
  return { seat, hold };
}

describe("shouldInjectPaymentError", () => {
  it("injects an error iff roll < errorRate", () => {
    expect(shouldInjectPaymentError(0.1, 0.05)).toBe(true);
    expect(shouldInjectPaymentError(0.1, 0.1)).toBe(false); // boundary: equal doesn't count
    expect(shouldInjectPaymentError(0.1, 0.15)).toBe(false);
    expect(shouldInjectPaymentError(0, 0)).toBe(false);
  });
});

describe("attemptPayment", () => {
  it("returns hold_expired when the session has no active hold", async () => {
    const run = await createRun();
    const result = await attemptPayment({ sessionId: freshSessionId(), runId: run.id, now: new Date() });
    expect(result).toEqual({ status: "hold_expired" });
  });

  it("returns hold_expired after sweeping an expired hold", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { seat } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date(now.getTime() - 1000),
    });

    const result = await attemptPayment({ sessionId, runId: run.id, now });

    expect(result).toEqual({ status: "hold_expired" });
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
  });

  it("on injected failure: leaves Seat/Hold untouched, records payment_error", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:02:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    const result = await attemptPayment({ sessionId, runId: run.id, now, roll: 0, errorTypeRoll: 0.2 });

    expect(result).toEqual({ status: "error", errorType: "timeout" });
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.releasedAt).toBeNull();
    const booking = await db.booking.findUnique({ where: { seatId: seat.id } });
    expect(booking).toBeNull();

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string; errorType?: string }>;
    expect(events).toEqual([{ type: "payment_error", stage: "payment", errorType: "timeout", timestamp: now.toISOString() }]);
    expect(sessionResult.outcome).toBeNull();
  });

  it("on success: Seat -> SOLD, Booking created, Hold released, payment.exitedAt recorded", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:02:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    const result = await attemptPayment({ sessionId, runId: run.id, now, roll: 0.99 });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.bookingId).toBeTruthy();

    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.SOLD);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.releasedAt?.getTime()).toBe(now.getTime());
    const booking = await db.booking.findUniqueOrThrow({ where: { seatId: seat.id } });
    expect(booking.id).toBe(result.bookingId);
    expect(booking.sessionId).toBe(sessionId);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect((sessionResult.stageTimings as { payment?: { exitedAt?: string } }).payment?.exitedAt).toBeTruthy();
    expect(sessionResult.outcome).toBeNull();
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events.some((e) => e.type === "payment_retry_success")).toBe(false);
  });

  it("records payment_retry_success in addition to success when the prior payment-stage event was payment_error", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:02:00.000Z");
    await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });
    await recordJudgmentEvent(db, sessionId, {
      type: "payment_error",
      stage: "payment",
      errorType: "server_error",
      timestamp: now.toISOString(),
    });

    const result = await attemptPayment({ sessionId, runId: run.id, now, roll: 0.99 });

    expect(result.status).toBe("success");
    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events.filter((e) => e.type === "payment_retry_success")).toHaveLength(1);
  });
});
