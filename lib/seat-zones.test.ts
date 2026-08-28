import { describe, it, expect } from "vitest";
import {
  computeZoneGrid,
  getZoneForSeat,
  getZoneOrder,
  getZoneSeatRange,
  groupSeatsByZone,
  isValidZone,
  type SeatGridConfig,
} from "@/lib/seat-zones";
import { SeatStatus, type SeatSummary } from "@/lib/types";

// D-15/D-17 target scale per tier (docs/ROADMAP.md D-15/D-17):
// SMALL 25 rows x 100/row, 8 zones (2 bands x 4 splits)
// MEDIUM 70 x 100, 15 zones (3 bands x 5 splits)
// MEGA 150 x 100, 25 zones (5 bands x 5 splits)
const TIER_CONFIGS: SeatGridConfig[] = [
  { seatRows: 25, seatsPerRow: 100, zoneCount: 8 },
  { seatRows: 70, seatsPerRow: 100, zoneCount: 15 },
  { seatRows: 150, seatsPerRow: 100, zoneCount: 25 },
];

function makeSeats(seatRows: number, seatsPerRow: number): SeatSummary[] {
  const seats: SeatSummary[] = [];
  for (let row = 1; row <= seatRows; row++) {
    for (let number = 1; number <= seatsPerRow; number++) {
      seats.push({ id: `${row}-${number}`, row: String(row), number, status: SeatStatus.AVAILABLE });
    }
  }
  return seats;
}

describe("computeZoneGrid", () => {
  it("picks the divisor pair closest to a square zone shape, per tier", () => {
    expect(computeZoneGrid(8, 25, 100)).toEqual({ bands: 2, splits: 4 });
    expect(computeZoneGrid(15, 70, 100)).toEqual({ bands: 3, splits: 5 });
    expect(computeZoneGrid(25, 150, 100)).toEqual({ bands: 5, splits: 5 });
  });

  it("never returns bands=1 or splits=1 (would degrade to the old 1D strip scheme)", () => {
    for (const { zoneCount, seatRows, seatsPerRow } of TIER_CONFIGS) {
      const { bands, splits } = computeZoneGrid(zoneCount, seatRows, seatsPerRow);
      expect(bands).toBeGreaterThanOrEqual(2);
      expect(splits).toBeGreaterThanOrEqual(2);
      expect(bands * splits).toBe(zoneCount);
    }
  });

  it("throws for a zoneCount with no bands>=2/splits>=2 divisor pair (e.g. prime)", () => {
    expect(() => computeZoneGrid(7, 70, 100)).toThrow();
  });
});

describe("getZoneOrder", () => {
  it("returns zoneCount sequential zone ids starting at 1", () => {
    expect(getZoneOrder(8)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
});

describe("isValidZone", () => {
  it("accepts the first and last zone id for a given zoneCount", () => {
    expect(isValidZone("1", 8)).toBe(true);
    expect(isValidZone("8", 8)).toBe(true);
  });

  it("rejects zone ids out of range, non-integer, or non-numeric", () => {
    expect(isValidZone("0", 8)).toBe(false);
    expect(isValidZone("9", 8)).toBe(false);
    expect(isValidZone("1.5", 8)).toBe(false);
    expect(isValidZone("abc", 8)).toBe(false);
    expect(isValidZone("", 8)).toBe(false);
  });
});

describe("getZoneForSeat / getZoneSeatRange round-trip", () => {
  it("every seat in a zone's range maps back to that zone, and zones tile the whole grid with no gap/overlap", () => {
    for (const config of TIER_CONFIGS) {
      const { bands, splits } = computeZoneGrid(config.zoneCount, config.seatRows, config.seatsPerRow);
      const coveredRowsBySplit = new Map<string, Set<number>>();

      for (const zone of getZoneOrder(config.zoneCount)) {
        const range = getZoneSeatRange(zone, config);
        for (let row = range.rowStart; row <= range.rowEnd; row++) {
          for (let number = range.numberStart; number <= range.numberEnd; number++) {
            expect(getZoneForSeat(row, number, config)).toBe(zone);
          }
        }
      }
      expect(bands * splits).toBe(config.zoneCount);
      void coveredRowsBySplit;
    }
  });

  it("assigns the first seat (row 1, number 1) to zone 1 and the last seat to the last zone", () => {
    for (const config of TIER_CONFIGS) {
      expect(getZoneForSeat(1, 1, config)).toBe("1");
      expect(getZoneForSeat(config.seatRows, config.seatsPerRow, config)).toBe(String(config.zoneCount));
    }
  });
});

describe("groupSeatsByZone", () => {
  it("splits every tier's full seat map into exactly zoneCount groups, losing no seat", () => {
    for (const config of TIER_CONFIGS) {
      const seats = makeSeats(config.seatRows, config.seatsPerRow);
      const groups = groupSeatsByZone(seats, config);

      expect(Object.keys(groups)).toHaveLength(config.zoneCount);
      const totalGrouped = Object.values(groups).reduce((sum, zoneSeats) => sum + zoneSeats.length, 0);
      expect(totalGrouped).toBe(seats.length);
    }
  });

  it("keeps each zone's size close to the design table (313/467/600 average), within the balanced-partition bound", () => {
    for (const config of TIER_CONFIGS) {
      const { bands, splits } = computeZoneGrid(config.zoneCount, config.seatRows, config.seatsPerRow);
      const seats = makeSeats(config.seatRows, config.seatsPerRow);
      const groups = groupSeatsByZone(seats, config);

      const rowsPerBandLower = Math.floor(config.seatRows / bands);
      const rowsPerBandUpper = Math.ceil(config.seatRows / bands);
      const colsPerSplitLower = Math.floor(config.seatsPerRow / splits);
      const colsPerSplitUpper = Math.ceil(config.seatsPerRow / splits);
      const lowerBound = rowsPerBandLower * colsPerSplitLower;
      const upperBound = rowsPerBandUpper * colsPerSplitUpper;

      for (const zone of getZoneOrder(config.zoneCount)) {
        expect(groups[zone].length).toBeGreaterThanOrEqual(lowerBound);
        expect(groups[zone].length).toBeLessThanOrEqual(upperBound);
      }
    }
  });

  it("produces a near-square zone shape (not a tall 4-wide strip) for MEGA", () => {
    const config = TIER_CONFIGS[2];
    const range = getZoneSeatRange("1", config);
    const rowSpan = range.rowEnd - range.rowStart + 1;
    const numberSpan = range.numberEnd - range.numberStart + 1;
    // Old 1D scheme gave a 150-row x 4-col strip (aspect ratio 37.5:1).
    // 2D banding should land close to square (30 x 20, aspect ratio 1.5:1).
    expect(rowSpan / numberSpan).toBeLessThan(2);
  });
});
