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
import { recordJudgmentEvent, getSessionEvents } from "@/lib/session-result";
import { getZoneSeatRange, type SeatGridConfig, type SeatZone } from "@/lib/seat-zones";

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

export interface ExpireStaleHoldsResult {
  expiredSeatIds: string[];
}

/**
 * Marks every expired active hold (releasedAt IS NULL, expiresAt < now) for
 * a run's seats as no longer active (Hold.releasedAt = now) and records a
 * hold_expired judgment event for user sessions — the bot's synthetic
 * sessionId never gets a SessionResult row. Per ROADMAP D-5, Seat.status is
 * a one-way AVAILABLE -> HELD -> SOLD transition: a hold expiring does NOT
 * free the seat back up, it only ends that hold's own validity (checked by
 * booking/payment to route the session to a failure outcome instead).
 */
export async function expireStaleHolds(params: {
  runId: string;
  now: Date;
}): Promise<ExpireStaleHoldsResult> {
  const { runId, now } = params;

  const activeHolds = await prisma.hold.findMany({
    where: { releasedAt: null, seat: { simulationRunId: runId } },
    select: { id: true, seatId: true, expiresAt: true, sessionId: true },
  });
  if (activeHolds.length === 0) return { expiredSeatIds: [] };

  const { expired } = findExpiredHolds({ holds: activeHolds, now });
  if (expired.length === 0) return { expiredSeatIds: [] };

  const sessionIdByHoldId = new Map(activeHolds.map((hold) => [hold.id, hold.sessionId]));

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const { holdId, seatId } of expired) {
      await tx.hold.update({ where: { id: holdId }, data: { releasedAt: now } });

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

  return { expiredSeatIds: expired.map((e) => e.seatId) };
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

export interface OwnedHold {
  holdId: string;
  seatId: string;
  row: string;
  number: number;
  expiresAt: Date;
}

/**
 * The session's currently active (releasedAt IS NULL) hold within a run,
 * or null if it has none — Task 010's source of truth for "which seat is
 * this session holding right now" on the booking-info/payment pages.
 * Looked up by sessionId, not a client-supplied seatId, so there's
 * nothing for a caller to spoof. Callers are expected to run
 * expireStaleHolds({ runId, now }) first (GET /api/seats normally does
 * this via runSeatMapTick, but booking/payment aren't polled, so their
 * page/route guards call it directly) — this function itself does not
 * check expiresAt, it trusts releasedAt as already-current.
 */
export async function getOwnedHold(params: { sessionId: string; runId: string }): Promise<OwnedHold | null> {
  const hold = await prisma.hold.findFirst({
    where: { sessionId: params.sessionId, releasedAt: null, seat: { simulationRunId: params.runId } },
    include: { seat: true },
  });
  if (!hold) return null;

  return { holdId: hold.id, seatId: hold.seatId, row: hold.seat.row, number: hold.seat.number, expiresAt: hold.expiresAt };
}

/**
 * Explicitly ends the session's active hold (Task 010, F010 "새로고침·뒤로가기
 * → hold 상실"): sets Hold.releasedAt in the same transaction as the
 * judgment-event write. Sweeps expired holds first, same as
 * attemptPayment/confirmBookingInfo — getOwnedHold's contract requires it,
 * and skipping it here would let an already-expired-but-unswept hold get
 * misrecorded as a live release below instead of expireStaleHolds' own
 * hold_expired event. Per ROADMAP D-5, this does NOT flip Seat.status back
 * to AVAILABLE — the seat stays claimed, and losing this hold is a
 * terminal F010 failure outcome, not a chance to free the seat back up
 * (same rule as expireStaleHolds). Records a payment_abandoned judgment
 * event only when this session's most recent payment-stage event was
 * payment_error — i.e. only when this release follows a failed payment
 * attempt, not a plain early exit from seats/booking (which has no
 * dedicated judgment event; the 5-minute expiry safety net covers that
 * case via hold_expired). Returns released:false as a no-op if there was
 * nothing to release (already swept, or never held), so the
 * sendBeacon-driven caller can stay idempotent against retries/duplicate
 * unload events.
 */
export async function releaseHold(params: {
  sessionId: string;
  runId: string;
  now: Date;
}): Promise<{ released: boolean }> {
  const { sessionId, runId, now } = params;

  await expireStaleHolds({ runId, now });

  const hold = await getOwnedHold({ sessionId, runId });
  if (!hold) return { released: false };

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.hold.update({ where: { id: hold.holdId }, data: { releasedAt: now } });

    const events = await getSessionEvents(tx, sessionId);
    const lastPaymentEvent = [...events].reverse().find((event) => event.stage === "payment");
    if (lastPaymentEvent?.type === "payment_error") {
      await recordJudgmentEvent(tx, sessionId, {
        type: "payment_abandoned",
        stage: "payment",
        timestamp: now.toISOString(),
      });
    }
  });

  return { released: true };
}

/**
 * One zone's seat map for a run (D-15: GET /api/seats is zone-scoped —
 * a full-run listing would be ~1MB/poll at MEGA's 15,000 seats), mapped to
 * the SeatMapResponse shape. Filters by row AND number range
 * (getZoneSeatRange, D-17's 2D row-band x left-right-split zones) rather
 * than fetching every seat and filtering in application code, so DB/network
 * cost scales with zone size, not total seat count.
 *
 * Ordered by row cast to an integer, then number — Seat.row is a numeric
 * *string* label ("1".."150", D-15), so a plain string ORDER BY "row"
 * sorts lexicographically ("10" < "2") and scrambles physical row
 * adjacency for any tier with >9 rows. Casting keeps seats from the same
 * physical row contiguous in the returned array, which
 * app/seats/SeatsView.tsx's chunkIntoRows relies on for its grid layout.
 */
