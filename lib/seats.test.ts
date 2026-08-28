import { describe, it, expect, afterEach } from "vitest";
import { Tier, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import {
  claimSeat,
  claimSeatsBatch,
  expireStaleHolds,
  listSeatMap,
  runSeatMapTick,
  seatBelongsToRun,
  getOwnedHold,
  releaseHold,
  botSessionId,
  isBotSession,
  HOLD_DURATION_MS,
} from "@/lib/seats";
import { recordJudgmentEvent } from "@/lib/session-result";

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

async function createRun(opts: { tier?: Tier; queueOpenAt?: Date } = {}) {
  const concert = await db.concert.create({
    data: { title: "seats-test-concert", venue: "seats-test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  // D-21: queueOpenAt (not lastTickAt) is the fixed anchor computeBotClaimCount
  // measures elapsed from — see lib/tick.ts.
  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: `seats-test-owner-${crypto.randomUUID()}`,
      tier: opts.tier ?? Tier.SMALL,
      queueOpenAt: opts.queueOpenAt ?? new Date("2026-01-01T00:00:00.000Z"),
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
        data: { concertId, simulationRunId: runId, row: "1", number: i + 1 },
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
    data: { concertId: params.concertId, simulationRunId: params.runId, row: "1", number: 1, status: SeatStatus.HELD },
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

describe("expireStaleHolds", () => {
  it("marks an expired hold as no longer active but leaves the seat HELD (D-5: seat status never reverts)", async () => {
    const run = await createRun();
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: freshSessionId(),
      expiresAt: new Date(now.getTime() - 1000), // already expired
    });

    const result = await expireStaleHolds({ runId: run.id, now });

    expect(result.expiredSeatIds).toEqual([seat.id]);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
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

    const result = await expireStaleHolds({ runId: run.id, now });

    expect(result.expiredSeatIds).toEqual([]);
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

    await expireStaleHolds({ runId: run.id, now });

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

    await expireStaleHolds({ runId: run.id, now });

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
  // SMALL's real grid (25 rows x 100/row, 8 zones -> 2 bands x 4 splits,
  // see lib/seat-zones.ts's computeZoneGrid): zone "1" (band 0, split 0)
  // covers rows 1-13, numbers 1-25.
  const SMALL_GRID = { seatRows: 25, seatsPerRow: 100, zoneCount: 8 };
  // MEGA's real grid (150 x 100, 25 zones -> 5 bands x 5 splits): zone "1"
  // (band 0, split 0) covers rows 1-30, numbers 1-20.
  const MEGA_GRID = { seatRows: 150, seatsPerRow: 100, zoneCount: 25 };

  it("returns every seat within the requested zone's row/number ranges, with current status", async () => {
    const run = await createRun();
    // createSeats gives all seats row "1", numbers 1..2 — both fall in
    // zone "1" of SMALL_GRID (rows 1-13, numbers 1-25).
    const [seatA, seatB] = await createSeats(run.id, run.concertId, 2);
    await claimSeat({ seatId: seatB.id, sessionId: freshSessionId(), now: new Date() });

    const map = await listSeatMap({ runId: run.id, zone: "1", seatGrid: SMALL_GRID });

    expect(map).toHaveLength(2);
    expect(map.find((s) => s.id === seatA.id)?.status).toBe(SeatStatus.AVAILABLE);
    expect(map.find((s) => s.id === seatB.id)?.status).toBe(SeatStatus.HELD);
  });

  it("excludes seats outside the requested zone's range on either axis (D-17 2D banding)", async () => {
    const run = await createRun();
    const concertId = run.concertId;
    const inZone1 = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "10", number: 10 } }); // band 0, split 0
    const differentSplit = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "10", number: 60 } }); // same band, different split
    const differentBand = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "100", number: 10 } }); // different band, same split

    const map = await listSeatMap({ runId: run.id, zone: "1", seatGrid: MEGA_GRID });

    expect(map.map((s) => s.id)).toEqual([inZone1.id]);
    expect(map.map((s) => s.id)).not.toContain(differentSplit.id);
    expect(map.map((s) => s.id)).not.toContain(differentBand.id);
  });

  it("orders seats by row as a number (not lexicographically) so double-digit rows sort correctly", async () => {
    const run = await createRun();
    const concertId = run.concertId;
    // Same zone (all number=1, zone "1" of SMALL_GRID covers rows 1-13),
    // inserted out of numeric order — a plain string ORDER BY "row" would
    // yield "10" < "11" < "9" (lexicographic), not 9 < 10 < 11.
    const row11 = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "11", number: 1 } });
    const row9 = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "9", number: 1 } });
    const row10 = await db.seat.create({ data: { concertId, simulationRunId: run.id, row: "10", number: 1 } });

    const map = await listSeatMap({ runId: run.id, zone: "1", seatGrid: SMALL_GRID });

    expect(map.map((s) => s.id)).toEqual([row9.id, row10.id, row11.id]);
  });
});

