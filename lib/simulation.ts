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
// Bot claim count (F008) — D-21: front-loaded exponential-approach curve;
// D-25: input switched from raw elapsed to cumulative arrivals
// ---------------------------------------------------------------------
export interface BotClaimInput {
  /**
   * Cumulative number of virtual queue entrants who have reached the seat
   * screen (been admitted out of the queue) since SimulationRun.queueOpenAt,
   * by this tick's `now` — computed by the caller as
   * `SimulationConfig.admissionRatePerSec * elapsedSinceOpen.seconds`
   * (the queue's own admission-drain model, see lib/queue.ts's
   * computeQueuePosition). This app models its virtual crowd through
   * aggregate per-tier rates rather than individual QueueEntry rows (a run
   * has exactly one real QueueEntry — the player), so this rate-derived
   * count is the crowd-level analog of "how many people have reached the
   * seat screen so far," same modeling approach computeInitialQueuePosition
   * already uses for queue *inflow* via arrivalRatePerSec.
   *
   * D-21's fixed-anchor requirement still applies unchanged: this must be
   * an ABSOLUTE cumulative count since queueOpenAt, not a per-tick delta,
   * so the same value always means the same point on the curve regardless
   * of tick history (see arrivalScaleFactor for how it's turned into a
   * curve position, and ROADMAP D-25 for F007's redefinition in terms of
   * this value instead of raw elapsed).
   */
  cumulativeArrivals: number;
  /** SimulationConfig.botCurveK for this run's tier — exponential curve steepness (1 / arrival-unit, scaled via arrivalScaleFactor below); higher = faster early depletion */
  botCurveK: number;
  /**
   * The tier's DESIGNED/baseline admission throughput (seats/sec) —
   * `cumulativeArrivals / arrivalScaleFactor` rescales cumulativeArrivals
   * back onto the same seconds-like scale botCurveK was originally tuned
   * against (see ROADMAP D-21/D-23's measured tables, all tuned in terms
   * of elapsed seconds). When the caller derives cumulativeArrivals from
   * this tier's own current admissionRatePerSec, the ratio equals
   * elapsedSinceOpen exactly, reproducing D-21's original curve bit-for-bit
   * (D-25's "normal speed" case). If the queue's actual admission
   * throughput ever diverges from this baseline — e.g. the crowd arriving
   * faster or slower than the pace botCurveK was calibrated against — the
   * ratio diverges from elapsed too, and the curve speeds up or slows down
   * accordingly. Treated as 0 (no depletion) if <= 0, to avoid a
   * divide-by-zero.
   */
  arrivalScaleFactor: number;
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
 * D-25: real gameplay showed depletion tracking wall-clock time alone felt
 * wrong while the queue kept admitting people — depletion should track how
 * many people have actually flowed through, not just seconds. So the
 * curve's input is now `t = cumulativeArrivals / arrivalScaleFactor`
 * instead of raw elapsed seconds; targetClaimed(t) = floor(poolSize * (1 -
 * e^(-botCurveK * t))) is still the ABSOLUTE cumulative depletion target
 * (see BotClaimInput.cumulativeArrivals for why an absolute anchor, not a
 * per-tick delta, is required for determinism here). claimCount this tick
 * is just the gap between that target and what's already gone (poolSize -
 * availableSeatCount) — zero or negative gaps (already at/above target,
 * e.g. from the run's one real user claiming ahead of the curve) claim
 * nothing.
 */
export function computeBotClaimCount(input: BotClaimInput): BotClaimResult {
  const alreadyClaimed = Math.max(0, input.poolSize - input.availableSeatCount);
  const t = input.arrivalScaleFactor > 0 ? input.cumulativeArrivals / input.arrivalScaleFactor : 0;
  const targetClaimed = Math.floor(input.poolSize * (1 - Math.exp(-input.botCurveK * t)));
  const rawCount = targetClaimed - alreadyClaimed;
  const claimCount = Math.min(Math.max(0, rawCount), input.availableSeatCount);
  return { claimCount };
}

// ---------------------------------------------------------------------
// Initial queue position (F002/F003, D-23 2nd revision) — surge window
// ---------------------------------------------------------------------

/**
 * Length, in seconds, of the "opening-instant surge" window that
 * computeInitialQueuePosition ramps SimulationConfig.surgeBaseline over.
 * Fixed at 1s, identical across tiers (not a per-tier config field) — the
 * D-23 2nd-revision request judged a real "Book Now" click's reaction time
 * to realistically be well under 1s, and a longer window (3s was
 * considered and rejected) would spread that reaction time over too wide a
 * range to make sub-second timing differences visible in the resulting
 * position. See ROADMAP D-23.
 */
export const SURGE_WINDOW_SECONDS = 1;

export interface InitialQueuePositionInput {
  /** computeElapsedTime({ since: SimulationRun.queueOpenAt, now: joinedAt }) */
  elapsedSinceOpen: ElapsedTime;
  /** SimulationConfig.surgeBaseline for this run's tier — the position reached at exactly elapsedSinceOpen == SURGE_WINDOW_SECONDS */
  surgeBaseline: number;
  /** SimulationConfig.arrivalRatePerSec for this run's tier — gentle per-second growth applied only once the surge window has closed */
  arrivalRatePerSec: number;
}

export interface InitialQueuePositionResult {
  /** rounded to the nearest integer — QueueEntry.position is Int */
  position: number;
}

/**
 * D-23 2nd revision: replaces the 1st revision's flat `surgeBaseline +
 * arrivalRatePerSec * elapsed` formula, which made surgeBaseline a constant
 * floor for any elapsed near 0 — a click at 0.1s and a click at 0.9s after
 * open landed at (almost) the same position, defeating F002/F003's actual
 * training goal of rewarding a fast click.
 *
 * Within the surge window (elapsedSinceOpen <= SURGE_WINDOW_SECONDS),
 * position ramps LINEARLY from 0 at elapsed=0 to surgeBaseline at
 * elapsed=SURGE_WINDOW_SECONDS, so reaction time inside that window
 * directly and proportionally determines position — clicking at 0.1s lands
 * at ~10% of surgeBaseline, 0.9s at ~90%. After the window, position keeps
 * climbing at the tier's normal (much gentler) arrivalRatePerSec, counting
 * from the window's close — continuous at the boundary, since both pieces
 * equal surgeBaseline at elapsed=SURGE_WINDOW_SECONDS.
 */
export function computeInitialQueuePosition(
  input: InitialQueuePositionInput,
): InitialQueuePositionResult {
  const { elapsedSinceOpen, surgeBaseline, arrivalRatePerSec } = input;
  const t = elapsedSinceOpen.seconds;
  const position =
    t <= SURGE_WINDOW_SECONDS
      ? surgeBaseline * (t / SURGE_WINDOW_SECONDS)
      : surgeBaseline + arrivalRatePerSec * (t - SURGE_WINDOW_SECONDS);
  return { position: Math.round(position) };
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
