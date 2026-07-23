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
  // payment: error -> user refreshed/navigated away, hold lost, seat released
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

export type JudgmentEventType = JudgmentEvent["type"];
//= "queue_reset" | "contention_loss" | "seat_claim_success" | "payment_error" 
// | "payment_retry_success" | "payment_abandoned" | "hold_expired"

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
  | { status: "error"; errorType: PaymentErrorType };

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
