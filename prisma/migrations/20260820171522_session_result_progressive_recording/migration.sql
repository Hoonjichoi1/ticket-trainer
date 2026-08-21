-- SessionResult becomes a progressively-written row (one per session,
-- upserted starting Task 008) instead of a row created only once at final
-- report time — see prisma/schema.prisma comment above the model.

-- DropIndex
DROP INDEX "SessionResult_sessionId_idx";

-- AlterTable
ALTER TABLE "SessionResult"
  ALTER COLUMN "outcome" DROP NOT NULL,
  ALTER COLUMN "stageTimings" SET DEFAULT '{}',
  ALTER COLUMN "contentionLosses" SET DEFAULT 0,
  ALTER COLUMN "events" SET DEFAULT '[]';

-- CreateIndex
CREATE UNIQUE INDEX "SessionResult_sessionId_key" ON "SessionResult"("sessionId");
