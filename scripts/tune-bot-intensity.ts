// D-21: measures the front-loaded depletion curve
// (claimCount = floor(poolSize * (1 - e^(-botCurveK * elapsedSinceOpen))))
// for a tier's real pool size, using the same production functions real
// traffic goes through (lib/seats.ts's runSeatMapTick), so the measured
// numbers are not a reimplementation that could drift from the real tick
// math.
//
// D-21 replaces this script's old purpose entirely. The pre-D-21 script
// measured SessionResult-style contentionLosses via a "stale snapshot
// probe" (simulating a real user retrying claims against seats it saw
// before the latest tick) — that was the right metric for a LINEAR model
// tuned against lib/result.ts's TIER_BENCHMARKS.maxContentionLosses. D-21
// discards that goal ("avg contentionLosses ~= 6") in favor of realism:
// individual zones selling out fast is now expected, not a bug (see
// ROADMAP D-21's research). What matters now is the DEPLETION CURVE
// SHAPE itself — % of the pool gone at a given elapsed — so this script
// just ticks once at each elapsed checkpoint and reads the pool state
// directly, no probe needed.
//
// Also unlike the old linear model, D-21's target is a pure function of
// elapsedSinceOpen (see lib/simulation.ts's computeBotClaimCount) — for a
// FRESH run (nothing claimed before this tick), the result at a given
// elapsed is fully deterministic. `--trials` here is a small sanity check
// that this determinism actually holds (stddev should print as 0.00), not
// a way to average out real randomness the way the old contentionLosses
// probe needed.
//
// Usage: npx tsx scripts/tune-bot-intensity.ts --tier=MEGA --trials=3 [--botCurveK=0.034] [--elapsedSeconds=0,5,10,20,30,45,60,90,120]
//
// lib/seats.ts -> lib/db.ts reads process.env.DATABASE_URL at module
// top level (eagerly), and ESM hoists static imports ahead of this
// file's own dotenv.config() call regardless of source order (the same
// reason prisma/seed.ts avoids importing lib/db.ts, and route.test.ts
// dynamic-imports "./route"). Dynamic import() below defers evaluation
// until after config() has actually run.
import { config } from "dotenv";

config({ path: ".env.local" });
config();

interface TrialResult {
  /** % of the pool (0-100) no longer AVAILABLE after one tick at this elapsed */
  depletedPct: number;
  soldOut: boolean;
}

function parseArgs(tierValues: string[]) {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }
  const tier = (args.get("tier") ?? "MEGA").toUpperCase();
  if (!tierValues.includes(tier)) {
    throw new Error(`Unknown tier: ${tier}`);
  }
  const trials = Number(args.get("trials") ?? "3");
  const botCurveKOverride = args.has("botCurveK") ? Number(args.get("botCurveK")) : undefined;
  // D-21: elapsed since queueOpenAt (sale considered open) — the checkpoints
  // the user's request specified, covering a fast arrival through a slow one.
  // D-23: default range extended from D-21's 0-120s to 0-1800s (30min) —
  // surgeBaseline (D-23) means a session now realistically reaches the seat
  // screen at ~200s (SMALL) to ~1,333s (MEGA), not within the first two
  // minutes, so the old 0-120s sweep no longer covers the elapsed values
  // that actually matter. See ROADMAP D-23 for the measured table.
  const elapsedSecondsList = (args.get("elapsedSeconds") ?? "0,60,200,300,500,700,1000,1200,1333,1500,1800")
    .split(",")
    .map((s) => Number(s.trim()));
  return { tier, trials, botCurveKOverride, elapsedSecondsList };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