describe("claimSeatsBatch", () => {
  it("claims exactly `count` AVAILABLE seats, flips them to HELD, and creates a Hold per seat under the given sessionId", async () => {
    const run = await createRun();
    const seats = await createSeats(run.id, run.concertId, 5);
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await claimSeatsBatch({ runId: run.id, sessionId, count: 3, now });

    expect(result.claimedSeatIds).toHaveLength(3);
    // Every claimed id is one of the run's real seats, and none appear twice.
    const seatIds = new Set(seats.map((s) => s.id));
    for (const id of result.claimedSeatIds) expect(seatIds.has(id)).toBe(true);
    expect(new Set(result.claimedSeatIds).size).toBe(3);

    const heldSeats = await db.seat.findMany({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldSeats).toHaveLength(3);
    expect(heldSeats.map((s) => s.id).sort()).toEqual([...result.claimedSeatIds].sort());

    const holds = await db.hold.findMany({ where: { seatId: { in: result.claimedSeatIds } } });
    expect(holds).toHaveLength(3);
    for (const hold of holds) {
      expect(hold.sessionId).toBe(sessionId);
      expect(hold.releasedAt).toBeNull();
      expect(hold.expiresAt.getTime()).toBe(now.getTime() + HOLD_DURATION_MS);
    }
  });

  it("caps at however many seats are actually AVAILABLE when count exceeds the pool", async () => {
    const run = await createRun();
    await createSeats(run.id, run.concertId, 4);
    const now = new Date();

    const result = await claimSeatsBatch({ runId: run.id, sessionId: freshSessionId(), count: 100, now });

    expect(result.claimedSeatIds).toHaveLength(4);
    const heldCount = await db.seat.count({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldCount).toBe(4);
  });

  it("never claims an already-HELD or -SOLD seat", async () => {
    const run = await createRun();
    const [available, held, sold] = await createSeats(run.id, run.concertId, 3);
    await db.seat.update({ where: { id: held.id }, data: { status: SeatStatus.HELD } });
    await db.seat.update({ where: { id: sold.id }, data: { status: SeatStatus.SOLD } });
    const now = new Date();

    const result = await claimSeatsBatch({ runId: run.id, sessionId: freshSessionId(), count: 10, now });

    expect(result.claimedSeatIds).toEqual([available.id]);
  });

  it("returns immediately with no DB writes when count is 0", async () => {
    const run = await createRun();
    await createSeats(run.id, run.concertId, 2);

    const result = await claimSeatsBatch({ runId: run.id, sessionId: freshSessionId(), count: 0, now: new Date() });

    expect(result.claimedSeatIds).toEqual([]);
    const heldCount = await db.seat.count({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldCount).toBe(0);
  });

  it("under concurrent batches racing the same pool, no seat is claimed twice (FOR UPDATE SKIP LOCKED)", async () => {
    const run = await createRun();
    await createSeats(run.id, run.concertId, 20);
    const now = new Date();

    const [a, b] = await Promise.all([
      claimSeatsBatch({ runId: run.id, sessionId: "batch-a", count: 15, now }),
      claimSeatsBatch({ runId: run.id, sessionId: "batch-b", count: 15, now }),
    ]);

    // Together they can't exceed the 20-seat pool, and no id appears in both.
    const combined = [...a.claimedSeatIds, ...b.claimedSeatIds];
    expect(combined.length).toBeLessThanOrEqual(20);
    expect(new Set(combined).size).toBe(combined.length);

    const heldCount = await db.seat.count({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldCount).toBe(combined.length);
  });
});

describe("runSeatMapTick", () => {
  // D-21: computeBotClaimCount's target is anchored on the tier's
  // *configured* poolSize (SimulationConfig.seatRows * seatsPerRow — 2,500
  // for SMALL, 15,000 for MEGA), not on how many Seat rows a test actually
  // creates. A small fixture pool (10 seats, 1 seat) reads as "almost
  // everything already gone" against that much larger nominal poolSize, so
  // a merely-large elapsed (as the old linear-model tests used) wouldn't
  // reliably clear that gap. A saturating elapsed (curve target ≈
  // poolSize for any tier's k) sidesteps this: at that point the bot's
  // target covers the whole configured pool, so it claims everything
  // actually AVAILABLE in the test's small fixture, regardless of the
  // mismatch.
  const SATURATING_ELAPSED_MS = 100_000_000; // ~3.2 years — target ≈ poolSize for every tier's botCurveK

  it("claims every AVAILABLE seat once the depletion curve has saturated, under the bot sessionId", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.SMALL, queueOpenAt: t0 });
    await createSeats(run.id, run.concertId, 10);
    const now = new Date(t0.getTime() + SATURATING_ELAPSED_MS);

    const result = await runSeatMapTick({ runId: run.id, now });

    expect(result.botClaim.claimCount).toBe(10);
    const heldSeats = await db.seat.findMany({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldSeats).toHaveLength(10);
    const holds = await db.hold.findMany({ where: { seatId: { in: heldSeats.map((s) => s.id) } } });
    expect(holds).toHaveLength(10);
    for (const hold of holds) expect(hold.sessionId).toBe(botSessionId(run.id));
  });

  it("marks an expired hold's Hold row but does NOT free its seat for the bot to reclaim (D-5)", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.MEGA, queueOpenAt: t0 });
    const userSessionId = freshSessionId();
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: userSessionId,
      expiresAt: new Date(t0.getTime() - 1000), // already expired as of t0
    });
    const now = new Date(t0.getTime() + SATURATING_ELAPSED_MS); // huge elapsed, but no seats are AVAILABLE

    const result = await runSeatMapTick({ runId: run.id, now });

    expect(result.expiredSeatIds).toEqual([seat.id]);
    // Only seat in the run stays HELD by its original owner — no AVAILABLE
    // seats exist for the bot to claim, regardless of elapsed time/curve.
    expect(result.botClaim.claimCount).toBe(0);
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.sessionId).toBe(userSessionId);
    expect(persistedHold.releasedAt?.getTime()).toBe(now.getTime());
  });

  it("under two concurrent ticks racing the same run (React Strict Mode double-invoke, or two tabs), the combined bot claim does not overshoot the curve's target for that elapsed", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.SMALL, queueOpenAt: t0 });

    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.SMALL } });
    const poolSize = config.seatRows * config.seatsPerRow;
    // Real full-size pool (not a small fixture) — a smaller fixture would
    // let claimSeatsBatch's own AVAILABLE-row cap mask the race (both
    // ticks would just split whatever's left), so this needs enough real
    // headroom for two independently-computed claims to actually overshoot
    // if unfixed.
    const rowLabels = Array.from({ length: config.seatRows }, (_, i) => String(i + 1));
    await db.seat.createMany({
      data: rowLabels.flatMap((row) =>
        Array.from({ length: config.seatsPerRow }, (_, i) => ({
          concertId: run.concertId,
          simulationRunId: run.id,
          row,
          number: i + 1,
        })),
      ),
    });

    // Elapsed chosen so the curve's target is ~25% of the pool: enough gap
    // below poolSize that two concurrent claims of ~25% each (50% combined)
    // stay well under 100%, so an unfixed race's overshoot wouldn't be
    // masked by simply running out of AVAILABLE seats.
    const targetFraction = 0.25;
    const rawElapsedSeconds = -Math.log(1 - targetFraction) / config.botCurveK;
    const now = new Date(t0.getTime() + rawElapsedSeconds * 1000);
    // Mirrors computeElapsedTime's own ms->seconds rounding (lib/simulation.ts)
    // so this matches exactly what advanceTick will compute, not the
    // pre-rounding float above.
    const actualElapsedSeconds = (now.getTime() - t0.getTime()) / 1000;
    const expectedTarget = Math.floor(poolSize * (1 - Math.exp(-config.botCurveK * actualElapsedSeconds)));

    await Promise.all([runSeatMapTick({ runId: run.id, now }), runSeatMapTick({ runId: run.id, now })]);

    const heldCount = await db.seat.count({ where: { simulationRunId: run.id, status: SeatStatus.HELD } });
    expect(heldCount).toBe(expectedTarget);
  });

  it("bot-vs-user contention: racing runSeatMapTick against a direct user claimSeat on the run's single seat, exactly one wins", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun({ tier: Tier.MEGA, queueOpenAt: t0 });
    const [seat] = await createSeats(run.id, run.concertId, 1);
    const now = new Date(t0.getTime() + SATURATING_ELAPSED_MS); // curve fully saturated -> bot attempts the one available seat
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

describe("getOwnedHold", () => {
  it("returns the session's active hold with its seat info", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const expiresAt = new Date("2026-01-01T00:05:00.000Z");
    const { seat, hold } = await createHeldSeat({ runId: run.id, concertId: run.concertId, sessionId, expiresAt });

    const result = await getOwnedHold({ sessionId, runId: run.id });

    expect(result).toEqual({ holdId: hold.id, seatId: seat.id, row: seat.row, number: seat.number, expiresAt });
  });

  it("returns null when the session has no active hold", async () => {
    const run = await createRun();
    expect(await getOwnedHold({ sessionId: freshSessionId(), runId: run.id })).toBeNull();
  });

  it("returns null for a hold already released, even if it belongs to the session", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const { hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });
    await db.hold.update({ where: { id: hold.id }, data: { releasedAt: new Date() } });

    expect(await getOwnedHold({ sessionId, runId: run.id })).toBeNull();
  });

  it("does not return another session's hold on the same run", async () => {
    const run = await createRun();
    await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId: freshSessionId(),
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    expect(await getOwnedHold({ sessionId: freshSessionId(), runId: run.id })).toBeNull();
  });
});

