"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getDummySeatMap,
  groupSeatsByZone,
  SEAT_ZONES,
  ZONE_LABELS,
  type SeatZone,
} from "@/lib/dummy-data";
import { SeatStatus, type SeatSummary } from "@/lib/types";
import { SeatCell } from "@/app/components/SeatCell";
import { HoldTimer } from "@/app/components/HoldTimer";
import { StepIndicator } from "@/app/components/StepIndicator";
import { saveSelectedSeat } from "@/lib/session-storage";

type View = "zone" | "seatmap";

const ZONE_ORDER: SeatZone[] = [...SEAT_ZONES];

function chunkIntoRows(seats: SeatSummary[]): SeatSummary[][] {
  const rows: SeatSummary[][] = [];
  for (let i = 0; i < seats.length; i += 4) {
    rows.push(seats.slice(i, i + 4));
  }
  return rows;
}

/**
 * Rendered only on the client (see app/seats/page.tsx's `dynamic(..., {
 * ssr: false })`): getDummySeatMap() calls Math.random() per seat, so an
 * SSR pass would compute a different seat map than the client and trigger
 * a hydration mismatch on the "N/40 open" zone counts.
 */
export default function SeatsView() {
  const router = useRouter();
  const [seatMap] = useState(() => getDummySeatMap());
  const zones = useMemo(() => groupSeatsByZone(seatMap.seats), [seatMap]);
  const [view, setView] = useState<View>("zone");
  const [activeZone, setActiveZone] = useState<SeatZone | null>(null);
  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null);
  const [holdExpiresAt] = useState(() => new Date(Date.now() + 5 * 60_000));

  function handleZoneSelect(zone: SeatZone) {
    setActiveZone(zone);
    setSelectedSeatId(null);
    setView("seatmap");
  }

  function handleBack() {
    setView("zone");
    setActiveZone(null);
    setSelectedSeatId(null);
  }

  function handleConfirm() {
    if (!activeZone || !selectedSeatId) return;
    const seat = zones[activeZone].find((s) => s.id === selectedSeatId);
    if (!seat) return;
    saveSelectedSeat(seat);
    router.push("/booking");
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="seats" />

      {view === "zone" && (
        <ZonePreview zones={zones} onSelect={handleZoneSelect} />
      )}

      {view === "seatmap" && activeZone && (
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleBack}
              className="text-sm text-[var(--color-mute)] underline"
            >
              ← Back to zone selection
            </button>
            <HoldTimer expiresAt={holdExpiresAt} />
          </div>

          <h2 className="text-center font-[family-name:var(--font-space-grotesk)] text-xl font-semibold text-[var(--color-ink)]">
            {ZONE_LABELS[activeZone]}
          </h2>

          <div className="flex flex-col items-center gap-2">
            {chunkIntoRows(zones[activeZone]).map((row, index) => (
              <div key={index} className="flex gap-2">
                {row.map((seat) => (
                  <SeatCell
                    key={seat.id}
                    seatId={seat.id}
                    row={seat.row}
                    number={seat.number}
                    status={seat.status}
                    selected={seat.id === selectedSeatId}
                    onSelect={setSelectedSeatId}
                  />
                ))}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedSeatId}
            className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm Seat Selection
          </button>
        </div>
      )}
    </div>
  );
}

interface ZonePreviewProps {
  zones: Record<SeatZone, SeatSummary[]>;
  onSelect: (zone: SeatZone) => void;
}

// All geometry below is an invented, stylized floor plan (arbitrary
// constants for our own simplified 5-zone fan), not a real venue's
// measured coordinates — see the task's "실제 좌표 계산 없이" note. It's
// still real trigonometry so that adjacent zone wedges share exact edges
// (no gaps, no overlap) and the ring wraps around the stage sitting at
// its hub, per the reference screenshot (stage centered inside the fan,
// not perched above it).
const VIEWBOX_WIDTH = 640;
const VIEWBOX_HEIGHT = 400;
const ARC_PIVOT = { x: VIEWBOX_WIDTH / 2, y: 130 };
const STAGE_RADIUS = 92;
const INNER_RADIUS = 112;
const OUTER_RADIUS = 252;
// -90..90: left edge sits at 9 o'clock, right edge at 3 o'clock, so all 5
// zones live in the lower half-circle only (angle 0 = straight down).
const TOTAL_SPAN_DEG = 180;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** angle 0 = straight down from the pivot; positive = toward the right. */
function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = toRad(angleDeg);
  return {
    x: ARC_PIVOT.x + radius * Math.sin(rad),
    y: ARC_PIVOT.y + radius * Math.cos(rad),
  };
}

