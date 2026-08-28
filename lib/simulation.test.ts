import { describe, it, expect } from "vitest";
import {
  computeElapsedTime,
  computeBotClaimCount,
  computeQueuePosition,
  findExpiredHolds,
} from "@/lib/simulation";

describe("computeElapsedTime", () => {
  it("computes ms/seconds between since and now", () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:00:05.000Z");
    expect(computeElapsedTime({ since, now })).toEqual({ ms: 5000, seconds: 5 });
  });

  it("clamps negative elapsed (clock skew) to 0", () => {
    const since = new Date("2026-01-01T00:00:05.000Z");
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeElapsedTime({ since, now })).toEqual({ ms: 0, seconds: 0 });
  });
});

describe("computeBotClaimCount (D-21: front-loaded exponential-approach curve)", () => {
  it("targets floor(poolSize * (1 - e^-(k*elapsedSinceOpen))), minus seats already claimed", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 60_000, seconds: 60 },
      botCurveK: 0.01,
      poolSize: 1000,
      availableSeatCount: 1000, // nothing claimed yet
    });
    // target = floor(1000 * (1 - e^-0.6)) = floor(1000 * 0.451188...) = 451
    expect(result.claimCount).toBe(451);
  });

  it("returns 0 when elapsedSinceOpen is 0 (target is 0 regardless of k)", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 0, seconds: 0 },
      botCurveK: 0.05,
      poolSize: 1000,
      availableSeatCount: 1000,
    });
    expect(result.claimCount).toBe(0);
  });

  it("returns 0 when botCurveK is 0, even with very large elapsed (curve never rises)", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 3_600_000, seconds: 3600 },
      botCurveK: 0,
      poolSize: 1000,
      availableSeatCount: 1000,
    });
    expect(result.claimCount).toBe(0);
  });

  it("only claims the gap to the target — seats already gone (poolSize - availableSeatCount) count toward it", () => {
    // target at t=60,k=0.01 over pool 1000 is 451 (see first test). If 500
    // are already gone (more than the target), there's no gap: claim 0.
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 60_000, seconds: 60 },
      botCurveK: 0.01,
      poolSize: 1000,
      availableSeatCount: 500, // 500 already claimed
    });
    expect(result.claimCount).toBe(0);
  });

  it("caps claimCount at availableSeatCount when the target-minus-claimed gap exceeds what's left", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 3_600_000, seconds: 3600 }, // huge elapsed -> target ~poolSize
      botCurveK: 0.05,
      poolSize: 1000,
      availableSeatCount: 5,
    });
    expect(result.claimCount).toBe(5);
  });

  it("returns 0 when there are no available seats", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 10_000, seconds: 10 },
      botCurveK: 0.05,
      poolSize: 1000,
      availableSeatCount: 0,
    });
    expect(result.claimCount).toBe(0);
  });

  it("never exceeds poolSize as elapsed grows arbitrarily large", () => {
    const result = computeBotClaimCount({
      elapsedSinceOpen: { ms: 100_000_000, seconds: 100_000 },
      botCurveK: 0.05,
      poolSize: 1000,
      availableSeatCount: 1000,
    });
    expect(result.claimCount).toBeLessThanOrEqual(1000);
    // The curve should have essentially saturated by now.
    expect(result.claimCount).toBeGreaterThan(990);
  });

  it("front-loads: the claim target for an early window is more than half the target for double that elapsed (steeper at the start)", () => {
    const early = computeBotClaimCount({
      elapsedSinceOpen: { ms: 15_000, seconds: 15 },
      botCurveK: 0.034,
      poolSize: 15_000,
      availableSeatCount: 15_000,
    });
    const later = computeBotClaimCount({
      elapsedSinceOpen: { ms: 30_000, seconds: 30 },
      botCurveK: 0.034,
      poolSize: 15_000,
      availableSeatCount: 15_000,
    });
    // Linear would give exactly half; exponential-approach gives strictly more than half.
    expect(early.claimCount).toBeGreaterThan(later.claimCount / 2);
    expect(early.claimCount).toBeLessThan(later.claimCount);
  });

  it("is deterministic: same input always yields same output", () => {
    const input = {
      elapsedSinceOpen: { ms: 4200, seconds: 4.2 },
      botCurveK: 0.02,
      poolSize: 2500,
      availableSeatCount: 2000,
    };
    const first = computeBotClaimCount(input);
    const second = computeBotClaimCount(input);
    expect(first).toEqual(second);
  });

  it("is deterministic across different tick histories: only elapsedSinceOpen (not how many prior ticks happened) determines the target", () => {
    // Two different "already claimed" starting points that both happen to
    // sit below the target at this elapsed converge to the same total
    // claimed-by-now once each tops up to the target.
    const config = { elapsedSinceOpen: { ms: 20_000, seconds: 20 }, botCurveK: 0.03, poolSize: 5000 };
    const fromFewerTicks = computeBotClaimCount({ ...config, availableSeatCount: 5000 }); // 0 claimed so far
    const fromMoreTicks = computeBotClaimCount({ ...config, availableSeatCount: 4900 }); // 100 already claimed by an earlier tick
    const target = Math.floor(5000 * (1 - Math.exp(-0.03 * 20)));
    expect(fromFewerTicks.claimCount).toBe(target);
    expect(100 + fromMoreTicks.claimCount).toBe(target);
  });
});

