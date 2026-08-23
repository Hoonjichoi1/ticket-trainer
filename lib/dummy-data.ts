// Pre-backend placeholder data for Task 5's pages. Every generator here
// returns the exact shape of its corresponding lib/types.ts response type,
// so swapping to real API calls later requires no prop-shape changes on
// the consuming components. This module has no purity contract like
// lib/simulation.ts's tick engine — it's UI-only fixture data, not part
// of the deterministic simulation core.

import {
  SeatStatus,
  QueueEntryStatus,
  Tier,
  type SeatMapResponse,
  type SeatSummary,
  type QueuePollResponse,
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
// Seat zones — UI-only grouping of Seat.number into 5 left-to-right
// blocks (stage-relative). No schema field backs this; Seat.row (front/
// back distance) is never used for zone membership. See CLAUDE.md and
// ROADMAP.md's "구역(Block A~E) 개념은 UI 전용" note.
// ---------------------------------------------------------------------
export const SEAT_ZONES = ["A", "B", "C", "D", "E"] as const;
export type SeatZone = (typeof SEAT_ZONES)[number];

export const ZONE_LABELS: Record<SeatZone, string> = {
  A: "Block A",
  B: "Block B",
  C: "Block C",
  D: "Block D",
  E: "Block E",
};

/** 1-4 -> A, 5-8 -> B, 9-12 -> C, 13-16 -> D, 17-20 -> E. */
export function getZoneForSeatNumber(number: number): SeatZone {
  const index = Math.min(Math.floor((number - 1) / 4), SEAT_ZONES.length - 1);
  return SEAT_ZONES[Math.max(index, 0)];
}

export function groupSeatsByZone(
  seats: SeatSummary[],
): Record<SeatZone, SeatSummary[]> {
  const groups = Object.fromEntries(
    SEAT_ZONES.map((zone) => [zone, [] as SeatSummary[]]),
  ) as Record<SeatZone, SeatSummary[]>;
  for (const seat of seats) {
    groups[getZoneForSeatNumber(seat.number)].push(seat);
  }
  return groups;
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
