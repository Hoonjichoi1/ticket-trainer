// Result-report aggregation (Task 011) — the only reader/writer of
// SessionResult.outcome. Everything else in SessionResult (stageTimings,
// contentionLosses, events) is written by Task 008/009/010 at the moment
// it happens (ROADMAP "관측 데이터 원칙"); this module never appends to
// events or touches stageTimings, it only aggregates and maps what's
// already there into a SessionResultResponse.
import { prisma } from "@/lib/db";
import { SessionOutcome, SimulationRunStatus, Tier } from "@/lib/types";
import type { FeedbackItem, JudgmentEvent, SessionResultResponse, StageTimings } from "@/lib/types";
import { expireStaleHolds } from "@/lib/seats";
import { getSessionResultRow } from "@/lib/session-result";

/**
 * Pure outcome decision, checked in priority order. hasBooking is the
 * most reliable signal (Task 010's attemptPayment only creates a Booking
 * on real success), so it wins over any event even if both were somehow
 * present. payment_abandoned and hold_expired are mutually exclusive in
 * practice — a Hold's releasedAt is only ever set once, via either the
 * explicit releaseHold path (payment_abandoned) or the expireStaleHolds
 * sweep (hold_expired) — but the ordering is kept as a defensive
 * safeguard. ROADMAP D-8 note: QUEUE_TIMEOUT is intentionally never
 * returned here — lib/queue.ts has no trigger for it yet (out of scope
 * for this Task), so a session that only ever got as far as the queue
 * falls through to ABANDONED.
 */
export function determineOutcome(params: { hasBooking: boolean; events: JudgmentEvent[] }): SessionOutcome {
  const { hasBooking, events } = params;
  if (hasBooking) return SessionOutcome.SUCCESS;
  if (events.some((event) => event.type === "payment_abandoned")) return SessionOutcome.PAYMENT_FAILED;
  if (events.some((event) => event.type === "hold_expired")) return SessionOutcome.SEAT_LOST;
  return SessionOutcome.ABANDONED;
}

/**
 * Initial per-tier targets for the "소요 시간·패배 횟수를 티어별 기준치와
 * 비교" PRD requirement. SimulationConfig has no benchmark-style field
 * (only simulation coefficients: arrivalRatePerSec/admissionRatePerSec/
 * botIntensity/errorRate/latencyMs), so these live here as their own
 * constant, loosely scaled to each tier's botIntensity/errorRate. Not
 * derived from a formula — a starting point for tuning, not a precise
 * calibration.
 */
export const TIER_BENCHMARKS: Record<Tier, { targetTotalMs: number; maxContentionLosses: number }> = {
  [Tier.SMALL]: { targetTotalMs: 90_000, maxContentionLosses: 1 },
  [Tier.MEDIUM]: { targetTotalMs: 150_000, maxContentionLosses: 3 },
  [Tier.MEGA]: { targetTotalMs: 240_000, maxContentionLosses: 6 },
};

function totalDurationMs(stageTimings: StageTimings): number {
  return Object.values(stageTimings).reduce((sum, timing) => sum + (timing?.durationMs ?? 0), 0);
}

