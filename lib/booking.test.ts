// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { Tier, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { confirmBookingInfo } from "@/lib/booking";

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

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

function freshSessionId(): string {
  const id = `booking-test-${crypto.randomUUID()}`;
  createdSessionIds.push(id);
  return id;
}

async function createRun() {
  const concert = await db.concert.create({
    data: { title: "booking-test-concert", venue: "booking-test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: `booking-test-owner-${crypto.randomUUID()}`,
      tier: Tier.SMALL,
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

describe("confirmBookingInfo", () => {
  it("returns ok with the hold's expiresAt and records booking_info.exitedAt", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:02:00.000Z");
    const { hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    const result = await confirmBookingInfo({ sessionId, runId: run.id, now });

    expect(result).toEqual({ status: "ok", holdExpiresAt: hold.expiresAt.toISOString() });
    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(
      (sessionResult.stageTimings as { booking_info?: { exitedAt?: string } }).booking_info?.exitedAt,
    ).toBeTruthy();
  });

  it("returns hold_expired when the session has no active hold", async () => {
    const run = await createRun();
    const result = await confirmBookingInfo({ sessionId: freshSessionId(), runId: run.id, now: new Date() });
    expect(result).toEqual({ status: "hold_expired" });
  });

  it("returns hold_expired and sweeps an expired hold before checking ownership", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { seat } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date(now.getTime() - 1000), // already expired
    });

    const result = await confirmBookingInfo({ sessionId, runId: run.id, now });

    expect(result).toEqual({ status: "hold_expired" });
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
  });
});