describe("computeQueuePosition", () => {
  it("decrements position by admissionRatePerSec * elapsed.seconds", () => {
    const result = computeQueuePosition({
      elapsed: { ms: 5000, seconds: 5 },
      admissionRatePerSec: 10,
      initialPosition: 100,
    });
    expect(result.position).toBe(50);
    expect(result.admitted).toBe(false);
  });

  it("clamps position at 0 and reports admitted once reached", () => {
    const result = computeQueuePosition({
      elapsed: { ms: 60_000, seconds: 60 },
      admissionRatePerSec: 10,
      initialPosition: 100,
    });
    expect(result.position).toBe(0);
    expect(result.admitted).toBe(true);
  });

  it("reports admitted exactly at position 0", () => {
    const result = computeQueuePosition({
      elapsed: { ms: 10_000, seconds: 10 },
      admissionRatePerSec: 10,
      initialPosition: 100,
    });
    expect(result.position).toBe(0);
    expect(result.admitted).toBe(true);
  });

  it("is deterministic: same input always yields same output", () => {
    const input = { elapsed: { ms: 3000, seconds: 3 }, admissionRatePerSec: 5, initialPosition: 42 };
    expect(computeQueuePosition(input)).toEqual(computeQueuePosition(input));
  });
});

describe("findExpiredHolds", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");

  it("returns empty for an empty input", () => {
    expect(findExpiredHolds({ holds: [], now })).toEqual({ expired: [] });
  });

  it("filters only holds with expiresAt < now", () => {
    const holds = [
      { id: "h1", seatId: "s1", expiresAt: new Date("2026-01-01T00:05:00.000Z") }, // expired
      { id: "h2", seatId: "s2", expiresAt: new Date("2026-01-01T00:15:00.000Z") }, // not expired
    ];
    expect(findExpiredHolds({ holds, now })).toEqual({
      expired: [{ holdId: "h1", seatId: "s1" }],
    });
  });

  it("returns all holds when all are expired", () => {
    const holds = [
      { id: "h1", seatId: "s1", expiresAt: new Date("2026-01-01T00:01:00.000Z") },
      { id: "h2", seatId: "s2", expiresAt: new Date("2026-01-01T00:02:00.000Z") },
    ];
    const result = findExpiredHolds({ holds, now });
    expect(result.expired).toHaveLength(2);
  });

  it("returns none when none are expired", () => {
    const holds = [{ id: "h1", seatId: "s1", expiresAt: new Date("2026-01-01T00:20:00.000Z") }];
    expect(findExpiredHolds({ holds, now })).toEqual({ expired: [] });
  });

  it("is deterministic: same input always yields same output", () => {
    const holds = [{ id: "h1", seatId: "s1", expiresAt: new Date("2026-01-01T00:05:00.000Z") }];
    const input = { holds, now };
    expect(findExpiredHolds(input)).toEqual(findExpiredHolds(input));
  });
});
