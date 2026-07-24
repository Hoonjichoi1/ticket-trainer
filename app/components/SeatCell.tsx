"use client";

import { SeatStatus } from "@/lib/types";

export interface SeatCellProps {
  seatId: string;
  row: string;
  number: number;
  status: SeatStatus;
  /** Only meaningful when status is AVAILABLE — layered on top via this
   * boolean rather than a 4th SeatStatus value. */
  selected?: boolean;
  onSelect?: (seatId: string) => void;
  /** Show the row/number label inside the circle, in the mono data font. Default true. */
  showLabel?: boolean;
  className?: string;
}

// The "포도알" (grape-seed) signature: seats render as circles, not the
// square grid every real ticketing platform uses. available/held/sold
// read as one color family at different points of being picked — vivid
// violet (ripe, available) -> light lavender (mid-pick, held) -> stone
// gray (picked clean, sold).
const STATUS_STYLES: Record<SeatStatus, string> = {
  [SeatStatus.AVAILABLE]:
    "border-[var(--color-seat-available)] bg-[var(--color-seat-available)] text-white shadow-[0_2px_10px_rgba(130,87,230,0.35)] hover:scale-110 hover:shadow-[0_4px_14px_rgba(130,87,230,0.5)]",
  [SeatStatus.HELD]:
    "border-[var(--color-seat-held)] bg-[var(--color-seat-held)] text-[var(--color-ink)] animate-pulse motion-reduce:animate-none",
  [SeatStatus.SOLD]:
    "border-[var(--color-seat-sold)] bg-[var(--color-seat-sold)] text-white opacity-50",
};

/**
 * Purely presentational — status/selected come in via props, no
 * fetching or independent seat-state ownership. The click handler only
 * guards against acting on a non-available seat (the same category as a
 * disabled <button>), not business logic.
 */
export function SeatCell({
  seatId,
  row,
  number,
  status,
  selected = false,
  onSelect,
  showLabel = true,
  className,
}: SeatCellProps) {
  const isAvailable = status === SeatStatus.AVAILABLE;

  return (
    <button
      type="button"
      disabled={!isAvailable}
      aria-pressed={isAvailable ? selected : undefined}
      aria-label={`Seat ${row}${number}, ${status.toLowerCase()}`}
      onClick={() => {
        if (isAvailable) onSelect?.(seatId);
      }}
      className={[
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] transition-transform",
        STATUS_STYLES[status],
        isAvailable ? "cursor-pointer" : "cursor-not-allowed",
        selected && isAvailable
          ? "ring-2 ring-[var(--color-ink)] ring-offset-2 ring-offset-[var(--color-page)]"
          : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {showLabel ? `${row}${number}` : null}
    </button>
  );
}
