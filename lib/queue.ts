// Queue join/poll/admission orchestration (Task 008) — the "caller" layer
// lib/simulation.ts's pure computeQueuePosition defers DB I/O to, same
// role lib/tick.ts plays for bot claims. Owns QueueEntry lifecycle and the
// one-time admission token; delegates observed-timing/event writes to
// lib/session-result.ts.
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { QueueEntryStatus, SimulationRunStatus, type QueueStatus } from "@/lib/types";
import { computeElapsedTime, computeQueuePosition } from "@/lib/simulation";
import { recordStageEntered, recordStageExited, recordJudgmentEvent } from "@/lib/session-result";

export interface QueueSnapshot {
  position: number;
  aheadCount: number;
  estimatedWaitSeconds: number;
  status: QueueStatus;
  /** present only while ADMITTED and not yet redeemed via redeemAdmissionToken */
  admissionToken?: string;
}

function toSnapshot(params: {
  position: number;
  admissionRatePerSec: number;
  status: QueueStatus;
  admissionToken?: string | null;
}): QueueSnapshot {
  const { position, admissionRatePerSec, status } = params;
  return {
    position,
    aheadCount: Math.ceil(position),
    estimatedWaitSeconds: admissionRatePerSec > 0 ? Math.ceil(position / admissionRatePerSec) : 0,
    status,
    admissionToken:
      status === QueueEntryStatus.ADMITTED && params.admissionToken ? params.admissionToken : undefined,
  };
}

/** The session's currently ACTIVE SimulationRun, with its tier's config — or null if none. */
export async function getActiveRun(sessionId: string) {
  const run = await prisma.simulationRun.findFirst({
    where: { sessionId, status: SimulationRunStatus.ACTIVE },
  });
  if (!run) return null;

  const config = await prisma.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });
  return { ...run, config };
}

export type JoinQueueResult = { ok: true; snapshot: QueueSnapshot } | { ok: false; code: "SALE_NOT_OPEN" };

/**
 * Joins (or rejoins) the queue for a run. A rejoin — an existing WAITING
 * entry for this session+run — expires that entry and records a
 * queue_reset judgment event carrying the position it had actually decayed
 * to (not just its static starting position), so the report reflects what
 * progress was actually lost.
 */
export async function joinQueue(params: {
  sessionId: string;
  runId: string;
  now: Date;
}): Promise<JoinQueueResult> {
  const { sessionId, runId, now } = params;

  const run = await prisma.simulationRun.findUniqueOrThrow({ where: { id: runId } });
  if (now.getTime() < run.queueOpenAt.getTime()) {
    return { ok: false, code: "SALE_NOT_OPEN" };
  }

  const config = await prisma.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });

  const entry = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // D-13: without this lock, two joinQueue calls for the same run (React
    // Strict Mode's dev double-effect-invoke, or two tabs on the same
    // session) can both read "no previous WAITING entry" under READ
    // COMMITTED before either commits its insert, creating two WAITING
    // rows for one session. A run has exactly one sessionId (schema), so
    // locking the run row serializes this the same way pollQueue's
    // `FOR UPDATE` on QueueEntry serializes concurrent admission polls.
    await tx.$queryRaw`SELECT id FROM "SimulationRun" WHERE id = ${runId} FOR UPDATE`;

    const previous = await tx.queueEntry.findFirst({
      where: { sessionId, simulationRunId: runId, status: QueueEntryStatus.WAITING },
    });

    if (previous) {
      await tx.queueEntry.update({ where: { id: previous.id }, data: { status: QueueEntryStatus.EXPIRED } });

      const elapsed = computeElapsedTime({ since: previous.joinedAt, now });
      const decayed = computeQueuePosition({
        elapsed,
        admissionRatePerSec: config.admissionRatePerSec,
        initialPosition: previous.position,
      });
      await recordJudgmentEvent(tx, sessionId, {
        type: "queue_reset",
        stage: "queue",
        timestamp: now.toISOString(),
        positionBeforeReset: decayed.position,
      });
    } else {
      await recordStageEntered(tx, sessionId, "queue", now);
    }

    // D-4: initial position is proportional to how many virtual users have
    // arrived since the concert opened, not a fixed per-tier constant — so
    // joining closer to the exact open moment gets a lower (better) starting
    // position. QueueEntry.position is Int, so round the continuous
    // arrivalRatePerSec * elapsedSeconds value.
    // D-23: D-4's original formula assumed the queue is *empty* at the
    // exact open instant (position ~0 for a perfectly-timed click), which
    // real ticketing research contradicts — real queues already carry a
    // large simultaneous-click surge at t=0 (tens of thousands for a
    // popular concert). surgeBaseline adds that fixed t=0 floor; the
    // arrivalRatePerSec term still adds on top of it for sessions joining
    // after the exact open moment. See ROADMAP D-23.
    const elapsedSinceOpen = computeElapsedTime({ since: run.queueOpenAt, now });
    const initialPosition = Math.round(
      config.surgeBaseline + config.arrivalRatePerSec * elapsedSinceOpen.seconds,
    );

    return tx.queueEntry.create({
      data: {
        concertId: run.concertId,
        simulationRunId: runId,
        sessionId,
        position: initialPosition,
        joinedAt: now,
      },
    });
  });

  return {
    ok: true,
    snapshot: toSnapshot({
      position: entry.position,
      admissionRatePerSec: config.admissionRatePerSec,
      status: entry.status,
    }),
  };
}

