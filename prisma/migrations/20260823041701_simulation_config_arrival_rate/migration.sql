-- AlterTable
-- ROADMAP D-4: replace the fixed per-tier virtualQueueSize with a
-- dynamic arrival-rate coefficient. Added nullable first so existing
-- rows can be backfilled, then set NOT NULL — a plain ADD COLUMN with
-- no default would fail against the 3 pre-existing SimulationConfig rows.
ALTER TABLE "SimulationConfig" ADD COLUMN     "arrivalRatePerSec" DOUBLE PRECISION;

-- Backfill: mirror admissionRatePerSec per row (matches prisma/seed.ts's
-- new placeholder values, chosen for clean round numbers in tests).
UPDATE "SimulationConfig" SET "arrivalRatePerSec" = "admissionRatePerSec";

ALTER TABLE "SimulationConfig" ALTER COLUMN "arrivalRatePerSec" SET NOT NULL;

-- AlterTable
ALTER TABLE "SimulationConfig" DROP COLUMN "virtualQueueSize";
