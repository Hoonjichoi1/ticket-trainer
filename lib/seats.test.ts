import { describe, it, expect, afterEach } from "vitest";
import { Tier, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import {
  claimSeat,
  releaseExpiredHolds,
  listSeatMap,
  runSeatMapTick,
  seatBelongsToRun,
  botSessionId,
  isBotSession,
  HOLD_DURATION_MS,
} from "@/lib/seats";

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    // Holds cascade-delete isn't configured, so holds must go before seats.
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
  const id = `seats-test-${crypto.randomUUID()}`;
  createdSessionIds.push(id);
  return id;
}

async function createRun(opts: { tier?: Tier; lastTickAt?: Date } = {}) {
  const concert = await db.concert.create({
    data: { title: "seats-test-concert", venue: "seats-test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: `seats-test-owner-${crypto.randomUUID()}`,
      tier: opts.tier ?? Tier.SMALL,
      lastTickAt: opts.lastTickAt ?? new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);

  return run;
}

async function createSeats(runId: string, concertId: string, count: number) {
  const seats = [];
  for (let i = 0; i < count; i++) {
    seats.push(
      await db.seat.create({
        data: { concertId, simulationRunId: runId, row: "A", number: i + 1 },
      }),
    );
  }
  return seats;
}

/** Directly wires up a HELD seat + Hold row, bypassing claimSeat, so expiry timing/sessionId can be controlled precisely. */
async function createHeldSeat(params: {
  runId: string;
  concertId: string;
  sessionId: string;
  expiresAt: Date;
}) {
  const seat = await db.seat.create({
    data: { concertId: params.concertId, simulationRunId: params.runId, row: "A", number: 1, status: SeatStatus.HELD },
  });
  const hold = await db.hold.create({
    data: { seatId: seat.id, sessionId: params.sessionId, expiresAt: params.expiresAt },
  });
  return { seat, hold };
}

describe("botSessionId / isBotSession", () => {
  it("marks a bot-derived sessionId as a bot session and a normal one as not", () => {
    const runId = "some-run-id";
    expect(isBotSession(botSessionId(runId))).toBe(true);
    expect(isBotSession(`seats-test-${crypto.randomUUID()}`)).toBe(false);
  });
});

describe("claimSeat", () => {
  it("claims an AVAILABLE seat: flips it to HELD and creates a Hold expiring HOLD_DURATION_MS later", async () => {
    const run = await createRun();
    const [seat] = await createSeats(run.id, run.concertId, 1);
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await claimSeat({ seatId: seat.id, sessionId, now });

    expect(result).toEqual({ status: "held", holdExpiresAt: new Date(now.getTime() + HOLD_DURATION_MS).toISOString() });

    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);

    const hold = await db.hold.findFirstOrThrow({ where: { seatId: seat.id } });
    expect(hold.sessionId).toBe(sessionId);
    expect(hold.releasedAt).toBeNull();
    expect(hold.expiresAt.getTime()).toBe(now.getTime() + HOLD_DURATION_MS);
  });

  it("returns a conflict without side effects when the seat is already HELD", async () => {
    const run = await createRun();
    const [seat] = await createSeats(run.id, run.concertId, 1);
    const now = new Date("2026-01-01T00:00:00.000Z");
    await claimSeat({ seatId: seat.id, sessionId: freshSessionId(), now });

    const result = await claimSeat({ seatId: seat.id, sessionId: freshSessionId(), now });

    expect(result).toEqual({
      status: "conflict",
      code: "SEAT_ALREADY_TAKEN",
      message: expect.any(String),
    });
    const holds = await db.hold.findMany({ where: { seatId: seat.id } });
    expect(holds).toHaveLength(1);
  });

  it("returns a conflict for an already-SOLD seat", async () => {
    const run = await createRun();
    const [seat] = await createSeats(run.id, run.concertId, 1);
    await db.seat.update({ where: { id: seat.id }, data: { status: SeatStatus.SOLD } });

    const result = await claimSeat({ seatId: seat.id, sessionId: freshSessionId(), now: new Date() });

    expect(result.status).toBe("conflict");
    const holds = await db.hold.findMany({ where: { seatId: seat.id } });
    expect(holds).toHaveLength(0);
  });

  it("lets exactly one of two parallel claims on the same seat succeed", async () => {
    const run = await createRun();
    const [seat] = await createSeats(run.id, run.concertId, 1);
    const now = new Date("2026-01-01T00:00:00.000Z");

    const [a, b] = await Promise.all([
      claimSeat({ seatId: seat.id, sessionId: freshSessionId(), now }),
      claimSeat({ seatId: seat.id, sessionId: freshSessionId(), now }),
    ]);

    const heldCount = [a, b].filter((r) => r.status === "held").length;
    const conflictCount = [a, b].filter((r) => r.status === "conflict").length;
    expect(heldCount).toBe(1);
    expect(conflictCount).toBe(1);

    const holds = await db.hold.findMany({ where: { seatId: seat.id } });
    expect(holds).toHaveLength(1);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
  });
});

describe("releaseExpiredHolds", () => {
  it("releases an expired hold: Seat back to AVAILABLE, Hold.releasedAt set", async () => {
    const run = await createRun();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: freshSessionId(),
      expiresAt: new Date(now.getTime() - 1000), // already expired
    });

    const result = await releaseExpiredHolds({ runId: run.id, now });

    expect(result.releasedSeatIds).toEqual([seat.id]);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.AVAILABLE);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.releasedAt?.getTime()).toBe(now.getTime());
  });

  it("leaves an unexpired hold untouched", async () => {
    const run = await createRun();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: freshSessionId(),
      expiresAt: new Date(now.getTime() + 60_000), // not expired yet
    });

    const result = await releaseExpiredHolds({ runId: run.id, now });

    expect(result.releasedSeatIds).toEqual([]);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.releasedAt).toBeNull();
  });

  it("records a hold_expired judgment event for a user session's expired hold", async () => {
    const run = await createRun();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const sessionId = freshSessionId();
    const { seat } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date(now.getTime() - 1000),
    });

    await releaseExpiredHolds({ runId: run.id, now });

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string; seatId?: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "hold_expired", seatId: seat.id });
  });

  it("does not create a SessionResult for a bot session's expired hold", async () => {
    const run = await createRun();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const botId = botSessionId(run.id);
    await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: botId,
      expiresAt: new Date(now.getTime() - 1000),
    });

    await releaseExpiredHolds({ runId: run.id, now });

    const sessionResult = await db.sessionResult.findUnique({ where: { sessionId: botId } });
    expect(sessionResult).toBeNull();
  });
});

