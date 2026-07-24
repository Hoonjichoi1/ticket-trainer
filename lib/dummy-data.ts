// Pre-backend placeholder data for Task 5's pages. Every generator here
// returns the exact shape of its corresponding lib/types.ts response type,
// so swapping to real API calls later requires no prop-shape changes on
// the consuming components. This module has no purity contract like
// lib/simulation.ts's tick engine — it's UI-only fixture data, not part
// of the deterministic simulation core.

import {
  SeatStatus,
  QueueEntryStatus,
  SessionOutcome,
  Tier,
  type SeatMapResponse,
  type SeatSummary,
  type QueuePollResponse,
  type SessionResultResponse,
  type FeedbackItem,
  type JudgmentEvent,
} from "@/lib/types";

// ---------------------------------------------------------------------
// Dummy concert — no Concert API response type exists yet in
// lib/types.ts (that lands with the backend in Phase 3), so this is a
// minimal local shape mirroring prisma Concert (id/title/venue/openAt).
// ---------------------------------------------------------------------
export interface DummyConcert {
  id: string;
  title: string;
  venue: string;
  /** ISO 8601 — ticket sale open time. */
  openAt: string;
}

/**
 * openInMs is relative to call time (not a fixed literal date) so the
 * home page's countdown-to-open transition is always demoable regardless
 * of what day this runs.
 */
export function getDummyConcert(openInMs = 60_000): DummyConcert {
  return {
    id: "dummy-concert-1",
    title: "NEBULA LIVE 2026",
    venue: "Olympic Hall, Seoul",
    openAt: new Date(Date.now() + openInMs).toISOString(),
  };
}

/**
 * Tier display labels — Tier has no display-name column in the DB
 * schema, and Korean tier names (소/중/메가) can't be used per CLAUDE.md's
 * English-UI-text rule, so these live here as the single source of truth.
 */
export const TIER_LABELS: Record<Tier, string> = {
  [Tier.SMALL]: "Small",
  [Tier.MEDIUM]: "Medium",
  [Tier.MEGA]: "Mega",
};

// ---------------------------------------------------------------------
// Seat map — 10 rows (A-J) x 20 seats = 200, matching Seat.row/number
// (the schema has no zone/section field).
// ---------------------------------------------------------------------
const SEAT_ROWS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
const SEATS_PER_ROW = 20;
const SEAT_STATUS_WEIGHTS: Array<{ status: SeatStatus; weight: number }> = [
  { status: SeatStatus.AVAILABLE, weight: 0.7 },
  { status: SeatStatus.HELD, weight: 0.08 },
  { status: SeatStatus.SOLD, weight: 0.22 },
];

function pickWeightedSeatStatus(rng: () => number): SeatStatus {
  const r = rng();
  let acc = 0;
  for (const { status, weight } of SEAT_STATUS_WEIGHTS) {
    acc += weight;
    if (r < acc) return status;
  }
  return SeatStatus.AVAILABLE;
}

/**
 * rng is injectable (defaults to Math.random) so a future test can pass
 * a deterministic generator for stable snapshots.
 */
export function getDummySeatMap(
  rng: () => number = Math.random,
): SeatMapResponse {
  const seats: SeatSummary[] = [];
  for (const row of SEAT_ROWS) {
    for (let number = 1; number <= SEATS_PER_ROW; number++) {
      seats.push({
        id: `${row}-${number}`,
        row,
        number,
        status: pickWeightedSeatStatus(rng),
      });
    }
  }
  return { seats };
}

// ---------------------------------------------------------------------
// Queue position sample
// ---------------------------------------------------------------------
export function getDummyQueuePosition(
  overrides: Partial<QueuePollResponse> = {},
): QueuePollResponse {
  return {
    position: 128,
    aheadCount: 127,
    estimatedWaitSeconds: 95,
    status: QueueEntryStatus.WAITING,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Result report sample
// ---------------------------------------------------------------------
export function getDummySessionResult(
  overrides: Partial<SessionResultResponse> = {},
): SessionResultResponse {
  const t0 = Date.now() - 6 * 60_000;
  const mkTiming = (offsetMs: number, durationMs: number) => ({
    enteredAt: new Date(t0 + offsetMs).toISOString(),
    exitedAt: new Date(t0 + offsetMs + durationMs).toISOString(),
    durationMs,
  });

  const events: JudgmentEvent[] = [
    {
      type: "queue_reset",
      stage: "queue",
      timestamp: new Date(t0 + 10_000).toISOString(),
      positionBeforeReset: 340,
    },
    {
      type: "contention_loss",
      stage: "seat_selection",
      timestamp: new Date(t0 + 95_000).toISOString(),
      seatId: "C-4",
    },
    {
      type: "seat_claim_success",
      stage: "seat_selection",
      timestamp: new Date(t0 + 100_000).toISOString(),
      seatId: "C-5",
    },
    {
      type: "payment_error",
      stage: "payment",
      timestamp: new Date(t0 + 300_000).toISOString(),
      errorType: "timeout",
    },
    {
      type: "payment_retry_success",
      stage: "payment",
      timestamp: new Date(t0 + 320_000).toISOString(),
    },
  ];

  const feedback: FeedbackItem[] = [
    {
      eventType: "contention_loss",
      message:
        "A bot claimed seat C-4 just before you. Try scanning several seats instead of fixating on one.",
    },
    {
      eventType: "payment_retry_success",
      message:
        "Your payment timed out once, but you retried before the hold expired — good recovery.",
    },
  ];

  const base: SessionResultResponse = {
    outcome: SessionOutcome.SUCCESS,
    stageTimings: {
      queue: mkTiming(0, 90_000),
      seat_selection: mkTiming(90_000, 15_000),
      booking_info: mkTiming(105_000, 60_000),
      payment: mkTiming(165_000, 180_000),
    },
    contentionLosses: 1,
    events,
    feedback,
  };

  return { ...base, ...overrides };
}
