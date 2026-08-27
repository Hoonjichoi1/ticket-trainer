// Dev/test-only time-warp utility (ROADMAP D-7). lib/simulation.ts's
// tick-on-request math is a pure function of "now minus a stored
// timestamp" (SimulationRun.queueOpenAt, QueueEntry.joinedAt,
// SimulationRun.lastTickAt) — so rewriting those stored timestamps into
// the past (or, for queueOpenAt, into the near future) reproduces
// "already open" / "already near admission" states without waiting in
// real time. This module never imports or touches lib/simulation.ts's
// calculation logic — it only mutates the DB rows that logic reads.
// Callers (app/api/dev/timewarp/route.ts) are responsible for the
// NODE_ENV production gate; this module has no env check of its own.
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { QueueEntryStatus } from "@/lib/types";
import { getActiveRun } from "@/lib/queue";
import type { TimewarpQueueOpenResult, TimewarpQueueResult, TimewarpSimulationRunResult } from "@/lib/types";

export interface ApplyTimewarpParams {
  sessionId: string;
  openInMs?: number;
  queueRewindMs?: number;
  queueConsumedPct?: number;
  lastTickRewindMs?: number;
  now: Date;
}

export interface ApplyTimewarpSuccess {
  now: string;
  queueOpen: TimewarpQueueOpenResult | null;
  queue: TimewarpQueueResult | null;
  simulationRun: TimewarpSimulationRunResult | null;
  warnings: string[];
}

export type ApplyTimewarpResult =
  | { ok: true; result: ApplyTimewarpSuccess }
  | { ok: false; code: "NO_ACTIVE_RUN" }
  | { ok: false; code: "INVALID_CONFIG"; message: string };

/**
 * Applies whichever of the three time-anchor rewrites were requested,
 * all inside one transaction (a combined scenario is all-or-nothing —
 * never half-applied). Each field is independent; a request can set any
 * subset of them to compose scenarios (e.g. "30s before open" +
 * "queue 90% consumed" in one call).
 */
export async function applyTimewarp(params: ApplyTimewarpParams): Promise<ApplyTimewarpResult> {
  const { sessionId, openInMs, queueRewindMs, queueConsumedPct, lastTickRewindMs, now } = params;

  const run = await getActiveRun(sessionId);
  if (!run) return { ok: false, code: "NO_ACTIVE_RUN" };

  if (queueConsumedPct !== undefined && run.config.admissionRatePerSec <= 0) {
    return {
      ok: false,
      code: "INVALID_CONFIG",
      message: "This tier's admissionRatePerSec is 0 — queueConsumedPct has no meaningful effect.",
    };
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ApplyTimewarpSuccess> => {
    const warnings: string[] = [];
    let queueOpen: TimewarpQueueOpenResult | null = null;
    let queue: TimewarpQueueResult | null = null;
    let simulationRun: TimewarpSimulationRunResult | null = null;

    if (openInMs !== undefined) {
      // D-14: SimulationRun.queueOpenAt is per-run, so this only ever
      // affects the caller's own session — no shared-row race with other
      // concurrent sessions the way mutating Concert.openAt used to have.
      const queueOpenAt = new Date(now.getTime() + openInMs);
      await tx.simulationRun.update({ where: { id: run.id }, data: { queueOpenAt } });
      queueOpen = { applied: true, openAt: queueOpenAt.toISOString() };
    }

    if (queueRewindMs !== undefined || queueConsumedPct !== undefined) {
      // Same lookup pollQueue() uses: most recent non-EXPIRED entry for this session+run.
      const entry = await tx.queueEntry.findFirst({
        where: { sessionId, simulationRunId: run.id, status: { not: QueueEntryStatus.EXPIRED } },
        orderBy: { joinedAt: "desc" },
      });

      if (!entry) {
        queue = { applied: false, reason: "NO_ACTIVE_QUEUE_ENTRY" };
      } else {
        const rewindMs =
          queueConsumedPct !== undefined
            ? ((entry.position * queueConsumedPct) / 100 / run.config.admissionRatePerSec) * 1000
            : queueRewindMs!;
        const joinedAt = new Date(now.getTime() - rewindMs);
        await tx.queueEntry.update({ where: { id: entry.id }, data: { joinedAt } });
        queue = { applied: true, joinedAt: joinedAt.toISOString() };
      }
    }

    if (lastTickRewindMs !== undefined) {
      const lastTickAt = new Date(now.getTime() - lastTickRewindMs);
      await tx.simulationRun.update({ where: { id: run.id }, data: { lastTickAt } });
      simulationRun = { applied: true, lastTickAt: lastTickAt.toISOString() };
    }

    return { now: now.toISOString(), queueOpen, queue, simulationRun, warnings };
  });

  return { ok: true, result };
}