describe("seatBelongsToRun", () => {
  it("is true for a seat that belongs to the run", async () => {
    const run = await createRun();
    const [seat] = await createSeats(run.id, run.concertId, 1);

    expect(await seatBelongsToRun({ seatId: seat.id, runId: run.id })).toBe(true);
  });

  it("is false for a seat that belongs to a different run", async () => {
    const runA = await createRun();
    const runB = await createRun();
    const [seat] = await createSeats(runA.id, runA.concertId, 1);

    expect(await seatBelongsToRun({ seatId: seat.id, runId: runB.id })).toBe(false);
  });

  it("is false for a nonexistent seatId", async () => {
    const run = await createRun();
    expect(await seatBelongsToRun({ seatId: crypto.randomUUID(), runId: run.id })).toBe(false);
  });
});

describe("listSeatMap", () => {
  it("returns every seat in the run with its current status", async () => {
    const run = await createRun();
    const [seatA, seatB] = await createSeats(run.id, run.concertId, 2);
    await claimSeat({ seatId: seatB.id, sessionId: freshSessionId(), now: new Date() });

    const map = await listSeatMap({ runId: run.id });

    expect(map).toHaveLength(2);
    expect(map.find((s) => s.id === seatA.id)?.status).toBe(SeatStatus.AVAILABLE);
    expect(map.find((s) => s.id === seatB.id)?.status).toBe(SeatStatus.HELD);
  });
});

describe("runSeatMapTick", () => {
  it("claims exactly the bot's computed claim count of available seats under the bot sessionId", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.SMALL, lastTickAt: t0 }); // SMALL botIntensity 0.1
    await createSeats(run.id, run.concertId, 10);
    const now = new Date(t0.getTime() + 10_000); // floor(0.1 * 10) = 1 claim

    const result = await runSeatMapTick({ runId: run.id, now });

    expect(result.botClaim.claimCount).toBe(1);
    const heldSeats = await db.seat.findMany({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldSeats).toHaveLength(1);
    const hold = await db.hold.findFirstOrThrow({ where: { seatId: heldSeats[0].id } });
    expect(hold.sessionId).toBe(botSessionId(run.id));
  });

  it("releases expired holds before computing the bot claim, freeing that seat for the tick", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.MEGA, lastTickAt: t0 }); // MEGA botIntensity 0.8
    const userSessionId = freshSessionId();
    const { seat } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: userSessionId,
      expiresAt: new Date(t0.getTime() - 1000), // already expired as of t0
    });
    const now = new Date(t0.getTime() + 3_600_000); // huge elapsed -> claim capped at availableSeatCount

    const result = await runSeatMapTick({ runId: run.id, now });

    expect(result.releasedSeatIds).toEqual([seat.id]);
    // Only seat in the run; it was freed by the release, then immediately reclaimed by the bot.
    expect(result.botClaim.claimCount).toBe(1);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
    const activeHold = await db.hold.findFirstOrThrow({ where: { seatId: seat.id, releasedAt: null } });
    expect(activeHold.sessionId).toBe(botSessionId(run.id));
  });

  it("bot-vs-user contention: racing runSeatMapTick against a direct user claimSeat on the run's single seat, exactly one wins", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.MEGA, lastTickAt: t0 }); // MEGA botIntensity 0.8 -> claims fast
    const [seat] = await createSeats(run.id, run.concertId, 1);
    const now = new Date(t0.getTime() + 60_000); // plenty of elapsed time, capped at the 1 available seat
    const userSessionId = freshSessionId();

    const [tickResult, userClaim] = await Promise.all([
      runSeatMapTick({ runId: run.id, now }),
      claimSeat({ seatId: seat.id, sessionId: userSessionId, now }),
    ]);

    const holds = await db.hold.findMany({ where: { seatId: seat.id, releasedAt: null } });
    expect(holds).toHaveLength(1);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);

    // Whichever side actually got the seat, the other side must have found nothing left to claim/lose.
    if (userClaim.status === "held") {
      expect(holds[0].sessionId).toBe(userSessionId);
    } else {
      expect(tickResult.botClaim.claimCount).toBeGreaterThanOrEqual(1);
      expect(holds[0].sessionId).toBe(botSessionId(run.id));
    }
  });
});