export async function listSeatMap(params: {
  runId: string;
  zone: SeatZone;
  seatGrid: SeatGridConfig;
}): Promise<SeatSummary[]> {
  const { runId, zone, seatGrid } = params;
  const { rowStart, rowEnd, numberStart, numberEnd } = getZoneSeatRange(zone, seatGrid);

  const seats = await prisma.$queryRaw<
    Array<{ id: string; row: string; number: number; status: SeatStatus }>
  >`
    SELECT id, row, number, status FROM "Seat"
    WHERE "simulationRunId" = ${runId}
      AND CAST(row AS INTEGER) BETWEEN ${rowStart} AND ${rowEnd}
      AND number BETWEEN ${numberStart} AND ${numberEnd}
    ORDER BY CAST(row AS INTEGER) ASC, number ASC
  `;
  return seats.map((seat) => ({ id: seat.id, row: seat.row, number: seat.number, status: seat.status }));
}

export interface ClaimSeatsBatchResult {
  claimedSeatIds: string[];
}

/**
 * D-20: atomically claims up to `count` AVAILABLE seats for a run in a
 * single round trip, for the bot's tick-time claims (runSeatMapTick) —
 * replaces the old one-claimSeat()-call-per-seat loop, which meant a
 * single poll's claimCount (up to tens of thousands at high elapsed under
 * the old linear formula, D-18) issued that many sequential DB round trips
 * and could take tens of seconds (measured 23.6s for one GET /api/seats at
 * elapsedSeconds=60, D-18/D-20).
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside the CTE takes row locks on up
 * to `count` AVAILABLE seats, skipping (not blocking on) any row a
 * concurrent transaction already has locked — including a real user's
 * single-seat claimSeat() (POST /api/seats), whose own `UPDATE ... WHERE
 * id=$1 AND status='AVAILABLE'` takes the same kind of row lock. So a user
 * claim racing this batch is safe either way: if the user's transaction
 * already locked the row, this batch skips it and claims a different seat
 * instead of blocking or double-claiming; if this batch locked it first,
 * the user's UPDATE simply matches zero rows (existing SEAT_ALREADY_TAKEN
 * path in claimSeat, unchanged). The outer UPDATE only ever touches rows
 * the CTE actually selected, so no seat can be claimed twice. F006's
 * atomicity guarantee for the user-facing claim path is untouched by this
 * function — it's a separate query, not a shared code path.
 *
 * Only the seat *selection* is randomized here (ORDER BY random(), same as
 * the old shuffledCopy) — F007's determinism requirement is about
 * `computeBotClaimCount`/advanceTick's claimCount for a given
 * (elapsed, botIntensity, availableSeatCount), which this function doesn't
 * touch; which specific seats end up claimed was never part of that
 * contract.
 *
 * `LIMIT count` combined with the AVAILABLE filter means this naturally
 * caps at however many seats actually exist when the query runs (same
 * "claim fewer if the pool is smaller than expected" behavior the old
 * per-seat loop had via running out of candidates) — no separate cap logic
 * needed.
 */
export async function claimSeatsBatch(params: {
  runId: string;
  sessionId: string;
  count: number;
  now: Date;
}): Promise<ClaimSeatsBatchResult> {
  const { runId, sessionId, count, now } = params;
  if (count <= 0) return { claimedSeatIds: [] };

  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ClaimSeatsBatchResult> => {
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT id FROM "Seat"
        WHERE "simulationRunId" = ${runId} AND status = 'AVAILABLE'
        ORDER BY random()
        LIMIT ${count}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "Seat" SET status = 'HELD'
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id
    `;

    if (claimed.length > 0) {
      const expiresAt = new Date(now.getTime() + HOLD_DURATION_MS);
      await tx.hold.createMany({
        data: claimed.map((seat) => ({ seatId: seat.id, sessionId, expiresAt })),
      });
    }

    return { claimedSeatIds: claimed.map((seat) => seat.id) };
  });
}

export interface SeatMapTickResult {
  botClaim: { claimCount: number };
  expiredSeatIds: string[];
}

/**
 * One GET /api/seats poll's worth of tick work, in order: (1) mark any
 * expired holds as no longer active (does NOT free their seats — D-5), (2)
 * advanceTick (Task 007) against the current available count to get the
 * bot's claimCount, (3) claim that many random available seats under the
 * bot's sessionId via one batched claimSeatsBatch() call (D-20) instead of
 * claimCount individual round trips.
 */
export async function runSeatMapTick(params: { runId: string; now: Date }): Promise<SeatMapTickResult> {
  const { runId, now } = params;

  const expired = await expireStaleHolds({ runId, now });

  const availableSeatCount = await prisma.seat.count({
    where: { simulationRunId: runId, status: SeatStatus.AVAILABLE },
  });
  const tickResult = await advanceTick({ runId, now, availableSeatCount });

  const claimCount = tickResult.botClaim.claimCount;
  if (claimCount > 0) {
    await claimSeatsBatch({ runId, sessionId: botSessionId(runId), count: claimCount, now });
  }

  return { botClaim: tickResult.botClaim, expiredSeatIds: expired.expiredSeatIds };
}
