import { describe, it, expect, afterEach } from "vitest";
import { Tier, QueueEntryStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { joinQueue, pollQueue, requireAdmission, redeemAdmissionToken, getActiveRun } from "@/lib/queue";

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.queueEntry.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  if (createdConcertIds.length > 0) {
    await db.concert.deleteMany({ where: { id: { in: createdConcertIds } } });
  }
  createdSessionIds.length = 0;
  createdRunIds.length = 0;
  createdConcertIds.length = 0;
});

// Default openAt is 100s before the shared t0 (2026-01-01T00:00:00.000Z)
// used across this file's tests — well past the 1s surge window (D-23 2nd
// revision), so joins at t0 exercise the post-window formula. SMALL tier's
// surgeBaseline is 4,167 and arrivalRatePerSec is 20.84 (see prisma/seed.ts,
// ROADMAP D-23), so joining at t0 yields round(4167 + 20.84*99) = 6230.
const DEFAULT_TEST_OPEN_AT = new Date("2025-12-31T23:58:20.000Z");

async function createRun(opts: { tier?: Tier; openAt?: Date } = {}) {
  const concert = await db.concert.create({
    data: {
      title: "queue-test-concert",
      venue: "queue-test-venue",
      openAt: opts.openAt ?? DEFAULT_TEST_OPEN_AT,
    },
  });
  createdConcertIds.push(concert.id);

  const sessionId = `queue-test-${crypto.randomUUID()}`;
  createdSessionIds.push(sessionId);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: opts.tier ?? Tier.SMALL,
      // D-14: joinQueue reads SimulationRun.queueOpenAt, not Concert.openAt
      // — mirror the same value so this file's arrival-time assertions
      // keep controlling the value they parametrize.
      queueOpenAt: opts.openAt ?? DEFAULT_TEST_OPEN_AT,
    },
  });
  createdRunIds.push(run.id);

  return { run, sessionId };
}

describe("getActiveRun", () => {
  it("returns the run for the session's tier and concert openAt", async () => {
    const { run, sessionId } = await createRun();

    const active = await getActiveRun(sessionId);

    expect(active?.id).toBe(run.id);
    expect(active?.tier).toBe(Tier.SMALL);
  });

  it("returns null when the session has no active run", async () => {
    const active = await getActiveRun(`no-such-session-${crypto.randomUUID()}`);
    expect(active).toBeNull();
  });
});