function formatMinutesSeconds(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** Pure comparison against TIER_BENCHMARKS — never reads events, only stageTimings/contentionLosses already recorded by earlier Tasks. */
export function evaluateBenchmarks(params: {
  tier: Tier;
  stageTimings: StageTimings;
  contentionLosses: number;
}): FeedbackItem[] {
  const { tier, stageTimings, contentionLosses } = params;
  const benchmark = TIER_BENCHMARKS[tier];
  const totalMs = totalDurationMs(stageTimings);
  const items: FeedbackItem[] = [];

  if (totalMs > benchmark.targetTotalMs) {
    items.push({
      eventType: "slow_total_time",
      message: `Your total time (${formatMinutesSeconds(totalMs)}) was slower than the ${formatMinutesSeconds(benchmark.targetTotalMs)} target for this tier — moving faster through booking info and payment once a seat is held cuts your exposure to hold expiry.`,
    });
  }

  if (contentionLosses > benchmark.maxContentionLosses) {
    items.push({
      eventType: "high_contention_losses",
      message: `You lost ${contentionLosses} seat race(s), above the ${benchmark.maxContentionLosses} typical for this tier — try seats farther from the busiest section next time.`,
    });
  }

  return items;
}

/**
 * Pure mapping from recorded events to fixed coaching copy. One
 * FeedbackItem per event type present (repeated occurrences of the same
 * type fold into a single item whose message reflects the count), plus
 * whatever evaluateBenchmarks already produced. Returns [] rather than a
 * generic placeholder when nothing is recorded — app/result/page.tsx
 * already hides the feedback section when empty.
 */
export function buildFeedback(params: {
  events: JudgmentEvent[];
  benchmarkFeedback: FeedbackItem[];
}): FeedbackItem[] {
  const { events, benchmarkFeedback } = params;
  const items: FeedbackItem[] = [];

  const queueResetCount = events.filter((event) => event.type === "queue_reset").length;
  if (queueResetCount > 0) {
    items.push({
      eventType: "queue_reset",
      message: `You refreshed the queue ${queueResetCount} time(s), which reset your position each time — closing the tab (not reloading it) preserves your spot better next run.`,
    });
  }

  const contentionLossCount = events.filter((event) => event.type === "contention_loss").length;
  if (contentionLossCount > 0) {
    items.push({
      eventType: "contention_loss",
      message: `You lost ${contentionLossCount} seat race(s) to bots or other sessions before securing yours — that's normal at this tier, but scanning several seats instead of fixating on one can lower it.`,
    });
  }

  const hasPaymentError = events.some((event) => event.type === "payment_error");
  const hasRetrySuccess = events.some((event) => event.type === "payment_retry_success");
  const hasPaymentAbandoned = events.some((event) => event.type === "payment_abandoned");

  if (hasPaymentError && hasRetrySuccess) {
    items.push({
      eventType: "payment_retry_success",
      message:
        "You hit a payment error and recovered by retrying inside the modal instead of refreshing — that's exactly the right move, your hold stayed intact.",
    });
  } else if (hasPaymentError && hasPaymentAbandoned) {
    items.push({
      eventType: "payment_abandoned",
      message:
        "After the payment error, refreshing or navigating away forfeited your hold. Closing just the error modal and retrying keeps the hold alive instead.",
    });
  }

  if (events.some((event) => event.type === "hold_expired")) {
    items.push({
      eventType: "hold_expired",
      message:
        "Your 5-minute hold ran out before you finished booking info and payment — once a seat is held, treat the timer as the real deadline it is.",
    });
  }

  items.push(...benchmarkFeedback);

  return items;
}

/**
 * Task 011's main entry point. Returns null only when the session has no
 * SessionResult row at all (never entered any stage) — callers treat that
 * as "no result to show yet".
 *
 * outcome is computed and persisted exactly once: if the row already has
 * one, it's returned as-is (feedback is still recomputed fresh each call,
 * so copy changes apply retroactively without a migration). If null, this
 * sweeps the session's still-ACTIVE run first (closes the race where a
 * client-side HoldTimer navigates here before any request has triggered
 * expireStaleHolds), re-reads the row, decides the outcome from
 * hasBooking + events, and persists both the outcome and — if the run was
 * still ACTIVE — its transition to COMPLETED (the first writer of that
 * status; ACTIVE only ever moved to EXPIRED before, via "다시 도전").
 *
 * hasBooking is scoped to the current run's seats (via Seat.simulationRunId),
 * not a bare sessionId lookup — a session can accumulate Booking rows
 * across multiple past runs (Bookings aren't deleted on retry, only
 * SessionResult is reset per D-8), so an unscoped count would wrongly
 * report success for a brand-new run that reused an old sessionId cookie.
 */
export async function aggregateSessionResult(params: {
  sessionId: string;
  now: Date;
}): Promise<SessionResultResponse | null> {
  const { sessionId, now } = params;

  const existing = await getSessionResultRow(prisma, sessionId);
  if (!existing) return null;

  const latestRun = await prisma.simulationRun.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
  });

  let { outcome, stageTimings, contentionLosses, events } = existing;

  if (!outcome) {
    // latestRun can never be EXPIRED here: app/api/session/route.ts only
    // ever sets EXPIRED in the same transaction as creating a strictly
    // newer ACTIVE run (D-8's reset), so an EXPIRED run is never the most
    // recently created one — this branch is only ever ACTIVE, COMPLETED
    // (unreachable too, since outcome would already be set), or no run at all.
    if (latestRun?.status === SimulationRunStatus.ACTIVE) {
      await expireStaleHolds({ runId: latestRun.id, now });
    }

    // Re-read: the sweep above may have just appended a hold_expired event.
    const fresh = await getSessionResultRow(prisma, sessionId);
    if (fresh) {
      stageTimings = fresh.stageTimings;
      contentionLosses = fresh.contentionLosses;
      events = fresh.events;
    }

    const hasBooking = latestRun
      ? (await prisma.booking.count({ where: { sessionId, seat: { simulationRunId: latestRun.id } } })) > 0
      : false;
    outcome = determineOutcome({ hasBooking, events });

    const runToComplete = latestRun?.status === SimulationRunStatus.ACTIVE ? latestRun.id : null;
    await prisma.$transaction(async (tx) => {
      await tx.sessionResult.update({ where: { sessionId }, data: { outcome } });
      if (runToComplete) {
        await tx.simulationRun.update({
          where: { id: runToComplete },
          data: { status: SimulationRunStatus.COMPLETED },
        });
      }
    });
  }

  const benchmarkFeedback = latestRun
    ? evaluateBenchmarks({ tier: latestRun.tier, stageTimings, contentionLosses })
    : [];
  const feedback = buildFeedback({ events, benchmarkFeedback });

  // ABANDONED is otherwise the one outcome that can end up with zero
  // FeedbackItems (no events recorded and nothing over a benchmark) — the
  // case with the least other information on the page, and arguably the
  // one most worth a nudge. Scoped to feedback.length === 0 rather than
  // "no events" alone, so a benchmark-only ABANDONED session still gets
  // its real feedback instead of this generic fallback.
  if (outcome === SessionOutcome.ABANDONED && feedback.length === 0) {
    feedback.push({
      eventType: "no_recorded_activity",
      message:
        "You left before any seat, error, or retry was recorded — next time, try to at least reach seat selection so there's something concrete to review here.",
    });
  }

  return { outcome, stageTimings, contentionLosses, events, feedback };
}
