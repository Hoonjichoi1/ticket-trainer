import { config } from "dotenv";
import { PrismaClient, Tier } from "../lib/generated/prisma/client";
import { createPrismaAdapter } from "../lib/prisma-adapter";

// Loaded explicitly so this script also works when run directly via
// `tsx prisma/seed.ts`, not only through `prisma db seed`.
config({ path: ".env.local" });
config();

const adapter = createPrismaAdapter(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

const ROWS = 10;
const SEATS_PER_ROW = 20; // 10 x 20 = 200 seats

async function main() {
  const concert = await prisma.concert.create({
    data: {
      title: "Seed Concert: Sample Tour 2026",
      // Relative to seeding time (not a fixed past date) so re-seeding
      // always produces a testable near-future open — with D-4's
      // arrival-rate-based initial queue position, a stale far-past
      // openAt would make the initial position astronomically large.
      openAt: new Date(Date.now() + 5 * 60_000),
      venue: "Sample Arena",
    },
  });

  // Seed data needs a SimulationRun to satisfy Seat.simulationRunId (required FK).
  const seedRun = await prisma.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId: "seed-session",
      tier: Tier.SMALL,
    },
  });

  const rowLabels = Array.from({ length: ROWS }, (_, i) =>
    String.fromCharCode("A".charCodeAt(0) + i)
  );

  await prisma.seat.createMany({
    data: rowLabels.flatMap((row) =>
      Array.from({ length: SEATS_PER_ROW }, (_, i) => ({
        concertId: concert.id,
        simulationRunId: seedRun.id,
        row,
        number: i + 1,
      }))
    ),
  });

  // Tuning values are placeholders — PRD doesn't specify exact numbers;
  // revisit during simulation-engine tuning (Task 007+). arrivalRatePerSec
  // mirrors admissionRatePerSec per tier (ROADMAP D-4) purely for clean,
  // predictable numbers during manual testing — not a real tuning claim.
  await prisma.simulationConfig.createMany({
    data: [
      {
        tier: Tier.SMALL,
        arrivalRatePerSec: 5,
        admissionRatePerSec: 5,
        botIntensity: 0.1,
        errorRate: 0.02,
        latencyMs: 50,
        // D-15 target seat scale: 25 rows x 100 seats/row = 2,500 seats, 8 zones.
        seatRows: 25,
        seatsPerRow: 100,
        zoneCount: 8,
      },
      {
        tier: Tier.MEDIUM,
        arrivalRatePerSec: 20,
        admissionRatePerSec: 20,
        botIntensity: 0.4,
        errorRate: 0.05,
        latencyMs: 150,
        // D-15 target seat scale: 70 rows x 100 seats/row = 7,000 seats, 15 zones.
        seatRows: 70,
        seatsPerRow: 100,
        zoneCount: 15,
      },
      {
        tier: Tier.MEGA,
        arrivalRatePerSec: 50,
        admissionRatePerSec: 50,
        // D-15 target seat scale: 150 rows x 100 seats/row = 15,000 seats, 25 zones.
        seatRows: 150,
        seatsPerRow: 100,
        zoneCount: 25,
        // Empirically tuned (scripts/tune-bot-intensity.ts) against
        // lib/result.ts's TIER_BENCHMARKS.MEGA.maxContentionLosses=6: with
        // a fixed 200-seat pool, average contentionLosses only becomes
        // non-negligible once the bot depletes most of the pool within the
        // first ~2s tick (negative-hypergeometric collision odds), and that
        // region sits close to a "seats sell out before the player gets
        // one" cliff around botIntensity~100-110. 80 lands conservatively
        // below the cliff (measured avg ~4.2 over 30 trials, no sellouts)
        // rather than chasing the benchmark exactly.
        botIntensity: 80,
        errorRate: 0.1,
        latencyMs: 400,
      },
    ],
  });

  console.log(
    `Seeded: 1 concert, ${ROWS * SEATS_PER_ROW} seats, 3 simulation configs.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
