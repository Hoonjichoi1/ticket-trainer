"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getZoneLabel, getZoneOrder, type SeatZone } from "@/lib/seat-zones";
import {
  type ApiErrorResponse,
  type SeatClaimResponse,
  type SeatMapResponse,
  type SeatSummary,
} from "@/lib/types";
import { SeatCell } from "@/app/components/SeatCell";
import { StepIndicator } from "@/app/components/StepIndicator";
import { WarningBanner } from "@/app/components/WarningBanner";
import { saveSelectedSeat } from "@/lib/session-storage";

type View = "zone" | "seatmap";

const POLL_INTERVAL_MS = 2000;

interface Selection {
  seatId: string;
}

interface SeatsViewProps {
  /** Tier-specific zone count (SimulationConfig.zoneCount, D-15), passed down from the server component so the zone picker never needs an unscoped seat fetch just to enumerate zones. */
  zoneCount: number;
}

/** Groups an already row-sorted seat list (lib/seats.ts's listSeatMap orders by row, then number) into one array per physical row, for grid display — not a fixed chunk size, since D-15 zone widths vary by tier (4-13 seats) instead of the old fixed-20-seats-per-row layout. */
function chunkIntoRows(seats: SeatSummary[]): SeatSummary[][] {
  const rows: SeatSummary[][] = [];
  let current: SeatSummary[] = [];
  let currentRow: string | null = null;
  for (const seat of seats) {
    if (seat.row !== currentRow) {
      if (current.length > 0) rows.push(current);
      current = [];
      currentRow = seat.row;
    }
    current.push(seat);
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/**
 * Real seat map (Task 009, refactored per ROADMAP D-6 and D-15): polls GET
 * /api/seats?zone=<activeZone> every 2s once a zone is selected
 * (tick-on-request — each poll runs the server's expired-hold release +
 * bot claim before returning the map, per CLAUDE.md's polling interval
 * guidance; the tick itself runs across the whole run, not just the
 * polled zone). Clicking a seat is a purely local selection — the real
 * atomic claim (POST /api/seats, PRD F006) only fires when "Confirm Seat
 * Selection" is pressed. A conflict there (another session/bot already
 * took the seat) clears the local selection and re-fetches the zone's map
 * so the user can immediately pick a different seat instead of getting
 * stuck.
 *
 * D-15: the zone-picker screen no longer shows live per-zone available
 * counts — GET /api/seats now requires a zone and returns only that
 * zone's seats, so showing a count for every zone up front would mean
 * fetching the whole run's seats anyway, defeating the point of scoping.
 */
export default function SeatsView({ zoneCount }: SeatsViewProps) {
  const router = useRouter();
  const zoneOrder = useMemo(() => getZoneOrder(zoneCount), [zoneCount]);
  const [seats, setSeats] = useState<SeatSummary[] | null>(null);
  const [view, setView] = useState<View>("zone");
  const [activeZone, setActiveZone] = useState<SeatZone | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const confirmingRef = useRef(false);

  useEffect(() => {
    if (!activeZone) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch(`/api/seats?zone=${activeZone}`);
        if (cancelled) return;

        if (!res.ok) {
          const body = (await res.json()) as ApiErrorResponse;
          setErrorMessage(body.message);
          return;
        }

        const body = (await res.json()) as SeatMapResponse;
        setSeats(body.seats);
        setErrorMessage(null);
      } catch {
        if (!cancelled) setErrorMessage("Connection lost. Retrying…");
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeZone]);

  function handleZoneSelect(zone: SeatZone) {
    setActiveZone(zone);
    setView("seatmap");
    setSeats(null);
    setSelection(null);
    setConflictMessage(null);
  }

  function handleBack() {
    setView("zone");
    setActiveZone(null);
    setSeats(null);
    setSelection(null);
  }

  // useCallback (stable identity across renders) matters here, not just
  // as a style choice: SeatCell is React.memo'd (Step 8), and a new
  // onSelect function on every render would make every cell's shallow
  // prop comparison fail every poll, defeating the memoization entirely.
  const handleSeatClick = useCallback((seatId: string) => {
    // Purely local UI state — no request is sent, so clicking any
    // available seat immediately replaces the current selection.
    // SeatCell already prevents clicks on non-available seats.
    setConflictMessage(null);
    setSelection({ seatId });
  }, []);

  async function handleConfirm() {
    if (!activeZone || !selection || !seats || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);

    try {
      const res = await fetch("/api/seats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatId: selection.seatId }),
      });

      if (!res.ok) {
        const body = (await res.json()) as ApiErrorResponse;
        setErrorMessage(body.message);
        return;
      }

      const result = (await res.json()) as SeatClaimResponse;
      if (result.status === "held") {
        const seat = seats.find((s) => s.id === selection.seatId);
        if (!seat) return;
        saveSelectedSeat(seat, result.holdExpiresAt);
        router.push("/booking");
        return;
      }

      setConflictMessage("That seat was just taken — pick another one.");
      // The seat we tried is no longer ours to hold — drop the local
      // selection so the user can immediately pick a different seat
      // instead of being stuck on one the map will now show as taken.
      setSelection(null);
      const res2 = await fetch(`/api/seats?zone=${activeZone}`);
      if (res2.ok) {
        const body = (await res2.json()) as SeatMapResponse;
        setSeats(body.seats);
      }
    } catch {
      setErrorMessage("Connection lost. Please try again.");
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }

  if (errorMessage) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
        <StepIndicator currentStage="seats" />
        <WarningBanner tone="danger" message={errorMessage} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="seats" />

      {view === "zone" && <ZonePicker zoneOrder={zoneOrder} onSelect={handleZoneSelect} />}

      {view === "seatmap" && activeZone && (
        <div className="flex flex-col gap-6">
          <button
            type="button"
            onClick={handleBack}
            className="self-start text-sm text-[var(--color-mute)] underline"
          >
            ← Back to zone selection
          </button>

          <h2 className="text-center font-[family-name:var(--font-space-grotesk)] text-xl font-semibold text-[var(--color-ink)]">
            {getZoneLabel(activeZone)}
          </h2>

          {conflictMessage && <WarningBanner tone="danger" message={conflictMessage} />}

          {!seats ? (
            <p className="text-center text-sm text-[var(--color-mute)]">
              Loading seat map…
            </p>
          ) : (
            <>
              {selection && (
                <p className="text-center text-sm text-[var(--color-mute)]">
                  Seat selected — press &quot;Confirm Seat Selection&quot; to hold it
                </p>
              )}

              <div className="flex flex-col items-center gap-2">
                {chunkIntoRows(seats).map((row, index) => (
                  <div key={index} className="flex gap-2">
                    {row.map((seat) => (
                      <SeatCell
                        key={seat.id}
                        seatId={seat.id}
                        row={seat.row}
                        number={seat.number}
                        status={seat.status}
                        selected={seat.id === selection?.seatId}
                        onSelect={handleSeatClick}
                      />
                    ))}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={handleConfirm}
                disabled={!selection || confirming}
                className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                {confirming ? "Confirming…" : "Confirm Seat Selection"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface ZonePickerProps {
  zoneOrder: SeatZone[];
  onSelect: (zone: SeatZone) => void;
}

/**
 * D-15: replaces the old 5-wedge SVG fan (hand-tuned trigonometry for a
 * fixed 5 zones) with a responsive button grid, since zoneCount now varies
 * 8-25 across tiers — a fan of 25 wedges over the same 180° arc would be
 * a few degrees each, too thin to hold a legible label.
 */
function ZonePicker({ zoneOrder, onSelect }: ZonePickerProps) {
  return (
    <div className="flex flex-col items-center gap-6">
      <p className="text-center text-sm text-[var(--color-mute)]">
        Choose a seating zone
      </p>
      <div className="grid w-full grid-cols-4 gap-3 sm:grid-cols-5">
        {zoneOrder.map((zone) => (
          <button
            key={zone}
            type="button"
            onClick={() => onSelect(zone)}
            className="rounded-2xl border border-[var(--color-seat-available)] bg-[var(--color-surface)] px-3 py-4 text-center text-sm font-semibold text-[var(--color-ink)] transition-colors hover:bg-[var(--color-seat-available)] hover:text-white"
          >
            {getZoneLabel(zone)}
          </button>
        ))}
      </div>
    </div>
  );
}
