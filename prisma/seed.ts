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
  // D-23: surgeBaseline/admissionRatePerSec/arrivalRatePerSec/botCurveK all
  // jointly re-derived from real-ticketing research (a same-instant click
  // still lands in a tens-of-thousands queue for a popular concert, and
  // reaching the seat screen realistically takes minutes, not seconds) —
  // see ROADMAP D-23 for the full derivation and measured table.
  const simulationConfigs = [
      {
        tier: Tier.SMALL,
        // D-23: click-at-open initial position ~= surgeBaseline (400).
        // wait to admission = surgeBaseline / admissionRatePerSec = 400/2 =
        // 200s (~3m20s) — "within a few minutes" per ROADMAP D-23's SMALL
        // target.
        surgeBaseline: 400,
        arrivalRatePerSec: 2,
        admissionRatePerSec: 2,
        // D-23: re-derived against the new elapsedSinceOpen scale (a SMALL
        // session now reaches the seat screen at ~200s, not ~60-120s) —
        // targets ~25% pool depleted at t=200s. See ROADMAP D-23 for the
        // measured table.
        botCurveK: 0.00144,
        errorRate: 0.02,
        latencyMs: 50,
        // D-15 target seat scale: 25 rows x 100 seats/row = 2,500 seats, 8 zones.
        seatRows: 25,
        seatsPerRow: 100,
        zoneCount: 8,
      },
      {
        tier: Tier.MEDIUM,
        // D-23: wait to admission = 4,000/8 = 500s (~8m20s) — between SMALL
        // and MEGA per ROADMAP D-23's target.
        surgeBaseline: 4_000,
        arrivalRatePerSec: 8,
        admissionRatePerSec: 8,
        // D-23: targets ~60% pool depleted at t=500s (this tier's new
        // arrival elapsed). See ROADMAP D-23 for the measured table.
        botCurveK: 0.00183,
        errorRate: 0.05,
        latencyMs: 150,
        // D-15 target seat scale: 70 rows x 100 seats/row = 7,000 seats, 15 zones.
        seatRows: 70,
        seatsPerRow: 100,
        zoneCount: 15,
      },
      {
        tier: Tier.MEGA,
        // D-23: real-ticketing research (GD 2025 concert: click at open ->
        // ~25,000th in queue; NCT DREAM presale: 1.5M concurrent) puts a
        // MEGA-tier click-at-open position in the tens of thousands —
        // surgeBaseline=40,000 lands inside that range. wait to admission =
        // 40,000/30 = ~1,333s (~22m13s), inside the researched ~20-25min
        // window and safely under the 30min ceiling. See ROADMAP D-23.
        surgeBaseline: 40_000,
        arrivalRatePerSec: 30,
        admissionRatePerSec: 30,
        // D-15 target seat scale: 150 rows x 100 seats/row = 15,000 seats, 25 zones.
        seatRows: 150,
        seatsPerRow: 100,
        zoneCount: 25,
        // D-21 introduced this front-loaded exponential-approach curve;
        // D-23 replaces D-21/D-18's values (tuned for elapsed 0-120s) —
        // the arrival elapsed a MEGA session actually reaches the seat
        // screen at is now ~1,333s, not ~60-120s. Targets ~95% pool
        // depleted at t=1,333s (individual zones landing at/near literal
        // sellout, matching D-21's original "hop to another zone" intent).
        // See ROADMAP D-23 for the measured table across the new scale.
        botCurveK: 0.00225,
        errorRate: 0.1,
        latencyMs: 400,
      },
  ];

  // Upsert by tier (not createMany) so re-seeding an existing DB updates
  // tuning values in place instead of failing on the tier unique
  // constraint — createMany only ever worked for a first-time seed.
  for (const { tier, ...rest } of simulationConfigs) {
    await prisma.simulationConfig.upsert({
      where: { tier },
      update: rest,
      create: { tier, ...rest },
    });
  }

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
