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
  // D-23 (2nd revision): surgeBaseline is now the position reached at
  // exactly SURGE_WINDOW_SECONDS (1s) after open, not a flat floor — see
  // lib/simulation.ts's computeInitialQueuePosition and ROADMAP D-23 for
  // the full derivation (seatCount * ~5/3 research-based multiplier) and
  // measured table. admissionRatePerSec/botCurveK/targetTotalMs re-derived
  // alongside it to keep each tier's total queue-wait target unchanged.
  const simulationConfigs = [
      {
        tier: Tier.SMALL,
        // D-23 (2nd rev): surgeBaseline = 2,500 seats * ~5/3 = 4,167 (same
        // research-based multiplier as MEDIUM/MEGA, see ROADMAP D-23 — no
        // SMALL-tier real-world queue data was found, so consistency with
        // the other tiers' multiplier was chosen over an unfounded
        // SMALL-specific guess). wait to admission = surgeBaseline /
        // admissionRatePerSec = 4,167/20.84 = ~200s (~3m20s), unchanged
        // from the 1st revision's SMALL target.
        surgeBaseline: 4_167,
        arrivalRatePerSec: 20.84,
        admissionRatePerSec: 20.84,
        // D-23: targets ~25% pool depleted at t=200s (this tier's arrival
        // elapsed, unchanged by the 2nd revision since the wait target
        // didn't move). See ROADMAP D-23 for the measured table.
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
        // D-23 (2nd rev): surgeBaseline = 7,000 seats * ~5/3 = 11,667.
        // wait to admission = 11,667/23.33 = ~500s (~8m20s), unchanged from
        // the 1st revision's MEDIUM target — between SMALL and MEGA.
        surgeBaseline: 11_667,
        arrivalRatePerSec: 23.33,
        admissionRatePerSec: 23.33,
        // D-23: targets ~60% pool depleted at t=500s (unchanged). See
        // ROADMAP D-23 for the measured table.
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
        // D-23 (2nd rev): the 1st revision's flat surgeBaseline=40,000 was
        // an ungrounded estimate — re-verified against real-ticketing
        // research (GD 2025 concert, a venue/pool size close to MEGA's
        // 15,000 seats: a user who clicked at open but self-reported as
        // "on the slower side" landed at position ~25,000, i.e. ~1.67x
        // seat count) and revised down: surgeBaseline = 15,000 * 5/3 =
        // 25,000, landing exactly on that research anchor. wait to
        // admission = 25,000/18.75 = ~1,333s (~22m13s) — deliberately kept
        // unchanged from the 1st revision's target (inside the researched
        // ~20-25min window, safely under the 30min ceiling) by solving
        // admissionRatePerSec for the same wait given the new,
        // research-grounded surgeBaseline. See ROADMAP D-23.
        surgeBaseline: 25_000,
        arrivalRatePerSec: 18.75,
        admissionRatePerSec: 18.75,
        // D-15 target seat scale: 150 rows x 100 seats/row = 15,000 seats, 25 zones.
        seatRows: 150,
        seatsPerRow: 100,
        zoneCount: 25,
        // D-21 introduced this front-loaded exponential-approach curve;
        // D-23 targets ~95% pool depleted at t=1,333s (this tier's arrival
        // elapsed, unchanged by the 2nd revision since the wait target
        // didn't move — see ROADMAP D-23 for the measured table).
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
