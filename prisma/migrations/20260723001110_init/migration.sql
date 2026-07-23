-- CreateEnum
CREATE TYPE "SeatStatus" AS ENUM ('AVAILABLE', 'HELD', 'SOLD');

-- CreateEnum
CREATE TYPE "QueueEntryStatus" AS ENUM ('WAITING', 'ADMITTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('SMALL', 'MEDIUM', 'MEGA');

-- CreateEnum
CREATE TYPE "SessionOutcome" AS ENUM ('SUCCESS', 'QUEUE_TIMEOUT', 'SEAT_LOST', 'PAYMENT_FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SimulationRunStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Concert" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "openAt" TIMESTAMP(3) NOT NULL,
    "venue" TEXT NOT NULL,

    CONSTRAINT "Concert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" TEXT NOT NULL,
    "concertId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "status" "SimulationRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastTickAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "concertId" TEXT NOT NULL,
    "simulationRunId" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "SeatStatus" NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "concertId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "concertId" TEXT NOT NULL,
    "simulationRunId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "admissionToken" TEXT,
    "status" "QueueEntryStatus" NOT NULL DEFAULT 'WAITING',

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationConfig" (
    "id" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "virtualQueueSize" INTEGER NOT NULL,
    "admissionRatePerSec" DOUBLE PRECISION NOT NULL,
    "botIntensity" DOUBLE PRECISION NOT NULL,
    "errorRate" DOUBLE PRECISION NOT NULL,
    "latencyMs" INTEGER NOT NULL,

    CONSTRAINT "SimulationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionResult" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "outcome" "SessionOutcome" NOT NULL,
    "stageTimings" JSONB NOT NULL,
    "contentionLosses" INTEGER NOT NULL,
    "events" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimulationRun_sessionId_idx" ON "SimulationRun"("sessionId");

-- CreateIndex
CREATE INDEX "SimulationRun_concertId_idx" ON "SimulationRun"("concertId");

-- CreateIndex
CREATE INDEX "Seat_concertId_idx" ON "Seat"("concertId");

-- CreateIndex
CREATE INDEX "Seat_simulationRunId_idx" ON "Seat"("simulationRunId");

-- CreateIndex
CREATE INDEX "Hold_expiresAt_idx" ON "Hold"("expiresAt");

-- CreateIndex
CREATE INDEX "Hold_seatId_expiresAt_idx" ON "Hold"("seatId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "hold_seat_active_unique" ON "Hold"("seatId") WHERE ("releasedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Booking_seatId_key" ON "Booking"("seatId");

-- CreateIndex
CREATE INDEX "Booking_concertId_idx" ON "Booking"("concertId");

-- CreateIndex
CREATE INDEX "Booking_sessionId_idx" ON "Booking"("sessionId");

-- CreateIndex
CREATE INDEX "QueueEntry_concertId_sessionId_idx" ON "QueueEntry"("concertId", "sessionId");

-- CreateIndex
CREATE INDEX "QueueEntry_simulationRunId_idx" ON "QueueEntry"("simulationRunId");

-- CreateIndex
CREATE UNIQUE INDEX "SimulationConfig_tier_key" ON "SimulationConfig"("tier");

-- CreateIndex
CREATE INDEX "SessionResult_sessionId_idx" ON "SessionResult"("sessionId");

-- AddForeignKey
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_concertId_fkey" FOREIGN KEY ("concertId") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_concertId_fkey" FOREIGN KEY ("concertId") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_simulationRunId_fkey" FOREIGN KEY ("simulationRunId") REFERENCES "SimulationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_concertId_fkey" FOREIGN KEY ("concertId") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_concertId_fkey" FOREIGN KEY ("concertId") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_simulationRunId_fkey" FOREIGN KEY ("simulationRunId") REFERENCES "SimulationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
