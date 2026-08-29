import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { Tier, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { advanceTick } from "@/lib/tick";

const db = getTestDb();
const createdRunIds: string[] = [];

afterEach(async () => {
  if (createdRunIds.length === 0) return;
  await db.hold.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
  await db.seat.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
  await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  createdRunIds.length = 0;
});

async function createRun(tier: Tier, queueOpenAt: Date) {
  const concert = await db.concert.findFirstOrThrow();
  const run = await db.simulationRun.create({
    data: { concertId: concert.id, sessionId: `tick-test-${crypto.randomUUID()}`, tier, queueOpenAt },
  });
  createdRunIds.push(run.id);
  return run;
}

/** Creates `count` AVAILABLE seats for a run — advanceTick (D-22) reads availableSeatCount from real Seat rows, not a caller-supplied number. */
async function createSeats(run: { id: string; concertId: string }, count: number) {
  await db.seat.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      concertId: run.concertId,
      simulationRunId: run.id,
      row: "1",
      number: i + 1,
    })),
  });
}

function withTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

// Curve target ≈ poolSize regardless of tier/botCurveK (mirrors
// lib/seats.test.ts's SATURATING_ELAPSED_MS) — lets several of the tests
// below use a small fixture pool instead of a tier's full real poolSize
// (up to 15,000 rows), keeping the suite's DB load down.
const SATURATING_ELAPSED_MS = 100_000_000; // ~3.2 years

describe("advanceTick (D-21: elapsed anchored on queueOpenAt, not lastTickAt; D-22: locked tx, real availableSeatCount)", () => {
  it("computes the bot claim from elapsed since queueOpenAt, using the tier's poolSize/botCurveK", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0); // SMALL: seatRows*seatsPerRow=2500, botCurveK small
    await createSeats(run, 2500);

    const now = new Date(t0.getTime() + 60_000); // +60s
    const result = await withTx((tx) => advanceTick({ runId: run.id, now, tx }));

    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.SMALL } });
    const poolSize = config.seatRows * config.seatsPerRow;
    const expectedClaim = Math.floor(poolSize * (1 - Math.exp(-config.botCurveK * 60)));

    expect(result.elapsedSeconds).toBe(60);
    expect(result.queueOpenAt.getTime()).toBe(t0.getTime());
    expect(result.botClaim.claimCount).toBe(expectedClaim);
  });

  it("caps the bot claim at availableSeatCount", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.MEGA, t0);
    await createSeats(run, 5);

    const result = await withTx((tx) =>
      advanceTick({
        runId: run.id,
        now: new Date(t0.getTime() + SATURATING_ELAPSED_MS), // curve target is essentially the whole pool
        tx,
      }),
    );

    expect(result.botClaim.claimCount).toBe(5);
  });

  it("is unaffected by tick history: the same (queueOpenAt, now, real available seats) always yields the same total claimed, whether reached in one tick or several", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const runOneTick = await createRun(Tier.MEDIUM, t0);
    const runManyTicks = await createRun(Tier.MEDIUM, t0);
    const now = new Date(t0.getTime() + SATURATING_ELAPSED_MS);
    // Small fixture, saturating elapsed: the "1 already claimed" relation
    // this test checks holds regardless of fixture size once the curve
    // target is capped at whatever's actually AVAILABLE (proof in D-22's
    // commit message / ROADMAP) — no need for MEDIUM's real 7,000-seat pool.
    await createSeats(runOneTick, 20);
    await createSeats(runManyTicks, 20);

    const oneTick = await withTx((tx) => advanceTick({ runId: runOneTick.id, now, tx }));

    // Simulate an earlier tick having already claimed 1 seat on the other
    // run — queueOpenAt never changes, so by the time `now` is reached this
    // only shows up as a smaller real availableSeatCount.
    const [earlySeat] = await db.seat.findMany({ where: { simulationRunId: runManyTicks.id }, take: 1 });
    await db.seat.update({ where: { id: earlySeat.id }, data: { status: SeatStatus.HELD } });
    const manyTicksFinal = await withTx((tx) => advanceTick({ runId: runManyTicks.id, now, tx }));

    // Both converge on the same total claimed-by-`now`, regardless of how
    // many ticks it took to get there (D-21: absolute target, not a
    // per-tick delta) — the 1 already claimed earlier plus this tick's
    // claim should equal the one-shot claim.
    expect(1 + manyTicksFinal.botClaim.claimCount).toBe(oneTick.botClaim.claimCount);
  });

  it("is deterministic: two runs of the same tier with the same queueOpenAt and now yield the same claim", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const runA = await createRun(Tier.MEDIUM, t0);
    const runB = await createRun(Tier.MEDIUM, t0);
    const now = new Date(t0.getTime() + SATURATING_ELAPSED_MS);
    await createSeats(runA, 20);
    await createSeats(runB, 20);

    const resultA = await withTx((tx) => advanceTick({ runId: runA.id, now, tx }));
    const resultB = await withTx((tx) => advanceTick({ runId: runB.id, now, tx }));

    expect(resultA.botClaim.claimCount).toBe(resultB.botClaim.claimCount);
    expect(resultA.elapsedSeconds).toBe(resultB.elapsedSeconds);
  });

  it("returns 0 claim at elapsed 0 (queueOpenAt == now)", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.MEGA, t0);
    await createSeats(run, 1);

    const result = await withTx((tx) => advanceTick({ runId: run.id, now: t0, tx }));

    expect(result.botClaim.claimCount).toBe(0);
  });

  it("under two concurrent locked-tx calls for the same run, the second sees the first's committed claim instead of a stale availableSeatCount (D-22)", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0);
    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.SMALL } });
    await createSeats(run, config.seatRows * config.seatsPerRow);

    const now = new Date(t0.getTime() + 60_000);

    // Two concurrent transactions, each locking the SimulationRun row and
    // claiming (outside advanceTick itself, but simulating runSeatMapTick's
    // combined transaction) the seats advanceTick says to claim, before
    // committing — this proves the lock actually serializes on commit, not
    // just on the SELECT.
    async function lockClaimAndCommit() {
      return prisma.$transaction(async (tx) => {
        const result = await advanceTick({ runId: run.id, now, tx });
        if (result.botClaim.claimCount > 0) {
          const seats = await tx.seat.findMany({
            where: { simulationRunId: run.id, status: SeatStatus.AVAILABLE },
            take: result.botClaim.claimCount,
          });
          await tx.seat.updateMany({
            where: { id: { in: seats.map((s) => s.id) } },
            data: { status: SeatStatus.HELD },
          });
        }
        return result.botClaim.claimCount;
      });
    }

    const [first, second] = await Promise.all([lockClaimAndCommit(), lockClaimAndCommit()]);

    const expectedTotal = Math.floor(config.seatRows * config.seatsPerRow * (1 - Math.exp(-config.botCurveK * 60)));
    expect(first + second).toBe(expectedTotal);
  });
});