describe("joinQueue", () => {
  it("creates a QueueEntry with position derived from surgeBaseline + arrivalRatePerSec × elapsed time since open (past the surge window), and marks the queue stage entered", async () => {
    const { run, sessionId } = await createRun(); // SMALL, 100s since open (past the 1s surge window): round(4167 + 20.84*99) = 6230
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await joinQueue({ sessionId, runId: run.id, now });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.position).toBe(6230);
    expect(result.snapshot.status).toBe(QueueEntryStatus.WAITING);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect((sessionResult.stageTimings as { queue?: { enteredAt?: string } }).queue?.enteredAt).toBe(
      now.toISOString(),
    );
  });

  it("rejects joining before the concert's openAt", async () => {
    const openAt = new Date("2026-06-01T00:00:00.000Z");
    const { run, sessionId } = await createRun({ openAt });
    const before = new Date(openAt.getTime() - 1000);

    const result = await joinQueue({ sessionId, runId: run.id, now: before });

    expect(result).toEqual({ ok: false, code: "SALE_NOT_OPEN" });
    const entries = await db.queueEntry.findMany({ where: { simulationRunId: run.id } });
    expect(entries).toHaveLength(0);
  });

  it("expires the previous WAITING entry on rejoin and records a queue_reset event with the decayed position", async () => {
    const { run, sessionId } = await createRun(); // SMALL: surgeBaseline 4167, arrivalRatePerSec 20.84/sec, admissionRatePerSec 20.84/sec
    const t0 = new Date("2026-01-01T00:00:00.000Z"); // 100s since open (past surge window) -> first entry starts at round(4167 + 20.84*99) = 6230
    const first = await joinQueue({ sessionId, runId: run.id, now: t0 });
    if (!first.ok) throw new Error("unreachable");

    const t1 = new Date(t0.getTime() + 10_000); // old entry: 6230 - 20.84*10 = 6021.6 decayed position (unrounded — only the event log, not a stored QueueEntry.position)
    const second = await joinQueue({ sessionId, runId: run.id, now: t1 });
    if (!second.ok) throw new Error("unreachable");
    // Rejoining later means more time has elapsed since open too — the new
    // entry's own starting position reflects that: round(4167 + 20.84*109s since open) = 6439.
    expect(second.snapshot.position).toBe(6439);

    const entries = await db.queueEntry.findMany({
      where: { simulationRunId: run.id },
      orderBy: { joinedAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe(QueueEntryStatus.EXPIRED);
    expect(entries[1].status).toBe(QueueEntryStatus.WAITING);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string; positionBeforeReset?: number }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "queue_reset" });
    expect(events[0].positionBeforeReset).toBeCloseTo(6021.6, 5);
  });

  it("does not record a queue_reset event on the very first join", async () => {
    const { run, sessionId } = await createRun();
    await joinQueue({ sessionId, runId: run.id, now: new Date("2026-01-01T00:00:00.000Z") });

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(sessionResult.events).toEqual([]);
  });

  it("serializes two concurrent joins for the same session+run into exactly one active entry (D-13)", async () => {
    // Reproduces the race found live via Playwright: React Strict Mode's
    // dev double-effect-invoke (and, in production, the same session open
    // in two tabs) can fire two joinQueue calls before either commits.
    // Without the FOR UPDATE lock on SimulationRun, both would read "no
    // previous WAITING entry" and insert, leaving two WAITING rows for one
    // session with no queue_reset recorded for either.
    const { run, sessionId } = await createRun();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const [first, second] = await Promise.all([
      joinQueue({ sessionId, runId: run.id, now }),
      joinQueue({ sessionId, runId: run.id, now }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const entries = await db.queueEntry.findMany({ where: { simulationRunId: run.id } });
    expect(entries).toHaveLength(2);
    const active = entries.filter((e) => e.status !== QueueEntryStatus.EXPIRED);
    expect(active).toHaveLength(1);

    // The lock serialized them into the same "rejoin" path a real
    // sequential rejoin takes — one queue_reset event, not silent data loss.
    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "queue_reset" });
  });

  // D-4: initial position scales with how long the sale has been open at
  // join time, instead of a fixed per-tier constant. D-23 2nd revision:
  // within the first second after open (the "surge window"), position
  // ramps linearly from 0 up to surgeBaseline — a click at the *exact*
  // open instant is now the single best possible position (0), and
  // reaction time within that first second directly determines how much
  // worse it gets, which is the whole point of the 2nd revision (see
  // ROADMAP D-23).
  it("assigns position 0 when joining at the exact open instant (surge window start)", async () => {
    const openAt = new Date("2026-01-01T00:00:00.000Z");
    const { run, sessionId } = await createRun({ openAt });

    const result = await joinQueue({ sessionId, runId: run.id, now: openAt });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.position).toBe(0);
  });

  it("assigns position == surgeBaseline when joining exactly at the surge window's close (1s after open)", async () => {
    const openAt = new Date("2026-01-01T00:00:00.000Z");
    const { run, sessionId } = await createRun({ openAt });

    const result = await joinQueue({ sessionId, runId: run.id, now: new Date(openAt.getTime() + 1000) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.position).toBe(4167); // SMALL surgeBaseline
  });

  it("gives a strictly larger (worse) position the later within the surge window a session joins — reaction time inside the first second matters", async () => {
    const openAt = new Date("2026-01-01T00:00:00.000Z");

    const fast = await createRun({ openAt });
    const fastResult = await joinQueue({
      sessionId: fast.sessionId,
      runId: fast.run.id,
      now: new Date(openAt.getTime() + 100), // 0.1s after open
    });

    const slow = await createRun({ openAt });
    const slowResult = await joinQueue({
      sessionId: slow.sessionId,
      runId: slow.run.id,
      now: new Date(openAt.getTime() + 900), // 0.9s after open
    });

    if (!fastResult.ok || !slowResult.ok) throw new Error("unreachable");
    // SMALL surgeBaseline 4167: 0.1s -> round(4167*0.1)=417, 0.9s -> round(4167*0.9)=3750.
    expect(fastResult.snapshot.position).toBe(417);
    expect(slowResult.snapshot.position).toBe(3750);
    // The core behavior the 2nd revision restores: a large (thousands),
    // not merely rounding-sized, gap from reaction time alone.
    expect(slowResult.snapshot.position - fastResult.snapshot.position).toBeGreaterThan(1000);
  });

  it("assigns a larger initial position the later a session joins after the surge window closes", async () => {
    const openAt = new Date("2026-01-01T00:00:00.000Z");

    const early = await createRun({ openAt });
    const earlyResult = await joinQueue({
      sessionId: early.sessionId,
      runId: early.run.id,
      now: new Date(openAt.getTime() + 5_000), // 5s after open
    });

    const late = await createRun({ openAt });
    const lateResult = await joinQueue({
      sessionId: late.sessionId,
      runId: late.run.id,
      now: new Date(openAt.getTime() + 300_000), // 300s after open
    });

    if (!earlyResult.ok || !lateResult.ok) throw new Error("unreachable");
    // Both past the 1s surge window: surgeBaseline 4167 + arrivalRatePerSec
    // 20.84/sec * (elapsed - 1): 5s -> round(4167+20.84*4)=4250, 300s -> round(4167+20.84*299)=10398.
    expect(earlyResult.snapshot.position).toBe(4250);
    expect(lateResult.snapshot.position).toBe(10398);
    expect(lateResult.snapshot.position).toBeGreaterThan(earlyResult.snapshot.position);
  });
});

