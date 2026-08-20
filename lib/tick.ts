// Tick orchestrator (Task 007) — the "caller" lib/simulation.ts's pure
// functions defer DB I/O to. Owns the one piece of shared mutable state
// the tick engine has: SimulationRun.lastTickAt.
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
  /** SimulationRun.lastTickAt before this tick */
  previousLastTickAt: Date;
  /** SimulationRun.lastTickAt after this tick (may be < now — see carry-forward note below) */
  newLastTickAt: Date;
  elapsedSeconds: number;
  botClaim: BotClaimResult;
}

/**
 * Reads SimulationRun.lastTickAt, computes how many seats the bot should
 * claim this tick, and advances lastTickAt — all inside one DB
 * transaction so concurrent tick requests for the same run serialize
 * instead of double-advancing.
 *
 * Concurrency: the initial read uses `SELECT ... FOR UPDATE` on the
 * SimulationRun row. A second concurrent call for the same runId blocks
 * on that lock until the first transaction commits, then reads the
 * already-advanced lastTickAt as its own baseline — so the two calls
 * split the elapsed wall-clock time instead of both computing a claim
 * over the full (double-counted) span.
 *
 * Carry-forward instead of an accumulator field: naively setting
 * lastTickAt = now every tick would floor away fractional bot progress
 * under frequent low-intensity polling (see lib/simulation.ts's header
 * comment). Instead, lastTickAt only advances by the time equivalent of
 * the *whole* seats actually claimed this tick (claimCount / botIntensity
 * seconds) — the unclaimed remainder stays as unelapsed time and is
 * picked up by the next tick's `now - lastTickAt`. No schema change
 * needed; this module is the only place that reads or writes lastTickAt.
 */
export async function advanceTick(params: AdvanceTickParams): Promise<AdvanceTickResult> {
  const { runId, now, availableSeatCount } = params;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<Array<{ lastTickAt: Date; tier: Tier }>>`
      SELECT "lastTickAt", "tier" FROM "SimulationRun" WHERE id = ${runId} FOR UPDATE
    `;
    const run = rows[0];
    if (!run) {
      throw new Error(`advanceTick: SimulationRun not found: ${runId}`);
    }
    const previousLastTickAt = run.lastTickAt;

    const config = await tx.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });

    const elapsed = computeElapsedTime({ since: previousLastTickAt, now });
    const botClaim = computeBotClaimCount({
      elapsed,
      botIntensity: config.botIntensity,
      availableSeatCount,
    });

    const consumedSeconds =
      config.botIntensity > 0 ? botClaim.claimCount / config.botIntensity : elapsed.seconds;
    const newLastTickAt = new Date(previousLastTickAt.getTime() + consumedSeconds * 1000);

    await tx.simulationRun.update({
      where: { id: runId },
      data: { lastTickAt: newLastTickAt },
    });

    return { runId, previousLastTickAt, newLastTickAt, elapsedSeconds: elapsed.seconds, botClaim };
  });
}
