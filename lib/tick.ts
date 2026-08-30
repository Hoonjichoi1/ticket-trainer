// Tick orchestrator (Task 007) — the "caller" lib/simulation.ts's pure
// functions defer DB I/O to.
import type { Prisma } from "@/lib/generated/prisma/client";
import { SeatStatus, Tier } from "@/lib/types";
import { computeBotClaimCount, computeElapsedTime, type BotClaimResult } from "@/lib/simulation";

// D-25: the per-tier admission throughput (seats/sec) each tier's
// botCurveK was tuned against (see prisma/seed.ts's admissionRatePerSec at
// D-23 tuning time). Deliberately a frozen snapshot, NOT re-read from the
// live SimulationConfig row below — cumulativeArrivals is derived from the
// LIVE config.admissionRatePerSec, so keeping this baseline separate is
// what lets the two diverge if a tier's actual admission pace is ever
// retuned in SimulationConfig without also retuning botCurveK to match
// (see lib/simulation.ts's BotClaimInput.arrivalScaleFactor) — that
// divergence, and the resulting faster/slower depletion, is the point, not
// a bug. If botCurveK is ever retuned, re-derive this alongside it from
// whatever admissionRatePerSec the new botCurveK was tuned against.
const DESIGNED_ADMISSION_RATE_PER_SEC: Record<Tier, number> = {
  [Tier.SMALL]: 20.84,
  [Tier.MEDIUM]: 23.33,
  [Tier.MEGA]: 18.75,
};

export interface AdvanceTickParams {
  runId: string;
  /** caller-supplied "current" time — never Date.now() internally, mirrors lib/simulation.ts's purity contract */
  now: Date;
  /**
   * The transaction this tick's SimulationRun lock and availableSeatCount
   * read must run in — see the concurrency note below. Always the same
   * transaction the caller (lib/seats.ts's runSeatMapTick) also executes
   * its claimSeatsBatch call in, never a fresh one opened here.
   */
  tx: Prisma.TransactionClient;
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
 * lib/simulation.ts's BotClaimInput.cumulativeArrivals for why this must be
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
 * D-22 concurrency fix: locks the SimulationRun row (`SELECT ... FOR
 * UPDATE`) *and* reads availableSeatCount from inside that same locked
 * transaction (previously the caller read availableSeatCount before this
 * function's own separate transaction even began, D-21). Two real
 * concurrent ticks for the same run (confirmed to happen in practice —
 * React Strict Mode's dev-only double-invoke fires two overlapping GET
 * /api/seats requests on every zone entry, and any two-tab session does
 * the same in production) now serialize on this row lock: the second
 * tick blocks until the first's transaction — which also executes its
 * claimSeatsBatch call before committing, see runSeatMapTick — fully
 * commits, then re-reads availableSeatCount reflecting the first tick's
 * claim. Measured to eliminate the overshoot entirely (see ROADMAP D-22;
 * previously measured at up to 2x the intended target, e.g. 14,800
 * claimed against a 7,400 target for MEGA at elapsed=20s).
 */
export async function advanceTick(params: AdvanceTickParams): Promise<AdvanceTickResult> {
  const { runId, now, tx } = params;

  const rows = await tx.$queryRaw<Array<{ queueOpenAt: Date; tier: Tier }>>`
    SELECT "queueOpenAt", "tier" FROM "SimulationRun" WHERE id = ${runId} FOR UPDATE
  `;
  const run = rows[0];
  if (!run) {
    throw new Error(`advanceTick: SimulationRun not found: ${runId}`);
  }

  const config = await tx.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });
  const poolSize = config.seatRows * config.seatsPerRow;

  // Read strictly after the FOR UPDATE lock above — a concurrent tick
  // blocked on that lock only reaches this line once it's unblocked, by
  // which point the previous tick's claim has already committed, so this
  // read always reflects it.
  const availableSeatCount = await tx.seat.count({
    where: { simulationRunId: runId, status: SeatStatus.AVAILABLE },
  });

  const elapsedSinceOpen = computeElapsedTime({ since: run.queueOpenAt, now });
  // D-25: cumulative virtual admissions since queueOpenAt, using this
  // tier's LIVE admissionRatePerSec (see lib/queue.ts's computeQueuePosition
  // for the same admission-drain model) — deliberately not the frozen
  // DESIGNED_ADMISSION_RATE_PER_SEC baseline passed as arrivalScaleFactor
  // below, so the two can diverge (see that constant's doc comment).
  const cumulativeArrivals = config.admissionRatePerSec * elapsedSinceOpen.seconds;
  const botClaim = computeBotClaimCount({
    cumulativeArrivals,
    arrivalScaleFactor: DESIGNED_ADMISSION_RATE_PER_SEC[run.tier],
    botCurveK: config.botCurveK,
    poolSize,
    availableSeatCount,
  });

  return { runId, queueOpenAt: run.queueOpenAt, elapsedSeconds: elapsedSinceOpen.seconds, botClaim };
}
