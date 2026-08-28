import { describe, it, expect, afterEach } from "vitest";
import { Tier } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { advanceTick } from "@/lib/tick";

const db = getTestDb();
const createdRunIds: string[] = [];

afterEach(async () => {
  if (createdRunIds.length === 0) return;
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

describe("advanceTick (D-21: elapsed anchored on queueOpenAt, not lastTickAt)", () => {
  it("computes the bot claim from elapsed since queueOpenAt, using the tier's poolSize/botCurveK", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0); // SMALL: seatRows*seatsPerRow=2500, botCurveK small

    const now = new Date(t0.getTime() + 60_000); // +60s
    const result = await advanceTick({ runId: run.id, now, availableSeatCount: 2500 });

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

    const result = await advanceTick({
      runId: run.id,
      now: new Date(t0.getTime() + 3_600_000), // +1h -> curve target is essentially the whole pool
      availableSeatCount: 5,
    });

    expect(result.botClaim.claimCount).toBe(5);
  });

  it("is unaffected by tick history: the same (queueOpenAt, now, availableSeatCount) always yields the same claim, whether reached in one tick or several", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const runOneTick = await createRun(Tier.MEDIUM, t0);
    const runManyTicks = await createRun(Tier.MEDIUM, t0);
    const now = new Date(t0.getTime() + 30_000);

    const oneTick = await advanceTick({ runId: runOneTick.id, now, availableSeatCount: 7000 });

    // Simulate several earlier ticks having already run for the other run —
    // queueOpenAt never changes, so this only shows up as a smaller
    // availableSeatCount by the time `now` is reached.
    await advanceTick({ runId: runManyTicks.id, now: new Date(t0.getTime() + 10_000), availableSeatCount: 7000 });
    const manyTicksFinal = await advanceTick({ runId: runManyTicks.id, now, availableSeatCount: 7000 - 1 });

    // Both converge on the same total claimed-by-`now`, regardless of how
    // many ticks it took to get there (D-21: absolute target, not a
    // per-tick delta) — the extra `1` already claimed by the first of the
    // two ticks plus this tick's claim should equal the one-shot claim.
    expect(1 + manyTicksFinal.botClaim.claimCount).toBe(oneTick.botClaim.claimCount);
  });

  it("is deterministic: two runs of the same tier with the same queueOpenAt and now yield the same claim", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const runA = await createRun(Tier.MEDIUM, t0);
    const runB = await createRun(Tier.MEDIUM, t0);
    const now = new Date(t0.getTime() + 20_000);

    const resultA = await advanceTick({ runId: runA.id, now, availableSeatCount: 7000 });
    const resultB = await advanceTick({ runId: runB.id, now, availableSeatCount: 7000 });

    expect(resultA.botClaim.claimCount).toBe(resultB.botClaim.claimCount);
    expect(resultA.elapsedSeconds).toBe(resultB.elapsedSeconds);
  });

  it("returns 0 claim at elapsed 0 (queueOpenAt == now)", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.MEGA, t0);

    const result = await advanceTick({ runId: run.id, now: t0, availableSeatCount: 15_000 });

    expect(result.botClaim.claimCount).toBe(0);
  });
});
