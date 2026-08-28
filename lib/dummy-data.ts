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
