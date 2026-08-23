// Shared types for the ticket-trainer simulation. Enums are re-exported
// from the Prisma-generated module (source of truth: prisma/schema.prisma)
// rather than redefined here. This file adds the API request/response
// contracts and judgment-event schema that sit on top of the DB layer.
// No business logic here — types only.

// ---------------------------------------------------------------------
// Enums (re-exported from Prisma-generated code — do not redefine)
// ---------------------------------------------------------------------
export * from "@/lib/generated/prisma/enums";

import type {
  QueueEntryStatus,
  Tier,
  SeatStatus,
  SessionOutcome,
  SimulationRunStatus,
} from "@/lib/generated/prisma/enums";

// The task doc and PRD informally call this "QueueStatus"; QueueEntryStatus
// (the real Prisma enum) remains the source of truth. Kept as a thin
// type-only alias so route/UI code can use either name without diverging
// from the schema.
export type QueueStatus = QueueEntryStatus;

// ---------------------------------------------------------------------
// Simulation stages (shared vocabulary for timings + judgment events)
// ---------------------------------------------------------------------
export type SimulationStage =
  | "queue"
  | "seat_selection"
  | "booking_info"
  | "payment";

export interface StageTiming {
  /** ISO 8601 — when the user entered this stage. */
  enteredAt: string;
  /** ISO 8601 — when the user left/completed this stage; absent while in progress. */
  exitedAt?: string;
  /** exitedAt - enteredAt in ms; convenience so feedback mapping doesn't re-parse timestamps. */
  durationMs?: number;
}

/** SessionResult.stageTimings shape (built up incrementally as the user progresses). */
export type StageTimings = Partial<Record<SimulationStage, StageTiming>>;

// ---------------------------------------------------------------------
// Judgment events (SessionResult.events) — recorded at occurrence time,
// later aggregated and mapped to feedback copy.
// ---------------------------------------------------------------------
interface JudgmentEventBase {
  stage: SimulationStage;
  /** ISO 8601 — set at the moment the event is recorded (not client time). */
  timestamp: string;
}

export type JudgmentEvent =
  // queue: refresh/leave -> position reset
  | (JudgmentEventBase & {
      type: "queue_reset";
      stage: "queue";
      positionBeforeReset: number;
    })
  // seats: bot/other user beat you to a seat (feeds contentionLosses)
  | (JudgmentEventBase & {
      type: "contention_loss";
      stage: "seat_selection";
      seatId: string;
    })
  // seats: successful claim (timing signal, separate from stageTimings)
  | (JudgmentEventBase & {
      type: "seat_claim_success";
      stage: "seat_selection";
      seatId: string;
    })
  // payment: error occurred
  | (JudgmentEventBase & {
      type: "payment_error";
      stage: "payment";
      errorType: PaymentErrorType;
    })
  // payment: error -> user closed modal, hold retained, retried, re-paid
  | (JudgmentEventBase & {
      type: "payment_retry_success";
      stage: "payment";
    })
  // payment: error -> user refreshed/navigated away, hold lost (seat status unaffected, D-5)
  | (JudgmentEventBase & {
      type: "payment_abandoned";
      stage: "payment";
    })
  // hold expiry (5-min TTL lapsed) — can happen at seat-selection,
  // booking-info, or payment stages
  | (JudgmentEventBase & {
      type: "hold_expired";
      stage: "seat_selection" | "booking_info" | "payment";
      seatId: string;
    });

// Task 011: FeedbackItem.eventType also needs to express two benchmark
// evaluation results (total time / contention losses vs. the tier's
// target) that are never recorded as JudgmentEvents — they're derived at
// aggregation time by comparing already-recorded data against
// TIER_BENCHMARKS (lib/result.ts), not something that "happened" at a
// point in time the way queue_reset/hold_expired/etc. do. Widening
// JudgmentEventType itself (rather than only FeedbackItem.eventType) keeps
// a single type name for "any label a FeedbackItem can carry", while
// JudgmentEvent stays a closed set of only real observed events — these
// literals must never appear in a JudgmentEvent or SessionResult.events.
// "no_recorded_activity" is the same idea applied to the ABANDONED outcome:
// aggregateSessionResult attaches it only when no other FeedbackItem was
// produced at all, so that outcome isn't the one case with zero coaching
// copy on the result page.
export type JudgmentEventType =
  | JudgmentEvent["type"]
  | "slow_total_time"
  | "high_contention_losses"
  | "no_recorded_activity";
//= "queue_reset" | "contention_loss" | "seat_claim_success" | "payment_error"
// | "payment_retry_success" | "payment_abandoned" | "hold_expired"
// | "slow_total_time" | "high_contention_losses" | "no_recorded_activity"

// ---------------------------------------------------------------------
// API contracts — grouped per route. Request types describe JSON bodies;
// GET routes with no body only get a Response type.
// ---------------------------------------------------------------------

