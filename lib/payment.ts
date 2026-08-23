// Payment attempt orchestration (Task 010) — the "caller" layer for
// POST /api/payment. Owns the second (and last) piece of business logic
// CLAUDE.md calls out as critical: on success, Seat.status -> SOLD and the
// Booking row are written in the same transaction as the Hold cleanup
// (same principle as lib/seats.ts's claimSeat, different state
// transition). Tier-based error injection (F009) is a pure, testable
// decision (shouldInjectPaymentError) kept separate from the DB-executing
// half, the same "pure calc / DB caller" split Task 007/009 established.
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SeatStatus, type PaymentErrorType, type SubmitPaymentResponse } from "@/lib/types";
import { getOwnedHold, expireStaleHolds } from "@/lib/seats";
import { recordStageExited, recordJudgmentEvent, getSessionEvents } from "@/lib/session-result";

/** Pure decision: does this attempt get the tier's injected failure? Takes `roll` as a param (default Math.random()) so tests can assert both branches deterministically without mocking Math.random. */
export function shouldInjectPaymentError(errorRate: number, roll: number): boolean {
  return roll < errorRate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempts payment for the session's currently held seat:
 * 1. Sweep + require an owned hold (same pattern as lib/booking.ts) —
 *    returns `hold_expired` if the hold is gone, distinct from a
 *    server/timeout error so the client doesn't invite a pointless retry.
 * 2. Look up the run's tier SimulationConfig, sleep latencyMs (simulates
 *    tier congestion server-side; independent of the client's
 *    method-specific spinner duration, which is pure UX pacing).
 * 3. shouldInjectPaymentError(config.errorRate, roll) decides
 *    success/failure. Failure leaves the hold untouched (F010: "재결제 →
 *    hold 유지" is just "don't release anything") and records
 *    payment_error.
 * 4. Success re-validates the hold atomically inside the sale transaction
 *    (Hold.releasedAt + Seat HELD->SOLD + Booking create) — if it lost the
 *    race to a concurrent release, falls back to `hold_expired` rather
 *    than reporting a false success.
 * 5. If the session's most recent payment-stage event was payment_error,
 *    this success is a retry: records payment_retry_success in addition
 *    to the normal success path. Derived entirely from the recorded event
 *    log, not a client-supplied flag (Task 009's "server owns observed
 *    truth" principle).
 *
 * Does not touch SessionResult.outcome — ROADMAP reserves that write for
 * Task 011.
 */
export async function attemptPayment(params: {
  sessionId: string;
  runId: string;
  now: Date;
  /** injectable for deterministic tests; defaults to Math.random() */
  roll?: number;
  /** injectable for deterministic tests; defaults to Math.random() */
  errorTypeRoll?: number;
}): Promise<SubmitPaymentResponse> {
  const { sessionId, runId, now } = params;
  const roll = params.roll ?? Math.random();
  const errorTypeRoll = params.errorTypeRoll ?? Math.random();

  await expireStaleHolds({ runId, now });
  const hold = await getOwnedHold({ sessionId, runId });
  if (!hold) {
    return { status: "hold_expired" };
  }

  const run = await prisma.simulationRun.findUniqueOrThrow({ where: { id: runId } });
  const config = await prisma.simulationConfig.findUniqueOrThrow({ where: { tier: run.tier } });

  if (config.latencyMs > 0) {
    await sleep(config.latencyMs);
  }

  if (shouldInjectPaymentError(config.errorRate, roll)) {
    const errorType: PaymentErrorType = errorTypeRoll < 0.5 ? "timeout" : "server_error";
    await recordJudgmentEvent(prisma, sessionId, {
      type: "payment_error",
      stage: "payment",
      errorType,
      timestamp: now.toISOString(),
    });
    return { status: "error", errorType };
  }

  const priorEvents = await getSessionEvents(prisma, sessionId);
  const lastPaymentEvent = [...priorEvents].reverse().find((event) => event.stage === "payment");
  const isRetrySuccess = lastPaymentEvent?.type === "payment_error";

  const booking = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const releasedHold = await tx.hold.updateMany({
      where: { id: hold.holdId, releasedAt: null },
      data: { releasedAt: now },
    });
    if (releasedHold.count === 0) return null; // lost a race to a concurrent release (e.g. sendBeacon/expiry sweep)

    const soldSeat = await tx.seat.updateMany({
      where: { id: hold.seatId, status: SeatStatus.HELD },
      data: { status: SeatStatus.SOLD },
    });
    if (soldSeat.count === 0) return null;

    return tx.booking.create({ data: { concertId: run.concertId, seatId: hold.seatId, sessionId } });
  });

  if (!booking) {
    return { status: "hold_expired" };
  }

  await recordStageExited(prisma, sessionId, "payment", now);
  if (isRetrySuccess) {
    await recordJudgmentEvent(prisma, sessionId, {
      type: "payment_retry_success",
      stage: "payment",
      timestamp: now.toISOString(),
    });
  }

  return { status: "success", bookingId: booking.id };
}