/**
 * Inner and outer edges are true circular arcs (SVG elliptical-arc
 * command) so they follow the stage's own roundness, instead of the
 * straight chords a <polygon> would draw. The two side edges stay
 * straight radial lines — that's what keeps adjacent wedges touching
 * with zero gap.
 */
function wedgePathD(startDeg: number, endDeg: number): string {
  const innerStart = polar(startDeg, INNER_RADIUS);
  const innerEnd = polar(endDeg, INNER_RADIUS);
  const outerEnd = polar(endDeg, OUTER_RADIUS);
  const outerStart = polar(startDeg, OUTER_RADIUS);
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  return [
    `M ${fmt(innerStart)}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 0 0 ${fmt(innerEnd)}`,
    `L ${fmt(outerEnd)}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 ${fmt(outerStart)}`,
    "Z",
  ].join(" ");
}

/**
 * Adjacent wedges share an apex (ARC_PIVOT) and are cut at consecutive
 * multiples of the same angular step, so their radial edges are literally
 * the same line segment — they abut with zero gap, like slices of a pie,
 * rather than separately-placed rotated cards.
 */
function ZonePreview({ zones, onSelect }: ZonePreviewProps) {
  const step = TOTAL_SPAN_DEG / ZONE_ORDER.length;
  const startDeg = -TOTAL_SPAN_DEG / 2;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      className="w-full"
      role="img"
      aria-label="Zone selection: choose a seating block"
    >
      {/* Solid charcoal hub — no gradient — sitting at the shared pivot so
          the zone wedges wrap fully around it, not perched above them. */}
      <circle
        cx={ARC_PIVOT.x}
        cy={ARC_PIVOT.y}
        r={STAGE_RADIUS}
        fill="var(--color-ink)"
      />
      <text
        x={ARC_PIVOT.x}
        y={ARC_PIVOT.y}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-[var(--color-surface)] text-sm font-semibold tracking-[0.25em]"
      >
        STAGE
      </text>

      {ZONE_ORDER.map((zone, index) => {
        const zoneStart = startDeg + index * step;
        const zoneEnd = zoneStart + step;
        const midDeg = zoneStart + step / 2;
        // Label + count badge are stacked in fixed screen-space (not
        // along the radial direction): wide outer wedges sit at steep
        // angles where "radially outward" is nearly horizontal, which
        // put the badge beside the label instead of under it.
        const anchor = polar(
          midDeg,
          INNER_RADIUS + (OUTER_RADIUS - INNER_RADIUS) * 0.52,
        );
        const labelPos = { x: anchor.x, y: anchor.y - 10 };
        const countPos = { x: anchor.x, y: anchor.y + 18 };
        const availableCount = zones[zone].filter(
          (s) => s.status === SeatStatus.AVAILABLE,
        ).length;

        return (
          <g
            key={zone}
            role="button"
            tabIndex={0}
            aria-label={`${ZONE_LABELS[zone]}, ${availableCount} of ${zones[zone].length} seats open`}
            className="cursor-pointer outline-none"
            onClick={() => onSelect(zone)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(zone);
              }
            }}
          >
            <path
              d={wedgePathD(zoneStart, zoneEnd)}
              className="fill-[var(--color-seat-available)] stroke-[var(--color-page)] transition-colors hover:fill-[var(--color-focus)]"
              strokeWidth={3}
            />
            <text
              x={labelPos.x}
              y={labelPos.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="pointer-events-none fill-white text-[15px] font-semibold"
            >
              {ZONE_LABELS[zone]}
            </text>
            {/* Available-seat count as a small badge right under the
                label, same upright orientation — not a fraction, just
                "how many are left" (per reference screenshot). */}
            <circle
              cx={countPos.x}
              cy={countPos.y}
              r={15}
              className="pointer-events-none fill-[var(--color-surface)]"
            />
            <text
              x={countPos.x}
              y={countPos.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="pointer-events-none fill-[var(--color-ink)] text-[12px] font-semibold"
            >
              {availableCount}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
