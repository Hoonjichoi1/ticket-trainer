// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { Tier, SeatStatus, SimulationRunStatus, SessionOutcome, type JudgmentEvent } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { recordJudgmentEvent, recordStageEntered, recordStageExited } from "@/lib/session-result";
import { determineOutcome, evaluateBenchmarks, buildFeedback, aggregateSessionResult, TIER_BENCHMARKS } from "@/lib/result";

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
  const id = `result-test-${crypto.randomUUID()}`;
  createdSessionIds.push(id);
  return id;
}

async function createRun(params: { sessionId: string; tier?: Tier; status?: SimulationRunStatus }) {
  const concert = await db.concert.create({
    data: { title: "result-test-concert", venue: "result-test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: params.sessionId,
      tier: params.tier ?? Tier.SMALL,
      status: params.status ?? SimulationRunStatus.ACTIVE,
      lastTickAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);
  return run;
}

// ---------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------

describe("determineOutcome", () => {
  it("returns SUCCESS whenever hasBooking is true, regardless of events", () => {
    const events: JudgmentEvent[] = [
      { type: "hold_expired", stage: "payment", seatId: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    expect(determineOutcome({ hasBooking: true, events })).toBe(SessionOutcome.SUCCESS);
  });

  it("returns PAYMENT_FAILED when a payment_abandoned event is present", () => {
    const events: JudgmentEvent[] = [{ type: "payment_abandoned", stage: "payment", timestamp: "2026-01-01T00:00:00.000Z" }];
    expect(determineOutcome({ hasBooking: false, events })).toBe(SessionOutcome.PAYMENT_FAILED);
  });

  it("returns SEAT_LOST when a hold_expired event is present and no payment_abandoned", () => {
    const events: JudgmentEvent[] = [
      { type: "hold_expired", stage: "booking_info", seatId: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    expect(determineOutcome({ hasBooking: false, events })).toBe(SessionOutcome.SEAT_LOST);
  });

  it("returns ABANDONED when none of the above signals are present", () => {
    const events: JudgmentEvent[] = [
      { type: "queue_reset", stage: "queue", timestamp: "2026-01-01T00:00:00.000Z", positionBeforeReset: 10 },
    ];
    expect(determineOutcome({ hasBooking: false, events })).toBe(SessionOutcome.ABANDONED);
    expect(determineOutcome({ hasBooking: false, events: [] })).toBe(SessionOutcome.ABANDONED);
  });

  it("prioritizes payment_abandoned over hold_expired if both were somehow present", () => {
    const events: JudgmentEvent[] = [
      { type: "hold_expired", stage: "payment", seatId: "s1", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "payment_abandoned", stage: "payment", timestamp: "2026-01-01T00:00:01.000Z" },
    ];
    expect(determineOutcome({ hasBooking: false, events })).toBe(SessionOutcome.PAYMENT_FAILED);
  });
});

describe("evaluateBenchmarks", () => {
  it("returns no feedback when both totalMs and contentionLosses are within the tier's benchmark", () => {
    const items = evaluateBenchmarks({
      tier: Tier.SMALL,
      stageTimings: { queue: { enteredAt: "t", exitedAt: "t", durationMs: 1000 } },
      contentionLosses: 0,
    });
    expect(items).toEqual([]);
  });

  it("adds slow_total_time exactly when total duration exceeds the tier's target (boundary: equal does not count)", () => {
    const { targetTotalMs } = TIER_BENCHMARKS[Tier.SMALL];
    const atBoundary = evaluateBenchmarks({
      tier: Tier.SMALL,
      stageTimings: { queue: { enteredAt: "t", exitedAt: "t", durationMs: targetTotalMs } },
      contentionLosses: 0,
    });
    expect(atBoundary.some((item) => item.eventType === "slow_total_time")).toBe(false);

    const overBoundary = evaluateBenchmarks({
      tier: Tier.SMALL,
      stageTimings: { queue: { enteredAt: "t", exitedAt: "t", durationMs: targetTotalMs + 1 } },
      contentionLosses: 0,
    });
    expect(overBoundary.some((item) => item.eventType === "slow_total_time")).toBe(true);
  });

  it("adds high_contention_losses exactly when contentionLosses exceeds the tier's max (boundary: equal does not count)", () => {
    const { maxContentionLosses } = TIER_BENCHMARKS[Tier.SMALL];
    const atBoundary = evaluateBenchmarks({ tier: Tier.SMALL, stageTimings: {}, contentionLosses: maxContentionLosses });
    expect(atBoundary.some((item) => item.eventType === "high_contention_losses")).toBe(false);

    const overBoundary = evaluateBenchmarks({
      tier: Tier.SMALL,
      stageTimings: {},
      contentionLosses: maxContentionLosses + 1,
    });
    expect(overBoundary.some((item) => item.eventType === "high_contention_losses")).toBe(true);
  });
});

describe("buildFeedback", () => {
  it("returns [] when there are no events and no benchmark feedback", () => {
    expect(buildFeedback({ events: [], benchmarkFeedback: [] })).toEqual([]);
  });

  it("folds repeated queue_reset events into a single item mentioning the count", () => {
    const events: JudgmentEvent[] = [
      { type: "queue_reset", stage: "queue", timestamp: "t1", positionBeforeReset: 10 },
      { type: "queue_reset", stage: "queue", timestamp: "t2", positionBeforeReset: 5 },
    ];
    const items = buildFeedback({ events, benchmarkFeedback: [] });
    expect(items).toHaveLength(1);
    expect(items[0].eventType).toBe("queue_reset");
    expect(items[0].message).toContain("2");
  });

  it("emits a positive item when payment_error is followed by payment_retry_success", () => {
    const events: JudgmentEvent[] = [
      { type: "payment_error", stage: "payment", timestamp: "t1", errorType: "timeout" },
      { type: "payment_retry_success", stage: "payment", timestamp: "t2" },
    ];
    const items = buildFeedback({ events, benchmarkFeedback: [] });
    expect(items.map((i) => i.eventType)).toContain("payment_retry_success");
    expect(items.some((i) => i.eventType === "payment_abandoned")).toBe(false);
  });

  it("emits a corrective item when payment_error is followed by payment_abandoned", () => {
    const events: JudgmentEvent[] = [
      { type: "payment_error", stage: "payment", timestamp: "t1", errorType: "server_error" },
      { type: "payment_abandoned", stage: "payment", timestamp: "t2" },
    ];
    const items = buildFeedback({ events, benchmarkFeedback: [] });
    expect(items.map((i) => i.eventType)).toContain("payment_abandoned");
    expect(items.some((i) => i.eventType === "payment_retry_success")).toBe(false);
  });

  it("includes hold_expired feedback and appends benchmark feedback last", () => {
    const events: JudgmentEvent[] = [
      { type: "hold_expired", stage: "payment", seatId: "s1", timestamp: "t1" },
    ];
    const benchmarkFeedback = [{ eventType: "slow_total_time" as const, message: "slow" }];
    const items = buildFeedback({ events, benchmarkFeedback });
    expect(items.map((i) => i.eventType)).toEqual(["hold_expired", "slow_total_time"]);
  });
});

// ---------------------------------------------------------------------
// aggregateSessionResult (integration, real DB)
// ---------------------------------------------------------------------

describe("aggregateSessionResult", () => {
  it("returns null when the session has no SessionResult row", async () => {
    const result = await aggregateSessionResult({ sessionId: freshSessionId(), now: new Date() });
    expect(result).toBeNull();
  });

  it("resolves SUCCESS and transitions the run to COMPLETED when a Booking exists for the current run", async () => {
    const sessionId = freshSessionId();
    const run = await createRun({ sessionId });
    const seat = await db.seat.create({
      data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.SOLD },
    });
    await db.booking.create({ data: { concertId: run.concertId, seatId: seat.id, sessionId } });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "payment", now);
    await recordStageExited(db, sessionId, "payment", now);

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.outcome).toBe(SessionOutcome.SUCCESS);
    const persistedRun = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe(SimulationRunStatus.COMPLETED);
    const persistedResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(persistedResult.outcome).toBe(SessionOutcome.SUCCESS);
  });

  it("sweeps an unswept expired hold and resolves SEAT_LOST (closes the client-timer race)", async () => {
    const sessionId = freshSessionId();
    const run = await createRun({ sessionId });
    const seat = await db.seat.create({
      data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.HELD },
    });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await db.hold.create({ data: { seatId: seat.id, sessionId, expiresAt: new Date(now.getTime() - 1000) } });
    await recordStageEntered(db, sessionId, "seat_selection", now);
    await recordStageExited(db, sessionId, "seat_selection", now);

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.outcome).toBe(SessionOutcome.SEAT_LOST);
    expect(result?.events.some((e) => e.type === "hold_expired")).toBe(true);
    const persistedRun = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe(SimulationRunStatus.COMPLETED);
  });

  it("resolves PAYMENT_FAILED from an already-recorded payment_abandoned event", async () => {
    const sessionId = freshSessionId();
    await createRun({ sessionId });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "payment", now);
    await recordJudgmentEvent(db, sessionId, { type: "payment_abandoned", stage: "payment", timestamp: now.toISOString() });

    const result = await aggregateSessionResult({ sessionId, now });
    expect(result?.outcome).toBe(SessionOutcome.PAYMENT_FAILED);
  });

  it("does not recompute or re-transition the run once outcome is already persisted", async () => {
    const sessionId = freshSessionId();
    const run = await createRun({ sessionId, status: SimulationRunStatus.COMPLETED });
    await recordStageEntered(db, sessionId, "queue", new Date("2026-01-01T00:00:00.000Z"));
    await db.sessionResult.update({ where: { sessionId }, data: { outcome: SessionOutcome.ABANDONED } });

    const result = await aggregateSessionResult({ sessionId, now: new Date("2026-01-01T00:20:00.000Z") });

    expect(result?.outcome).toBe(SessionOutcome.ABANDONED);
    const persistedRun = await db.simulationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persistedRun.status).toBe(SimulationRunStatus.COMPLETED);
  });

  it("scopes the Booking lookup to the current run, ignoring a Booking left over from a superseded run", async () => {
    const sessionId = freshSessionId();
    const oldRun = await createRun({ sessionId, status: SimulationRunStatus.EXPIRED });
    const oldSeat = await db.seat.create({
      data: { concertId: oldRun.concertId, simulationRunId: oldRun.id, row: "A", number: 1, status: SeatStatus.SOLD },
    });
    await db.booking.create({ data: { concertId: oldRun.concertId, seatId: oldSeat.id, sessionId } });

    // D-8 reset already cleared SessionResult.outcome on retry; simulate
    // the new run starting fresh with no booking of its own yet.
    await createRun({ sessionId });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "queue", now);

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.outcome).toBe(SessionOutcome.ABANDONED);
  });

  it("adds a no_recorded_activity fallback when outcome resolves to ABANDONED with no other feedback", async () => {
    const sessionId = freshSessionId();
    await createRun({ sessionId });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "queue", now); // no events, no exitedAt anywhere -> nothing for buildFeedback/evaluateBenchmarks to key off

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.outcome).toBe(SessionOutcome.ABANDONED);
    expect(result?.feedback).toEqual([
      {
        eventType: "no_recorded_activity",
        message:
          "You left before any seat, error, or retry was recorded — next time, try to at least reach seat selection so there's something concrete to review here.",
      },
    ]);
  });

  it("does not add the fallback when the ABANDONED session already has other feedback (e.g. a queue_reset event)", async () => {
    const sessionId = freshSessionId();
    await createRun({ sessionId });
    const now = new Date("2026-01-01T00:10:00.000Z");
    await recordStageEntered(db, sessionId, "queue", now);
    await recordJudgmentEvent(db, sessionId, {
      type: "queue_reset",
      stage: "queue",
      timestamp: now.toISOString(),
      positionBeforeReset: 10,
    });

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.outcome).toBe(SessionOutcome.ABANDONED);
    expect(result?.feedback.some((item) => item.eventType === "no_recorded_activity")).toBe(false);
    expect(result?.feedback.some((item) => item.eventType === "queue_reset")).toBe(true);
  });

  it("includes benchmark feedback derived from the current run's tier", async () => {
    const sessionId = freshSessionId();
    await createRun({ sessionId, tier: Tier.SMALL });
    const now = new Date("2026-01-01T00:10:00.000Z");
    const { targetTotalMs } = TIER_BENCHMARKS[Tier.SMALL];
    await recordStageEntered(db, sessionId, "queue", new Date(now.getTime() - targetTotalMs - 1000));
    await recordStageExited(db, sessionId, "queue", now);
    await recordJudgmentEvent(db, sessionId, { type: "payment_abandoned", stage: "payment", timestamp: now.toISOString() });

    const result = await aggregateSessionResult({ sessionId, now });

    expect(result?.feedback.some((item) => item.eventType === "slow_total_time")).toBe(true);
  });
});
