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

describe("computeBotClaimCount", () => {
  it("floors botIntensity * elapsed.seconds", () => {
    const result = computeBotClaimCount({
      elapsed: { ms: 10000, seconds: 10 },
      botIntensity: 0.35,
      availableSeatCount: 100,
    });
    // 0.35 * 10 = 3.5 -> floor 3
    expect(result.claimCount).toBe(3);
  });

  it("returns 0 when elapsed is 0", () => {
    const result = computeBotClaimCount({
      elapsed: { ms: 0, seconds: 0 },
      botIntensity: 0.8,
      availableSeatCount: 100,
    });
    expect(result.claimCount).toBe(0);
  });

  it("returns 0 when botIntensity is 0, even with large elapsed", () => {
    const result = computeBotClaimCount({
      elapsed: { ms: 3_600_000, seconds: 3600 },
      botIntensity: 0,
      availableSeatCount: 100,
    });
    expect(result.claimCount).toBe(0);
  });

  it("caps claimCount at availableSeatCount when intensity/elapsed is very large", () => {
    const result = computeBotClaimCount({
      elapsed: { ms: 3_600_000, seconds: 3600 },
      botIntensity: 0.8,
      availableSeatCount: 5,
    });
    expect(result.claimCount).toBe(5);
  });

  it("returns 0 when there are no available seats", () => {
    const result = computeBotClaimCount({
      elapsed: { ms: 10000, seconds: 10 },
      botIntensity: 0.8,
      availableSeatCount: 0,
    });
    expect(result.claimCount).toBe(0);
  });

  it("is deterministic: same input always yields same output", () => {
    const input = { elapsed: { ms: 4200, seconds: 4.2 }, botIntensity: 0.4, availableSeatCount: 50 };
    const first = computeBotClaimCount(input);
    const second = computeBotClaimCount(input);
    expect(first).toEqual(second);
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
