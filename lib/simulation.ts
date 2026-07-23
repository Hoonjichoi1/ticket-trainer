import type { Hold } from "@/lib/generated/prisma/client";

/**
 * Tick-on-request deterministic simulation engine — pure calculation layer.
 *
 * Design contract:
 * - Every function here is PURE: given the same input values it always
 *   returns the same output. No function reads Date.now(), Math.random(),
 *   or any ambient/DB state — all time references (`now`) and any future
 *   randomness inputs must be passed in explicitly by the caller (the
 *   route handler / orchestrator). This is what makes the tick engine safe
 *   in serverless (no persistent process between requests) and
 *   unit-testable without a DB.
 * - This module performs NO DB I/O and NO transaction execution.
 *   - Reading/persisting SimulationRun.lastTickAt is the caller's job.
 *   - Executing the actual bot/user hold-claim transactions is a later
 *     task's job; this module only computes how many seats the bot
 *     *should* claim this tick.
 *
 * Known gap (flagged, not solved here): SimulationRun has no persisted
 * bot-progress accumulator or determinism seed — only `lastTickAt`. A
 * naive per-tick floor(botIntensity * elapsedSeconds) can lose fractional
 * progress across many short ticks (frequent polling with low botIntensity
 * may under-claim vs. one long tick covering the same wall-clock span).
 * The real implementation must decide between (a) adding an accumulator
 * field via a follow-up migration, or (b) deriving "bot seats claimed so
 * far" by counting currently-HELD seats owned by the bot session instead
 * of a stored counter.
 *
 * Known gap: concurrent tick requests racing to read-then-write the same
 * SimulationRun.lastTickAt can double-advance it. The pure functions below
 * are safe to call concurrently (no shared mutable state), but the
 * caller's read-modify-write of lastTickAt is not — the real implementation
 * must guard this (e.g. conditional UPDATE ... WHERE lastTickAt = $old
 * RETURNING, or wrap the read+advance in a transaction).
 */

// ---------------------------------------------------------------------
// Elapsed time — shared building block, real implementation
// ---------------------------------------------------------------------
export interface ElapsedTimeInput {
  /** baseline timestamp: SimulationRun.lastTickAt for bot ticks, QueueEntry.joinedAt for queue position */
  since: Date;
  /** caller-supplied "current" time — never Date.now() internally */
  now: Date;
}

export interface ElapsedTime {
  ms: number;
  seconds: number;
}

/**
 * Computes elapsed time between `since` and `now`. Clamped to >= 0 to
 * defensively handle clock skew / out-of-order requests — this does not
 * violate determinism since it is still a pure function of the inputs.
 */
export function computeElapsedTime(input: ElapsedTimeInput): ElapsedTime {
  const ms = Math.max(0, input.now.getTime() - input.since.getTime());
  return { ms, seconds: ms / 1000 };
}

// ---------------------------------------------------------------------
// Bot claim count (F008 prep) — TODO: implement
// ---------------------------------------------------------------------
export interface BotClaimInput {
  /** computeElapsedTime({ since: SimulationRun.lastTickAt, now }) */
  elapsed: ElapsedTime;
  /** SimulationConfig.botIntensity for this run's tier */
  botIntensity: number;
  /** count of currently-AVAILABLE seats, for capping when seats run short */
  availableSeatCount: number;
}

export interface BotClaimResult {
  /** number of seats the bot should claim this tick; capped at availableSeatCount */
  claimCount: number;
}

/**
 * TODO: claimCount = min(floor(botIntensity * elapsed.seconds), availableSeatCount).
 * Actual claim execution (which seats, via the same hold transaction users
 * use) happens later — this only returns a count.
 */
export function computeBotClaimCount(input: BotClaimInput): BotClaimResult {
  throw new Error(`computeBotClaimCount: not implemented (${JSON.stringify(input)})`);
}

// ---------------------------------------------------------------------
// Queue position decrement (F003 prep) — TODO: implement
// ---------------------------------------------------------------------
export interface QueuePositionInput {
  /** computeElapsedTime({ since: QueueEntry.joinedAt, now }) */
  elapsed: ElapsedTime;
  /** SimulationConfig.admissionRatePerSec for this run's tier */
  admissionRatePerSec: number;
  /** QueueEntry.position as assigned at join time */
  initialPosition: number;
}

export interface QueuePositionResult {
  /** clamped to >= 0 */
  position: number;
  /** true once position reaches 0 — admission token should be issued */
  admitted: boolean;
}

/**
 * TODO: position = max(0, initialPosition - admissionRatePerSec * elapsed.seconds).
 * Deliberately anchored on each entry's own joinedAt (not a global queue
 * recompute) — this keeps the calc stateless and per-entry, matching the
 * tick-on-request/no-persistent-process constraint.
 */
export function computeQueuePosition(
  input: QueuePositionInput,
): QueuePositionResult {
  throw new Error(`computeQueuePosition: not implemented (${JSON.stringify(input)})`);
}

// ---------------------------------------------------------------------
// Hold expiry (F007 prep) — TODO: implement
// ---------------------------------------------------------------------
export interface HoldExpiryCheckInput {
  /** active holds (releasedAt IS NULL) to check, as queried by the caller */
  holds: Array<Pick<Hold, "id" | "seatId" | "expiresAt">>;
  now: Date;
}

export interface ExpiredHold {
  holdId: string;
  seatId: string;
}

export interface HoldExpiryCheckResult {
  /** holds whose expiresAt < now — candidates for lazy release by the caller's transaction */
  expired: ExpiredHold[];
}

/**
 * TODO: filter input.holds where expiresAt < now. Pure filter only — no
 * DB write. The caller executes the actual release transaction
 * (Hold.releasedAt set + Seat.status -> AVAILABLE) using this result.
 */
export function findExpiredHolds(
  input: HoldExpiryCheckInput,
): HoldExpiryCheckResult {
  throw new Error(`findExpiredHolds: not implemented (${input.holds.length} holds)`);
}
