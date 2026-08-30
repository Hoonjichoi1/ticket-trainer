// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { getTestDb } from "@/lib/test-db";
import {
  recordStageEntered,
  recordStageExited,
  recordJudgmentEvent,
  incrementContentionLosses,
  getSessionResultRow,
  resetSessionResult,
} from "@/lib/session-result";
import { SessionOutcome } from "@/lib/types";
import type { JudgmentEvent, StageTimings } from "@/lib/types";

const db = getTestDb();
const createdSessionIds: string[] = [];

function freshSessionId(): string {
  const id = `session-result-test-${crypto.randomUUID()}`;
  createdSessionIds.push(id);
  return id;
}

afterEach(async () => {
  if (createdSessionIds.length === 0) return;
  await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  createdSessionIds.length = 0;
});

describe("recordStageEntered", () => {
  it("handles two concurrent first-writes for the same brand-new sessionId without throwing (React StrictMode double-invokes effects, firing two joins almost simultaneously)", async () => {
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");

    await expect(
      Promise.all([
        recordStageEntered(db, sessionId, "queue", now),
        recordStageEntered(db, sessionId, "queue", now),
      ]),
    ).resolves.toBeDefined();

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect((row.stageTimings as StageTimings).queue?.enteredAt).toBe(now.toISOString());
  });

  it("creates a SessionResult row and sets stageTimings[stage].enteredAt", async () => {
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");

    await recordStageEntered(db, sessionId, "queue", now);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const timings = row.stageTimings as StageTimings;
    expect(timings.queue?.enteredAt).toBe(now.toISOString());
  });

  it("does not overwrite an already-recorded enteredAt (idempotent across repeated joins)", async () => {
    const sessionId = freshSessionId();
    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2026-01-01T00:05:00.000Z");

    await recordStageEntered(db, sessionId, "queue", first);
    await recordStageEntered(db, sessionId, "queue", second);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const timings = row.stageTimings as StageTimings;
    expect(timings.queue?.enteredAt).toBe(first.toISOString());
  });
});

describe("recordStageExited", () => {
  it("sets exitedAt and durationMs relative to the recorded enteredAt", async () => {
    const sessionId = freshSessionId();
    const enteredAt = new Date("2026-01-01T00:00:00.000Z");
    const exitedAt = new Date("2026-01-01T00:00:30.000Z");

    await recordStageEntered(db, sessionId, "queue", enteredAt);
    await recordStageExited(db, sessionId, "queue", exitedAt);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const timings = row.stageTimings as StageTimings;
    expect(timings.queue?.exitedAt).toBe(exitedAt.toISOString());
    expect(timings.queue?.durationMs).toBe(30_000);
  });
});

describe("recordJudgmentEvent", () => {
  it("appends events instead of overwriting previous ones", async () => {
    const sessionId = freshSessionId();
    const eventA: JudgmentEvent = {
      type: "queue_reset",
      stage: "queue",
      timestamp: "2026-01-01T00:00:00.000Z",
      positionBeforeReset: 500,
    };
    const eventB: JudgmentEvent = {
      type: "queue_reset",
      stage: "queue",
      timestamp: "2026-01-01T00:01:00.000Z",
      positionBeforeReset: 480,
    };

    await recordJudgmentEvent(db, sessionId, eventA);
    await recordJudgmentEvent(db, sessionId, eventB);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = row.events as unknown as JudgmentEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(eventA);
    expect(events[1]).toEqual(eventB);
  });
});

describe("getSessionResultRow", () => {
  it("returns null when no row exists (and does not create one)", async () => {
    const sessionId = freshSessionId();
    const row = await getSessionResultRow(db, sessionId);
    expect(row).toBeNull();
    await expect(db.sessionResult.findUnique({ where: { sessionId } })).resolves.toBeNull();
  });

  it("returns the full row shape once one exists", async () => {
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await recordStageEntered(db, sessionId, "queue", now);
    await incrementContentionLosses(db, sessionId);
    await recordJudgmentEvent(db, sessionId, {
      type: "queue_reset",
      stage: "queue",
      timestamp: now.toISOString(),
      positionBeforeReset: 10,
    });

    const row = await getSessionResultRow(db, sessionId);
    expect(row?.outcome).toBeNull();
    expect(row?.contentionLosses).toBe(1);
    expect(row?.stageTimings.queue?.enteredAt).toBe(now.toISOString());
    expect(row?.events).toHaveLength(1);
  });
});

describe("resetSessionResult", () => {
  it("is a no-op when no row exists yet", async () => {
    const sessionId = freshSessionId();
    await expect(resetSessionResult(db, sessionId)).resolves.toBeUndefined();
    await expect(db.sessionResult.findUnique({ where: { sessionId } })).resolves.toBeNull();
  });

  it("clears outcome/stageTimings/contentionLosses/events on an existing row", async () => {
    const sessionId = freshSessionId();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await recordStageEntered(db, sessionId, "queue", now);
    await incrementContentionLosses(db, sessionId);
    await recordJudgmentEvent(db, sessionId, {
      type: "queue_reset",
      stage: "queue",
      timestamp: now.toISOString(),
      positionBeforeReset: 10,
    });
    await db.sessionResult.update({ where: { sessionId }, data: { outcome: SessionOutcome.ABANDONED } });

    await resetSessionResult(db, sessionId);

    const row = await getSessionResultRow(db, sessionId);
    expect(row).toEqual({ outcome: null, stageTimings: {}, contentionLosses: 0, events: [] });
  });
});

describe("incrementContentionLosses", () => {
  it("creates a SessionResult row starting at 1 on the first call", async () => {
    const sessionId = freshSessionId();

    await incrementContentionLosses(db, sessionId);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(row.contentionLosses).toBe(1);
  });

  it("accumulates across repeated calls instead of resetting", async () => {
    const sessionId = freshSessionId();

    await incrementContentionLosses(db, sessionId);
    await incrementContentionLosses(db, sessionId);
    await incrementContentionLosses(db, sessionId);

    const row = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(row.contentionLosses).toBe(3);
  });
});
