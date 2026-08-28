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
 * Resolved by the caller (lib/tick.ts), not here:
 * - Fractional-progress loss: computeBotClaimCount floors every call, so
 *   naively resetting lastTickAt to `now` every tick would silently drop
 *   fractional seat progress under frequent low-intensity polling.
 *   lib/tick.ts avoids adding a schema counter by only advancing
 *   lastTickAt by the time equivalent of the *whole* seats actually
 *   claimed (claimCount / botIntensity seconds), carrying the unclaimed
 *   remainder forward as elapsed time for the next tick.
 * - Concurrent tick requests double-advancing lastTickAt: lib/tick.ts
 *   reads it via `SELECT ... FOR UPDATE` inside a DB transaction, so a
 *   second concurrent tick blocks until the first commits and then reads
 *   the already-advanced value as its own baseline.
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
// Queue-open reference resolution (D-14)
// ---------------------------------------------------------------------

/**
 * Resolves the "sale considered open at" reference `POST /api/session`
 * snapshots onto `SimulationRun.queueOpenAt` — the real `openAt` if it's
 * still in the future, or `now` itself if it has already passed. Used once
 * at run-creation time and persisted (D-14), because D-4 already fixes
 * queue position as a value resolved once at join time and only ever
 * decayed forward afterward — this must be resolved once for the same
 * reason, not recomputed on every request.
 *
 * Deliberately does NOT add `app/page.tsx`'s separate `resolveDisplayOpenAt`
 * "+60s" demo fallback: that fallback exists purely so the home page's
 * countdown UI has something nonzero to animate toward when the seed data
 * is stale (a display-only concern, D-11 follow-up). Reusing that same
 * +60s offset here would push every session's *actual* queue-open
 * reference 60s into the future from whenever `POST /api/session` happens
 * to run — meaning `joinQueue`'s `SALE_NOT_OPEN` gate would reject anyone
 * who joins the queue immediately after starting a session, even though
 * they just finished watching that exact countdown reach zero. Clamping to
 * `now` instead means a session started against a stale `openAt` is
 * considered open immediately, giving an initial queue position at or near
 * 0 rather than an artificial extra wait.
 */
export function resolveQueueOpenAt(openAt: Date, now: Date): Date {
  return openAt > now ? openAt : now;
}

// ---------------------------------------------------------------------
// Bot claim count (F008) — D-21: front-loaded exponential-approach curve
// ---------------------------------------------------------------------
export interface BotClaimInput {
  /**
   * computeElapsedTime({ since: SimulationRun.queueOpenAt, now }) — total
   * elapsed since the sale was considered open for this run, NOT since the
   * last tick. D-21's curve needs a single fixed anchor: it computes an
   * ABSOLUTE cumulative depletion target for elapsed t, not a per-tick
   * increment, so the same t must always mean the same point on the curve
   * regardless of how many ticks have fired or how they were spaced. A
   * "since last tick" delta (the pre-D-21 model) can't give that — the same
   * delta could land at very different points on a nonlinear curve
   * depending on tick history, breaking F007 determinism in practice.
   */
  elapsedSinceOpen: ElapsedTime;
  /** SimulationConfig.botCurveK for this run's tier — exponential curve steepness (1/sec); higher = faster early depletion */
  botCurveK: number;
  /** total seats in this run's pool (SimulationConfig.seatRows * seatsPerRow) */
  poolSize: number;
  /** count of currently-AVAILABLE seats — used both to cap this tick's claim and (via poolSize - availableSeatCount) to know how much of the target is already met */
  availableSeatCount: number;
}

export interface BotClaimResult {
  /** number of seats the bot should claim this tick; capped at availableSeatCount */
  claimCount: number;
}

/**
 * D-21: real ticketing sells out fastest in the first seconds after
 * opening and tapers off afterward (research behind the decision: Super
 * Show 6 Seoul sold out in ~9 minutes, Jannabi concerts sell out
 * instantly) — the previous linear model (claimCount = botIntensity *
 * elapsed) had it backwards: loose early, steepening only as elapsed grew.
 *
 * targetClaimed(t) = floor(poolSize * (1 - e^(-botCurveK * t))) is the
 * ABSOLUTE cumulative depletion target at elapsed t seconds since
 * queueOpenAt (see BotClaimInput.elapsedSinceOpen for why an absolute
 * anchor, not a per-tick delta, is required for determinism here).
 * claimCount this tick is just the gap between that target and what's
 * already gone (poolSize - availableSeatCount) — zero or negative gaps
 * (already at/above target, e.g. from the run's one real user claiming
 * ahead of the curve) claim nothing.
 */
export function computeBotClaimCount(input: BotClaimInput): BotClaimResult {
  const alreadyClaimed = Math.max(0, input.poolSize - input.availableSeatCount);
  const targetClaimed = Math.floor(
    input.poolSize * (1 - Math.exp(-input.botCurveK * input.elapsedSinceOpen.seconds)),
  );
  const rawCount = targetClaimed - alreadyClaimed;
  const claimCount = Math.min(Math.max(0, rawCount), input.availableSeatCount);
  return { claimCount };
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
 * position = max(0, initialPosition - admissionRatePerSec * elapsed.seconds).
 * Deliberately anchored on each entry's own joinedAt (not a global queue
 * recompute) — this keeps the calc stateless and per-entry, matching the
 * tick-on-request/no-persistent-process constraint.
 */
export function computeQueuePosition(
  input: QueuePositionInput,
): QueuePositionResult {
  const position = Math.max(
    0,
    input.initialPosition - input.admissionRatePerSec * input.elapsed.seconds,
  );
  return { position, admitted: position <= 0 };
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
  /** holds whose expiresAt < now — candidates for the caller to mark releasedAt (does not free the seat, D-5) */
  expired: ExpiredHold[];
}

/**
 * Filters input.holds where expiresAt < now. Pure filter only — no DB
 * write. The caller records each expired hold as no longer active
 * (Hold.releasedAt = now); per ROADMAP D-5, Seat.status is a one-way
 * AVAILABLE -> HELD -> SOLD transition, so an expired hold does NOT flip
 * its seat back to AVAILABLE. The same filter also serves a single hold's
 * "is my hold still valid" check (call with a one-element `holds` array).
 */
export function findExpiredHolds(
  input: HoldExpiryCheckInput,
): HoldExpiryCheckResult {
  const expired = input.holds
    .filter((hold) => hold.expiresAt.getTime() < input.now.getTime())
    .map((hold) => ({ holdId: hold.id, seatId: hold.seatId }));
  return { expired };
}