describe("pollQueue", () => {
  it("returns NO_ACTIVE_ENTRY when the session hasn't joined the queue", async () => {
    const { run, sessionId } = await createRun();
    const result = await pollQueue({ sessionId, runId: run.id, now: new Date() });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_ENTRY" });
  });

  it("returns the position decayed by elapsed time since joinedAt", async () => {
    const { run, sessionId } = await createRun(); // SMALL: admissionRatePerSec 20.84/sec
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    await joinQueue({ sessionId, runId: run.id, now: t0 }); // joins at round(4167 + 20.84*99) = 6230

    const result = await pollQueue({ sessionId, runId: run.id, now: new Date(t0.getTime() + 10_000) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.position).toBeCloseTo(6021.6, 5); // 6230 - 20.84*10
    expect(result.snapshot.status).toBe(QueueEntryStatus.WAITING);
    expect(result.snapshot.admissionToken).toBeUndefined();
  });

  it("admits and issues a token exactly once when position reaches 0, and keeps returning the same token", async () => {
    const { run, sessionId } = await createRun(); // SMALL: joins at position 6230 (see DEFAULT_TEST_OPEN_AT), admissionRatePerSec 20.84/sec -> ~299s to admit
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    await joinQueue({ sessionId, runId: run.id, now: t0 });

    const admitted = await pollQueue({ sessionId, runId: run.id, now: new Date(t0.getTime() + 300_000) });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.snapshot.status).toBe(QueueEntryStatus.ADMITTED);
    expect(admitted.snapshot.admissionToken).toBeTruthy();

    const again = await pollQueue({ sessionId, runId: run.id, now: new Date(t0.getTime() + 350_000) });
    if (!again.ok) throw new Error("unreachable");
    expect(again.snapshot.admissionToken).toBe(admitted.snapshot.admissionToken);
  });

  it("does not double-issue a token under concurrent polling at the admission threshold", async () => {
    const { run, sessionId } = await createRun();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    await joinQueue({ sessionId, runId: run.id, now: t0 });
    const admitAt = new Date(t0.getTime() + 300_000);

    const [a, b] = await Promise.all([
      pollQueue({ sessionId, runId: run.id, now: admitAt }),
      pollQueue({ sessionId, runId: run.id, now: admitAt }),
    ]);
    if (!a.ok || !b.ok) throw new Error("unreachable");

    expect(a.snapshot.admissionToken).toBe(b.snapshot.admissionToken);
  });
});

describe("requireAdmission", () => {
  it("is true once the entry is ADMITTED", async () => {
    const { run, sessionId } = await createRun();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    await joinQueue({ sessionId, runId: run.id, now: t0 });
    await pollQueue({ sessionId, runId: run.id, now: new Date(t0.getTime() + 300_000) });

    expect(await requireAdmission({ sessionId, runId: run.id })).toBe(true);
  });

  it("is false while still WAITING or before ever joining", async () => {
    const { run, sessionId } = await createRun();
    expect(await requireAdmission({ sessionId, runId: run.id })).toBe(false);

    await joinQueue({ sessionId, runId: run.id, now: new Date("2026-01-01T00:00:00.000Z") });
    expect(await requireAdmission({ sessionId, runId: run.id })).toBe(false);
  });
});

describe("redeemAdmissionToken", () => {
  async function admittedEntry(now = new Date("2026-01-01T00:00:00.000Z")) {
    const { run, sessionId } = await createRun();
    await joinQueue({ sessionId, runId: run.id, now });
    const admitted = await pollQueue({ sessionId, runId: run.id, now: new Date(now.getTime() + 300_000) });
    if (!admitted.ok || !admitted.snapshot.admissionToken) throw new Error("unreachable");
    return { run, sessionId, token: admitted.snapshot.admissionToken };
  }

  it("accepts a valid token, invalidates it, and records the queue stage as exited", async () => {
    const { run, sessionId, token } = await admittedEntry();

    const result = await redeemAdmissionToken({ sessionId, runId: run.id, token, now: new Date() });

    expect(result).toBe("ok");
    const entry = await db.queueEntry.findFirstOrThrow({ where: { simulationRunId: run.id } });
    expect(entry.admissionToken).toBeNull();

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect((sessionResult.stageTimings as { queue?: { exitedAt?: string } }).queue?.exitedAt).toBeTruthy();
  });

  it("rejects an incorrect token without consuming the real one", async () => {
    const { run, sessionId, token } = await admittedEntry();

    const result = await redeemAdmissionToken({ sessionId, runId: run.id, token: "forged-token", now: new Date() });

    expect(result).toBe("invalid");
    const entry = await db.queueEntry.findFirstOrThrow({ where: { simulationRunId: run.id } });
    expect(entry.admissionToken).toBe(token);
  });

  it("rejects reuse of an already-redeemed token", async () => {
    const { run, sessionId, token } = await admittedEntry();
    await redeemAdmissionToken({ sessionId, runId: run.id, token, now: new Date() });

    const second = await redeemAdmissionToken({ sessionId, runId: run.id, token, now: new Date() });

    expect(second).toBe("invalid");
  });

  it("rejects a token redeemed under a different session", async () => {
    const { run, token } = await admittedEntry();

    const result = await redeemAdmissionToken({
      sessionId: `other-session-${crypto.randomUUID()}`,
      runId: run.id,
      token,
      now: new Date(),
    });

    expect(result).toBe("invalid");
  });
});
