// Seat zones — UI-facing grouping of (Seat.row, Seat.number) into
// zoneCount rectangular blocks. No schema field backs this; it's derived
// purely from the tier's SimulationConfig (seatRows/seatsPerRow/zoneCount).
// See CLAUDE.md and ROADMAP.md's "구역 개념은 UI 전용" note. D-15: zoneCount is
// tier-parameterized (SimulationConfig.zoneCount: 8/15/25) instead of a
// fixed 5, so zone ids are plain numeric strings ("1".."zoneCount") rather
// than letters — the same scalability reason Seat.row moved off A-Z
// labeling.
//
// D-17: zones are 2D (row-distance band x left-right split), not just a
// number-axis split. A number-only split makes each zone span every row
// (e.g. MEGA: 4 columns x all 150 rows) — a tall, narrow strip that forces
// a very long vertical scroll. Splitting the row axis into bands too keeps
// each zone closer to a real venue's "distance tier x angle" section and
// closer to a square aspect ratio on screen.
//
// Lives in its own module (not lib/dummy-data.ts, despite originating
// there) because Step 6 (D-15) made this real server-side filtering logic
// (lib/seats.ts's listSeatMap uses getZoneSeatRange to scope its SQL
// query) — dummy-data.ts is documented UI-only placeholder data, and the
// real backend must not depend on it.
import type { SeatSummary } from "@/lib/types";

export type SeatZone = string;

export interface SeatGridConfig {
  zoneCount: number;
  seatRows: number;
  seatsPerRow: number;
}

export interface ZoneGrid {
  /** number of row-distance bands (stage-distance axis) */
  bands: number;
  /** number of left-right splits within a band (number axis) */
  splits: number;
}

/**
 * Factors zoneCount into (bands x splits) — bands partitions the row axis,
 * splits partitions the number axis within each band — choosing the pair
 * whose resulting zone shape (seatRows/bands rows x seatsPerRow/splits
 * columns) is closest to square, so zones read as blocks rather than
 * strips. bands=1 (all rows in one band — the old number-only scheme) is
 * deliberately excluded even when it would score best, since the whole
 * point of D-17 is a real row-axis split; splits=1 is excluded for the
 * same reason. If zoneCount has no divisor pair with both sides >= 2
 * (e.g. zoneCount is prime), no valid 2D grid exists and this throws —
 * documented as a known gap (see docs/ROADMAP.md D-17) rather than silently
 * falling back to a 1D strip.
 */
export function computeZoneGrid(zoneCount: number, seatRows: number, seatsPerRow: number): ZoneGrid {
  let best: ZoneGrid | null = null;
  let bestScore = Infinity;

  for (let bands = 2; bands < zoneCount; bands++) {
    if (zoneCount % bands !== 0) continue;
    const splits = zoneCount / bands;
    if (splits < 2) continue;

    const bandRows = seatRows / bands;
    const splitCols = seatsPerRow / splits;
    const score = Math.max(bandRows, splitCols) / Math.min(bandRows, splitCols);
    if (score < bestScore) {
      bestScore = score;
      best = { bands, splits };
    }
  }

  if (!best) {
    throw new Error(
      `computeZoneGrid: zoneCount=${zoneCount} has no bands>=2/splits>=2 divisor pair (likely prime) — a 2D zone grid isn't possible. See docs/ROADMAP.md D-17.`,
    );
  }
  return best;
}

export function getZoneOrder(zoneCount: number): SeatZone[] {
  return Array.from({ length: zoneCount }, (_, i) => String(i + 1));
}

/** True iff zone is an integer string in [1, zoneCount] — used to validate GET /api/seats's ?zone= query param. */
export function isValidZone(zone: string, zoneCount: number): boolean {
  if (!/^\d+$/.test(zone)) return false;
  const n = Number(zone);
  return n >= 1 && n <= zoneCount;
}

export function getZoneLabel(zone: SeatZone): string {
  return `Zone ${zone}`;
}

/**
 * Classifies a 1-based position along an axis of length `total` into one
 * of `count` buckets (0-based index). Multiply-then-divide (single
 * division) keeps this exactly consistent with partitionRange's boundary
 * math for non-integer bucket widths (e.g. 70/3) — dividing twice (by a
 * pre-divided width) risks the two functions rounding differently at a
 * boundary seat.
 */
function partitionIndex(position: number, count: number, total: number): number {
  const index = Math.min(Math.floor(((position - 1) * count) / total), count - 1);
  return Math.max(index, 0);
}

/** Inverse of partitionIndex: the inclusive [start, end] 1-based range covered by bucket `index` of `count` buckets over an axis of length `total`. */
function partitionRange(index: number, count: number, total: number): { start: number; end: number } {
  const start = Math.ceil((index * total) / count) + 1;
  const end = Math.ceil(((index + 1) * total) / count);
  return { start, end };
}

/** Zone ids are assigned row-major: band 0 holds zones 1..splits, band 1 holds splits+1..2*splits, etc. */
export function getZoneForSeat(row: number, number: number, config: SeatGridConfig): SeatZone {
  const { bands, splits } = computeZoneGrid(config.zoneCount, config.seatRows, config.seatsPerRow);
  const bandIndex = partitionIndex(row, bands, config.seatRows);
  const splitIndex = partitionIndex(number, splits, config.seatsPerRow);
  return String(bandIndex * splits + splitIndex + 1);
}

export interface ZoneSeatRange {
  rowStart: number;
  rowEnd: number;
  numberStart: number;
  numberEnd: number;
}

/**
 * Inverse of getZoneForSeat: the inclusive row/number ranges covered by
 * one zone, for the server to filter seats with a single SQL range
 * condition on each axis instead of fetching every seat and re-deriving
 * zone membership per row (see lib/seats.ts's listSeatMap).
 */
export function getZoneSeatRange(zone: SeatZone, config: SeatGridConfig): ZoneSeatRange {
  const { bands, splits } = computeZoneGrid(config.zoneCount, config.seatRows, config.seatsPerRow);
  const zoneIndex = Number(zone) - 1;
  const bandIndex = Math.floor(zoneIndex / splits);
  const splitIndex = zoneIndex % splits;

  const rowRange = partitionRange(bandIndex, bands, config.seatRows);
  const numberRange = partitionRange(splitIndex, splits, config.seatsPerRow);
  return { rowStart: rowRange.start, rowEnd: rowRange.end, numberStart: numberRange.start, numberEnd: numberRange.end };
}

export function groupSeatsByZone(
  seats: SeatSummary[],
  config: SeatGridConfig,
): Record<SeatZone, SeatSummary[]> {
  const groups = Object.fromEntries(
    getZoneOrder(config.zoneCount).map((zone) => [zone, [] as SeatSummary[]]),
  ) as Record<SeatZone, SeatSummary[]>;
  for (const seat of seats) {
    groups[getZoneForSeat(Number(seat.row), seat.number, config)].push(seat);
  }
  return groups;
}
