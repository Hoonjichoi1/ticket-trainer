// Tick orchestrator (Task 007) — the "caller" lib/simulation.ts's pure
// functions defer DB I/O to.
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { Tier } from "@/lib/types";
import { computeBotClaimCount, computeElapsedTime, type BotClaimResult } from "@/lib/simulation";

export interface AdvanceTickParams {
  runId: string;
  /** caller-supplied "current" time — never Date.now() internally, mirrors lib/simulation.ts's purity contract */
  now: Date;
  /** count of currently-AVAILABLE seats for this run, for capping bot claims */
  availableSeatCount: number;
}

export interface AdvanceTickResult {
  runId: string;
  /** SimulationRun.queueOpenAt — the fixed anchor D-21's curve is measured from */
  queueOpenAt: Date;
  elapsedSeconds: number;
  botClaim: BotClaimResult;
}

/**
 * Reads SimulationRun.queueOpenAt (D-21's fixed curve anchor — see
 * lib/simulation.ts's BotClaimInput.elapsedSinceOpen for why this must be
 * a fixed reference rather than a per-tick delta) and this run's
 * seatRows/seatsPerRow (D-15, to get poolSize), then computes how many
 * seats the bot should claim this tick.
 *
 * D-21 dropped the old lastTickAt carry-forward mechanism entirely: the
 * pre-D-21 linear model needed it because naively re-anchoring elapsed to
 * "now" every tick would floor away fractional bot progress under
 * frequent polling. D-21's curve is instead an ABSOLUTE cumulative target
 * (see lib/simulation.ts), so there's no fractional progress to lose —
 * the same elapsedSinceOpen always yields the same target regardless of
 * tick history, and each tick just claims the gap to that target.
 * SimulationRun.lastTickAt still exists in the schema (unused by this
 * function now) rather than being migrated away, to keep this change
 * scoped to the claim formula — see ROADMAP D-21.
 *
 * Concurrency note: still locks the SimulationRun row (`SELECT ... FOR
 * UPDATE`) for consistency with the rest of the tick pipeline, but
 * `availableSeatCount` is read by the caller before this transaction
 * starts (unchanged from pre-D-21), so two truly concurrent ticks for the
 * same run can each compute against a slightly stale availableSeatCount
 * and together overshoot the target — a known, accepted gap (D-21), not
 * present in the old model's stricter serialization, but out of scope
 * here since it would require restructuring the caller/callee boundary
 * D-20 (claimSeatsBatch) deliberately left alone.
 */
export async function advanceTick(params: AdvanceTickParams): Promise<AdvanceTickResult> {
  const { runId, now, availableSeatCount } = params;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<Array<{ queueOpenAt: Date; tier: Tier }>>`
      SELECT "queueOpenAt", "tier" FROM "SimulationRun" WHERE id = ${runId} FOR UPDATE
    `;
    const run = rows[0];
    if (!run) {
      throw new Error(`advanceTick: SimulationRun not found: ${runId}`);
    }

    const config = await tx.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });
    const poolSize = config.seatRows * config.seatsPerRow;

    const elapsedSinceOpen = computeElapsedTime({ since: run.queueOpenAt, now });
    const botClaim = computeBotClaimCount({
      elapsedSinceOpen,
      botCurveK: config.botCurveK,
      poolSize,
      availableSeatCount,
    });

    return { runId, queueOpenAt: run.queueOpenAt, elapsedSeconds: elapsedSinceOpen.seconds, botClaim };
  });
}
