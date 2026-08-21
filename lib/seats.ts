// Seat map / hold-atomicity orchestration (Task 009) — the "caller" layer
// that executes real DB transactions on top of Task 007's pure calculation
// functions (computeBotClaimCount, findExpiredHolds via lib/tick.ts's
// advanceTick) and Task 008's session/observability helpers. Owns the one
// piece of business logic CLAUDE.md calls out as critical: the atomic
// conditional-UPDATE seat claim, executed by both real users and the bot
// through the same claimSeat() function (PRD F008: "서버가 사용자와 동일한
// hold 로직으로 랜덤 좌석을 선점").
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SeatStatus, type SeatSummary, type SeatClaimResponse } from "@/lib/types";
import { findExpiredHolds } from "@/lib/simulation";
import { advanceTick } from "@/lib/tick";
import { recordJudgmentEvent } from "@/lib/session-result";

export const HOLD_DURATION_MS = 5 * 60_000;

const BOT_SESSION_PREFIX = "bot:";

/** The bot doesn't have a real session — this synthesizes a stable, per-run identifier so it can reuse claimSeat/Hold like any other session. */
export function botSessionId(runId: string): string {
  return `${BOT_SESSION_PREFIX}${runId}`;
}

/** True for any sessionId produced by botSessionId() — used to skip SessionResult/observability writes for the bot's own holds. */
export function isBotSession(sessionId: string): boolean {
  return sessionId.startsWith(BOT_SESSION_PREFIX);
}

/**
 * Atomically claims one seat: `UPDATE "Seat" SET status='HELD' WHERE id=$1
 * AND status='AVAILABLE'` (a single statement, so Postgres serializes
 * concurrent claims on the same row) followed by a Hold insert in the same
 * transaction (CLAUDE.md: Seat.status changes and Hold writes must not be
 * split across transactions). Shared by real user claims (POST /api/seats)
 * and bot claims (runSeatMapTick) — identical logic, different sessionId.
 */
export async function claimSeat(params: {
  seatId: string;
  sessionId: string;
  now: Date;
}): Promise<SeatClaimResponse> {
  const { seatId, sessionId, now } = params;

  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<SeatClaimResponse> => {
    const updated = await tx.seat.updateMany({
      where: { id: seatId, status: SeatStatus.AVAILABLE },
      data: { status: SeatStatus.HELD },
    });

    if (updated.count === 0) {
      return { status: "conflict", code: "SEAT_ALREADY_TAKEN", message: "This seat has already been taken." };
    }

    const expiresAt = new Date(now.getTime() + HOLD_DURATION_MS);
    await tx.hold.create({ data: { seatId, sessionId, expiresAt } });

    return { status: "held", holdExpiresAt: expiresAt.toISOString() };
  });
}

export interface ReleaseExpiredHoldsResult {
  releasedSeatIds: string[];
}

/**
 * Releases every expired active hold (releasedAt IS NULL, expiresAt < now)
 * for a run's seats: sets Hold.releasedAt and flips Seat.status back to
 * AVAILABLE in the same transaction (CLAUDE.md). Records a hold_expired
 * judgment event for user sessions only — the bot's synthetic sessionId
 * never gets a SessionResult row.
 */
export async function releaseExpiredHolds(params: {
  runId: string;
  now: Date;
}): Promise<ReleaseExpiredHoldsResult> {
  const { runId, now } = params;

  const activeHolds = await prisma.hold.findMany({
    where: { releasedAt: null, seat: { simulationRunId: runId } },
    select: { id: true, seatId: true, expiresAt: true, sessionId: true },
  });
  if (activeHolds.length === 0) return { releasedSeatIds: [] };

  const { expired } = findExpiredHolds({ holds: activeHolds, now });
  if (expired.length === 0) return { releasedSeatIds: [] };

  const sessionIdByHoldId = new Map(activeHolds.map((hold) => [hold.id, hold.sessionId]));

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const { holdId, seatId } of expired) {
      await tx.hold.update({ where: { id: holdId }, data: { releasedAt: now } });
      await tx.seat.update({ where: { id: seatId }, data: { status: SeatStatus.AVAILABLE } });

      const sessionId = sessionIdByHoldId.get(holdId);
      if (sessionId && !isBotSession(sessionId)) {
        await recordJudgmentEvent(tx, sessionId, {
          type: "hold_expired",
          stage: "seat_selection",
          seatId,
          timestamp: now.toISOString(),
        });
      }
    }
  });

  return { releasedSeatIds: expired.map((e) => e.seatId) };
}

/**
 * True iff seatId exists and belongs to runId. Every Seat is created for
 * exactly one SimulationRun and never reassigned, so this is a plain
 * lookup (no race to guard against) — used by the API route to reject a
 * claim for a seatId from a different session's independent run (D-1:
 * each session gets its own seat map/queue instance).
 */
export async function seatBelongsToRun(params: { seatId: string; runId: string }): Promise<boolean> {
  const seat = await prisma.seat.findUnique({ where: { id: params.seatId }, select: { simulationRunId: true } });
  return seat?.simulationRunId === params.runId;
}

/** Full seat map for a run (~200 seats), mapped to the SeatMapResponse shape. */
export async function listSeatMap(params: { runId: string }): Promise<SeatSummary[]> {
  const seats = await prisma.seat.findMany({
    where: { simulationRunId: params.runId },
    orderBy: [{ row: "asc" }, { number: "asc" }],
  });
  return seats.map((seat) => ({ id: seat.id, row: seat.row, number: seat.number, status: seat.status }));
}

function shuffledCopy<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export interface SeatMapTickResult {
  botClaim: { claimCount: number };
  releasedSeatIds: string[];
}

/**
 * One GET /api/seats poll's worth of tick work, in order: (1) release any
 * expired holds so freed seats are eligible this tick, (2) advanceTick
 * (Task 007) against the now-current available count to get the bot's
 * claimCount, (3) execute that many real claimSeat() calls against random
 * available seats under the bot's sessionId. Each claim is independently
 * atomic, so a claim racing a concurrent user claim on the same seat is
 * safe — the loser just finds nothing left when its turn comes.
 */
export async function runSeatMapTick(params: { runId: string; now: Date }): Promise<SeatMapTickResult> {
  const { runId, now } = params;

  const released = await releaseExpiredHolds({ runId, now });

  const availableSeatCount = await prisma.seat.count({
    where: { simulationRunId: runId, status: SeatStatus.AVAILABLE },
  });
  const tickResult = await advanceTick({ runId, now, availableSeatCount });

  const claimCount = tickResult.botClaim.claimCount;
  if (claimCount > 0) {
    const availableSeats = await prisma.seat.findMany({
      where: { simulationRunId: runId, status: SeatStatus.AVAILABLE },
      select: { id: true },
    });
    const candidates = shuffledCopy(availableSeats.map((seat) => seat.id));
    const botId = botSessionId(runId);

    let claimed = 0;
    for (const seatId of candidates) {
      if (claimed >= claimCount) break;
      const result = await claimSeat({ seatId, sessionId: botId, now });
      if (result.status === "held") claimed++;
    }
  }

  return { botClaim: tickResult.botClaim, releasedSeatIds: released.releasedSeatIds };
}