describe("releaseHold", () => {
  it("ends the session's active hold but leaves the seat HELD (D-5: no seat release), Hold.releasedAt set", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:02:00.000Z");
    const { seat, hold } = await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"), // not expired yet — explicit release doesn't care
    });

    const result = await releaseHold({ sessionId, runId: run.id, now });

    expect(result).toEqual({ released: true });
    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);
    const persistedHold = await db.hold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(persistedHold.releasedAt?.getTime()).toBe(now.getTime());
  });

  it("is a no-op returning released:false when the session has no active hold", async () => {
    const run = await createRun();
    const result = await releaseHold({ sessionId: freshSessionId(), runId: run.id, now: new Date() });
    expect(result).toEqual({ released: false });
  });

  it("records payment_abandoned when the session's last payment-stage event was payment_error", async () => {
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
      errorType: "timeout",
      timestamp: now.toISOString(),
    });

    await releaseHold({ sessionId, runId: run.id, now });

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events.filter((e) => e.type === "payment_abandoned")).toHaveLength(1);
  });

  it("does not record payment_abandoned when there was no prior payment_error", async () => {
    const run = await createRun();
    const sessionId = freshSessionId();
    await createHeldSeat({
      runId: run.id,
      concertId: run.concertId,
      sessionId,
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
    });

    await releaseHold({ sessionId, runId: run.id, now: new Date() });

    const sessionResult = await db.sessionResult.findUnique({ where: { sessionId } });
    const events = (sessionResult?.events ?? []) as unknown as Array<{ type: string }>;
    expect(events.some((e) => e.type === "payment_abandoned")).toBe(false);
  });
});
