// Measures SessionResult.contentionLosses for a tier's seat-selection stage
// using the same production functions real traffic goes through
// (lib/seats.ts's runSeatMapTick/claimSeat), so the measured numbers are
// not a reimplementation that could drift from the real tick math.
//
// Why contentionLosses needs a "stale snapshot" probe, not "act on the
// freshest data": POST /api/seats never triggers a new tick (only
// GET -> runSeatMapTick does), so a claim made against the seat map's
// current, just-refreshed state can never lose a race — there's
// structurally no time for the bot to claim anything in between. A
// conflict is only possible when the probe acts on seats it saw before
// the most recent tick, because the seat map's own 2-second auto-refresh
// (PRD F007) is what can have moved on since then.
//
// Per tick: the probe retries immediately against seats from its last
// known (pre-tick) snapshot, one at a time without repeating a seat,
// exactly as spec'd ("실패 시 즉시 다른 좌석 재시도", PRD 좌석 선택 페이지) —
// until one succeeds or the whole snapshot is exhausted, then it takes a
// fresh snapshot for the next tick. No timing constant beyond the
// already-documented 2-second poll interval is introduced; "immediately"
// retrying different seats from the same known list needs no elapsed-time
// assumption since nothing in the DB changes between those attempts
// (bot claims only happen inside a tick).
//
// Usage: npx tsx scripts/tune-bot-intensity.ts --tier=MEGA --trials=8 [--botIntensity=1.2]
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

const TICK_MS = 2000;
const MAX_TICKS = 150; // 300s safety cap; well past any tier's targetTotalMs
const SEAT_ROWS = 10;
const SEATS_PER_ROW = 20; // 200 seats, mirrors app/api/session/route.ts

interface TrialResult {
  contentionLosses: number;
  ticksUsed: number;
  succeeded: boolean;
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
  const trials = Number(args.get("trials") ?? "8");
  const botIntensityOverride = args.has("botIntensity") ? Number(args.get("botIntensity")) : undefined;
  return { tier, trials, botIntensityOverride };
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
  const { runSeatMapTick, claimSeat } = await import("../lib/seats");

  const { tier, trials, botIntensityOverride } = parseArgs(Object.values(Tier));
  const db = getTestDb();

  async function runTrial(): Promise<TrialResult> {
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
        lastTickAt: t0,
      },
    });

    try {
      const rowLabels = Array.from({ length: SEAT_ROWS }, (_, i) => String.fromCharCode(65 + i));
      await db.seat.createMany({
        data: rowLabels.flatMap((row) =>
          Array.from({ length: SEATS_PER_ROW }, (_, i) => ({
            concertId: concert.id,
            simulationRunId: run.id,
            row,
            number: i + 1,
          }))
        ),
      });

      const probeSessionId = `tune-bot-intensity-probe-${run.id}`;
      let losses = 0;
      let now = t0;

      // Initial snapshot: the full pool, before any bot tick has run —
      // what the probe would see on first landing on the seat map.
      let staleSnapshot = (
        await db.seat.findMany({
          where: { simulationRunId: run.id, status: SeatStatus.AVAILABLE },
          select: { id: true },
        })
      ).map((s) => s.id);

      for (let tick = 1; tick <= MAX_TICKS; tick++) {
        now = new Date(now.getTime() + TICK_MS);
        await runSeatMapTick({ runId: run.id, now });

        const candidates = [...staleSnapshot].sort(() => Math.random() - 0.5);
        let succeeded = false;
        for (const seatId of candidates) {
          const result = await claimSeat({ seatId, sessionId: probeSessionId, now });
          if (result.status === "held") {
            succeeded = true;
            break;
          }
          losses++;
        }
        if (succeeded) {
          return { contentionLosses: losses, ticksUsed: tick, succeeded: true };
        }

        // Exhausted everything the probe knew about — take a fresh
        // snapshot (next poll) and keep going.
        const available = await db.seat.findMany({
          where: { simulationRunId: run.id, status: SeatStatus.AVAILABLE },
          select: { id: true },
        });
        if (available.length === 0) {
          break;
        }
        staleSnapshot = available.map((s) => s.id);
      }

      return { contentionLosses: losses, ticksUsed: MAX_TICKS, succeeded: false };
    } finally {
      await db.hold.deleteMany({ where: { seat: { simulationRunId: run.id } } });
      await db.seat.deleteMany({ where: { simulationRunId: run.id } });
      await db.simulationRun.delete({ where: { id: run.id } });
      await db.concert.delete({ where: { id: concert.id } });
    }
  }

  try {
    const currentConfig = await db.simulationConfig.findUniqueOrThrow({ where: { tier: tier as (typeof Tier)[keyof typeof Tier] } });
    let botIntensity = currentConfig.botIntensity;

    if (botIntensityOverride !== undefined) {
      await db.simulationConfig.update({
        where: { tier: tier as (typeof Tier)[keyof typeof Tier] },
        data: { botIntensity: botIntensityOverride },
      });
      botIntensity = botIntensityOverride;
    }

    console.log(`tier=${tier} botIntensity=${botIntensity} trials=${trials}`);

    const results: TrialResult[] = [];
    for (let i = 1; i <= trials; i++) {
      const result = await runTrial();
      results.push(result);
      console.log(
        `  trial ${i}: contentionLosses=${result.contentionLosses} ticksUsed=${result.ticksUsed} succeeded=${result.succeeded}`
      );
    }

    const losses = results.map((r) => r.contentionLosses);
    console.log(
      `\nsummary: tier=${tier} botIntensity=${botIntensity} avgContentionLosses=${mean(losses).toFixed(2)} stddev=${stddev(losses).toFixed(2)} min=${Math.min(...losses)} max=${Math.max(...losses)}`
    );
    if (results.some((r) => !r.succeeded)) {
      console.warn(
        `  warning: ${results.filter((r) => !r.succeeded).length}/${trials} trial(s) never succeeded within ${MAX_TICKS} ticks`
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
