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

async function createRun(tier: Tier, lastTickAt: Date) {
  const concert = await db.concert.findFirstOrThrow();
  const run = await db.simulationRun.create({
    data: { concertId: concert.id, sessionId: `tick-test-${crypto.randomUUID()}`, tier, lastTickAt },
  });
  createdRunIds.push(run.id);
  return run;
}

describe("advanceTick", () => {
  it("advances lastTickAt and computes the bot claim for a run's tier", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0); // SMALL: botIntensity 0.1

    const result = await advanceTick({
      runId: run.id,
      now: new Date(t0.getTime() + 10_000), // +10s -> floor(0.1 * 10) = 1
      availableSeatCount: 100,
    });

    expect(result.botClaim.claimCount).toBe(1);
    expect(result.previousLastTickAt.getTime()).toBe(t0.getTime());
    expect(result.newLastTickAt.getTime()).toBe(t0.getTime() + 10_000);

    const persisted = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.lastTickAt.getTime()).toBe(t0.getTime() + 10_000);
  });

  it("caps the bot claim at availableSeatCount", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.MEGA, t0); // MEGA: botIntensity 0.8

    const result = await advanceTick({
      runId: run.id,
      now: new Date(t0.getTime() + 3_600_000), // +1h -> uncapped would be huge
      availableSeatCount: 5,
    });

    expect(result.botClaim.claimCount).toBe(5);
  });

  it("carries fractional bot progress forward across short ticks instead of losing it", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0); // botIntensity 0.1 -> needs 10s of elapsed per seat

    // +3s: 0.1 * 3 = 0.3 -> floors to 0. lastTickAt must NOT advance, or the
    // remaining 0.3 seats worth of progress would be silently dropped.
    const first = await advanceTick({ runId: run.id, now: new Date(t0.getTime() + 3_000), availableSeatCount: 100 });
    expect(first.botClaim.claimCount).toBe(0);
    expect(first.newLastTickAt.getTime()).toBe(t0.getTime());

    // +9s from t0 (total): 0.1 * 9 = 0.9 -> still floors to 0.
    const second = await advanceTick({ runId: run.id, now: new Date(t0.getTime() + 9_000), availableSeatCount: 100 });
    expect(second.botClaim.claimCount).toBe(0);
    expect(second.newLastTickAt.getTime()).toBe(t0.getTime());

    // +11s from t0 (total): 0.1 * 11 = 1.1 -> floors to 1, matching the
    // cumulative target exactly (no loss across the three short ticks).
    const third = await advanceTick({ runId: run.id, now: new Date(t0.getTime() + 11_000), availableSeatCount: 100 });
    expect(third.botClaim.claimCount).toBe(1);
    expect(third.newLastTickAt.getTime()).toBe(t0.getTime() + 10_000);
  });

  it("is deterministic: repeated calls with the same now on an unadvanced run yield the same claim", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const runA = await createRun(Tier.MEDIUM, t0);
    const runB = await createRun(Tier.MEDIUM, t0);
    const now = new Date(t0.getTime() + 20_000);

    const resultA = await advanceTick({ runId: runA.id, now, availableSeatCount: 100 });
    const resultB = await advanceTick({ runId: runB.id, now, availableSeatCount: 100 });

    expect(resultA.botClaim.claimCount).toBe(resultB.botClaim.claimCount);
    expect(resultA.elapsedSeconds).toBe(resultB.elapsedSeconds);
  });

  it("serializes concurrent ticks on the same run instead of double-counting the elapsed window", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const run = await createRun(Tier.SMALL, t0); // botIntensity 0.1
    const now = new Date(t0.getTime() + 10_000); // a single tick over this span claims exactly 1 seat

    const [first, second] = await Promise.all([
      advanceTick({ runId: run.id, now, availableSeatCount: 100 }), //first
      advanceTick({ runId: run.id, now, availableSeatCount: 100 }), // second
    ]);

    // Serialization proof: the two calls must not have read the same
    // previousLastTickAt baseline (that would mean both saw the full 10s
    // window and could double-claim). One reads t0, the other reads
    // whatever the first call already advanced it to.
    const baselines = [first.previousLastTickAt.getTime(), second.previousLastTickAt.getTime()].sort();
    expect(baselines[0]).toBe(t0.getTime());
    expect(baselines[1]).toBeGreaterThanOrEqual(t0.getTime());

    // Total seats claimed across both calls must match what one tick over
    // the whole 10s span would produce (1), not double it.
    expect(first.botClaim.claimCount + second.botClaim.claimCount).toBe(1);

    const persisted = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.lastTickAt.getTime()).toBe(t0.getTime() + 10_000);
  });
});