async function main() {
  const { getTestDb } = await import("../lib/test-db");
  const { Tier, SeatStatus, SimulationRunStatus } = await import("../lib/types");
  const { runSeatMapTick } = await import("../lib/seats");

  const { tier, trials, botCurveKOverride, elapsedSecondsList } = parseArgs(Object.values(Tier));
  const db = getTestDb();

  async function runTrial(seatRows: number, seatsPerRow: number, elapsedSeconds: number): Promise<TrialResult> {
    const poolSize = seatRows * seatsPerRow;
    const concert = await db.concert.create({
      data: { title: "tune-bot-intensity probe", venue: "tune-bot-intensity", openAt: new Date(0) },
    });
    const t0 = new Date();
    const run = await db.simulationRun.create({
      data: {
        concertId: concert.id,
        sessionId: `tune-bot-intensity-run-${concert.id}`,
        tier: tier as (typeof Tier)[keyof typeof Tier],
        status: SimulationRunStatus.ACTIVE,
        queueOpenAt: t0, // D-21: the fixed anchor computeBotClaimCount measures elapsed from
      },
    });

    try {
      // D-15: numeric row labels, tier-parameterized pool size (mirrors
      // app/api/session/route.ts).
      const rowLabels = Array.from({ length: seatRows }, (_, i) => String(i + 1));
      await db.seat.createMany({
        data: rowLabels.flatMap((row) =>
          Array.from({ length: seatsPerRow }, (_, i) => ({
            concertId: concert.id,
            simulationRunId: run.id,
            row,
            number: i + 1,
          }))
        ),
      });

      const now = new Date(t0.getTime() + elapsedSeconds * 1000);
      await runSeatMapTick({ runId: run.id, now });

      const availableSeatCount = await db.seat.count({
        where: { simulationRunId: run.id, status: SeatStatus.AVAILABLE },
      });
      const depletedPct = ((poolSize - availableSeatCount) / poolSize) * 100;
      return { depletedPct, soldOut: availableSeatCount === 0 };
    } finally {
      await db.hold.deleteMany({ where: { seat: { simulationRunId: run.id } } });
      await db.seat.deleteMany({ where: { simulationRunId: run.id } });
      await db.simulationRun.delete({ where: { id: run.id } });
      await db.concert.delete({ where: { id: concert.id } });
    }
  }

  try {
    const currentConfig = await db.simulationConfig.findUniqueOrThrow({ where: { tier: tier as (typeof Tier)[keyof typeof Tier] } });
    let botCurveK = currentConfig.botCurveK;

    if (botCurveKOverride !== undefined) {
      await db.simulationConfig.update({
        where: { tier: tier as (typeof Tier)[keyof typeof Tier] },
        data: { botCurveK: botCurveKOverride },
      });
      botCurveK = botCurveKOverride;
    }

    const poolSize = currentConfig.seatRows * currentConfig.seatsPerRow;
    console.log(
      `tier=${tier} botCurveK=${botCurveK} trials=${trials} elapsedSeconds=[${elapsedSecondsList.join(",")}] seatRows=${currentConfig.seatRows} seatsPerRow=${currentConfig.seatsPerRow} (${poolSize} seats)`
    );

    const perElapsedSummaries: Array<{ elapsedSeconds: number; avgDepletedPct: number; soldOutRate: number }> = [];

    for (const elapsedSeconds of elapsedSecondsList) {
      const results: TrialResult[] = [];
      for (let i = 1; i <= trials; i++) {
        const result = await runTrial(currentConfig.seatRows, currentConfig.seatsPerRow, elapsedSeconds);
        results.push(result);
      }

      const depletedPcts = results.map((r) => r.depletedPct);
      const soldOutCount = results.filter((r) => r.soldOut).length;
      const avgDepletedPct = mean(depletedPcts);
      perElapsedSummaries.push({ elapsedSeconds, avgDepletedPct, soldOutRate: soldOutCount / trials });

      console.log(
        `  elapsedSeconds=${elapsedSeconds}: avgDepleted=${avgDepletedPct.toFixed(1)}% stddev=${stddev(depletedPcts).toFixed(3)} min=${Math.min(...depletedPcts).toFixed(1)}% max=${Math.max(...depletedPcts).toFixed(1)}% soldOut=${soldOutCount}/${trials}`
      );
    }

    console.log(`\nsummary: tier=${tier} botCurveK=${botCurveK} poolSize=${poolSize}`);
    console.log("  elapsed(s) | depleted% | soldOut%");
    for (const s of perElapsedSummaries) {
      console.log(
        `  ${String(s.elapsedSeconds).padStart(10)} | ${s.avgDepletedPct.toFixed(1).padStart(9)} | ${(s.soldOutRate * 100).toFixed(0).padStart(8)}`
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
