-- Task 012 (D-15): SimulationConfig gets per-tier seat-map dimensions so
-- seat count is no longer a fixed 200 across tiers. Added nullable first,
-- backfilled per existing tier row (see docs/ROADMAP.md D-15 target table),
-- then tightened to NOT NULL — no DEFAULT is kept afterward since every
-- writer (prisma/seed.ts) always sets these explicitly per tier.
ALTER TABLE "SimulationConfig" ADD COLUMN     "seatRows" INTEGER;
ALTER TABLE "SimulationConfig" ADD COLUMN     "seatsPerRow" INTEGER;
ALTER TABLE "SimulationConfig" ADD COLUMN     "zoneCount" INTEGER;

UPDATE "SimulationConfig" SET "seatRows" = 25, "seatsPerRow" = 100, "zoneCount" = 8 WHERE "tier" = 'SMALL';
UPDATE "SimulationConfig" SET "seatRows" = 70, "seatsPerRow" = 100, "zoneCount" = 15 WHERE "tier" = 'MEDIUM';
UPDATE "SimulationConfig" SET "seatRows" = 150, "seatsPerRow" = 100, "zoneCount" = 25 WHERE "tier" = 'MEGA';

ALTER TABLE "SimulationConfig" ALTER COLUMN "seatRows" SET NOT NULL;
ALTER TABLE "SimulationConfig" ALTER COLUMN "seatsPerRow" SET NOT NULL;
ALTER TABLE "SimulationConfig" ALTER COLUMN "zoneCount" SET NOT NULL;