// POST /api/session (start simulation; session cookie set as a side
// effect, not part of the JSON body)
export interface StartSimulationRequest {
  tier: Tier;
  /** omitted -> server resolves the single seeded concert */
  concertId?: string;
}
export interface StartSimulationResponse {
  runId: string;
  tier: Tier;
  status: SimulationRunStatus;
  concertId: string;
}

// GET /api/queue (tick-on-request poll, 2s client interval)
export interface QueuePollResponse {
  position: number;
  aheadCount: number;
  estimatedWaitSeconds: number;
  status: QueueEntryStatus;
  /** issued once, only when position reaches admission */
  admissionToken?: string;
}

// GET /api/seats (full ~200-seat map) + POST /api/seats (atomic claim)
export interface SeatSummary {
  id: string;
  row: string;
  number: number;
  status: SeatStatus;
}
export interface SeatMapResponse {
  seats: SeatSummary[];
}
export interface SeatClaimRequest {
  seatId: string;
}
export type SeatClaimResponse =
  | { status: "held"; holdExpiresAt: string }
  | { status: "conflict"; code: "SEAT_ALREADY_TAKEN"; message: string };

// POST /api/booking (booking-info step; does NOT create the Prisma
// Booking row — that happens on payment success)
export type DeliveryMethod = "mobile" | "onsite";
export interface SubmitBookingInfoRequest {
  /** fixed per PRD */
  ticketCount: 1;
  deliveryMethod: DeliveryMethod;
  termsAgreed: boolean;
}
export type SubmitBookingInfoResponse =
  | { status: "ok"; holdExpiresAt: string }
  | { status: "hold_expired" };

// POST /api/payment
export type PaymentMethod = "easy_pay" | "card" | "bank_transfer";
export type PaymentErrorType = "timeout" | "server_error";
export interface DummyCardDetails {
  // Dummy fields only — never validated/stored as a real PAN.
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
}
export interface SubmitPaymentRequest {
  method: PaymentMethod;
  /** required only when method === "card"; not enforced at the type level in this skeleton */
  cardDetails?: DummyCardDetails;
}
export type SubmitPaymentResponse =
  | { status: "success"; bookingId: string }
  | { status: "error"; errorType: PaymentErrorType }
  // Task 010: the session's hold was gone (never existed, or expired and
  // was swept) by the time payment was attempted — distinct from
  // "error" so the client doesn't invite a pointless retry (the seat is
  // gone; retrying the same request can't succeed). Mirrors
  // SubmitBookingInfoResponse's "hold_expired" variant for the same
  // situation at the booking-info step.
  | { status: "hold_expired" };

// Result report
export interface FeedbackItem {
  eventType: JudgmentEventType;
  message: string;
}
export interface SessionResultResponse {
  outcome: SessionOutcome;
  stageTimings: StageTimings;
  contentionLosses: number;
  events: JudgmentEvent[];
  feedback: FeedbackItem[];
}

// Generic error shape usable by any route's non-2xx JSON body.
export interface ApiErrorResponse {
  status: "error";
  code?: string;
  message: string;
}

// POST /api/dev/timewarp (ROADMAP D-7, dev/test-only — 404s in
// production). Rewinds/advances the stored timestamp anchors
// lib/simulation.ts's tick math reads from, so tick-on-request wait
// states can be reproduced without waiting in real time. All fields
// optional and combinable in one request.
export interface TimewarpRequest {
  /** Concert.openAt = now + openInMs. Positive = still-future open (e.g. 30_000 for "30s before open"); negative = already open. */
  openInMs?: number;
  /** QueueEntry.joinedAt = now - queueRewindMs. Mutually exclusive with queueConsumedPct. */
  queueRewindMs?: number;
  /** 0-100 convenience control: derives the joinedAt rewind from the tier's admissionRatePerSec so the queue position reads as this % consumed. */
  queueConsumedPct?: number;
  /** SimulationRun.lastTickAt = now - lastTickRewindMs. */
  lastTickRewindMs?: number;
}
export interface TimewarpConcertResult {
  applied: boolean;
  openAt?: string;
}
export interface TimewarpQueueResult {
  applied: boolean;
  joinedAt?: string;
  reason?: string;
}
export interface TimewarpSimulationRunResult {
  applied: boolean;
  lastTickAt?: string;
}
export interface TimewarpResponse {
  status: "ok";
  /** ISO 8601 — the `now` this call used as its reference point. */
  now: string;
  /** null when openInMs wasn't requested. */
  concert: TimewarpConcertResult | null;
  /** null when neither queueRewindMs nor queueConsumedPct was requested. */
  queue: TimewarpQueueResult | null;
  /** null when lastTickRewindMs wasn't requested. */
  simulationRun: TimewarpSimulationRunResult | null;
  warnings: string[];
}