export type PollQueueResult = { ok: true; snapshot: QueueSnapshot } | { ok: false; code: "NO_ACTIVE_ENTRY" };

/**
 * Polls the session's current queue position, advancing it by elapsed time
 * since joinedAt (tick-on-request — no persistent process). On reaching 0
 * for the first time, transitions the entry to ADMITTED and issues an
 * admissionToken inside the same locked transaction, so concurrent polls
 * at the admission threshold can't double-issue (the second call blocks on
 * `FOR UPDATE`, then observes the already-ADMITTED status).
 */
export async function pollQueue(params: {
  sessionId: string;
  runId: string;
  now: Date;
}): Promise<PollQueueResult> {
  const { sessionId, runId, now } = params;

  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<PollQueueResult> => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; position: number; joinedAt: Date; status: QueueStatus; admissionToken: string | null }>
    >`
      SELECT id, position, "joinedAt", status, "admissionToken"
      FROM "QueueEntry"
      WHERE "sessionId" = ${sessionId} AND "simulationRunId" = ${runId} AND status != 'EXPIRED'
      ORDER BY "joinedAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const entry = rows[0];
    if (!entry) return { ok: false, code: "NO_ACTIVE_ENTRY" };

    const run = await tx.simulationRun.findUniqueOrThrow({ where: { id: runId } });
    const config = await tx.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });

    const elapsed = computeElapsedTime({ since: entry.joinedAt, now });
    const computed = computeQueuePosition({
      elapsed,
      admissionRatePerSec: config.admissionRatePerSec,
      initialPosition: entry.position,
    });

    let status = entry.status;
    let admissionToken = entry.admissionToken;

    if (computed.admitted && entry.status === QueueEntryStatus.WAITING) {
      status = QueueEntryStatus.ADMITTED;
      admissionToken = randomUUID();
      await tx.queueEntry.update({ where: { id: entry.id }, data: { status, admissionToken } });
    }

    return {
      ok: true,
      snapshot: toSnapshot({ position: computed.position, admissionRatePerSec: config.admissionRatePerSec, status, admissionToken }),
    };
  });
}

/** Durable admission gate for /seats access — true once the session has an ADMITTED entry for this run, independent of whether its token was already redeemed. */
export async function requireAdmission(params: { sessionId: string; runId: string }): Promise<boolean> {
  const entry = await prisma.queueEntry.findFirst({
    where: { sessionId: params.sessionId, simulationRunId: params.runId, status: QueueEntryStatus.ADMITTED },
  });
  return entry !== null;
}

export type RedeemResult = "ok" | "invalid";

/**
 * One-time validation of the admission token handed off from the queue
 * poll response. Matches sessionId + runId + the exact token on an
 * ADMITTED entry, then nulls it out atomically (single UPDATE — a second
 * concurrent/replayed redeem of the same token simply matches 0 rows).
 * This is a courtesy invalidation on top of requireAdmission(), which
 * remains the real gate so a stale/absent token doesn't lock a legitimately
 * admitted session out of a page reload.
 */
export async function redeemAdmissionToken(params: {
  sessionId: string;
  runId: string;
  token: string;
  now: Date;
}): Promise<RedeemResult> {
  const { sessionId, runId, token, now } = params;

  const consumed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.queueEntry.updateMany({
      where: { sessionId, simulationRunId: runId, status: QueueEntryStatus.ADMITTED, admissionToken: token },
      data: { admissionToken: null },
    });
    if (updated.count > 0) {
      await recordStageExited(tx, sessionId, "queue", now);
    }
    return updated.count;
  });

  return consumed > 0 ? "ok" : "invalid";
}
