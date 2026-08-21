import { describe, it, expect, afterEach } from "vitest";
import { getTestDb } from "@/lib/test-db";
import { recordStageEntered, recordStageExited, recordJudgmentEvent } from "@/lib/session-result";
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
