// Client-only sessionStorage helpers carrying the selected seat across
// /seats -> /booking -> /payment -> /result while there's no backend to
// own this state (Task 005-1). Not part of the deterministic simulation
// core — pure UI plumbing, safe to remove once a real session API exists.

import type { SeatSummary } from "@/lib/types";

const SELECTED_SEAT_STORAGE_KEY = "ticket-trainer:selected-seat";

export interface SelectedSeatStorage {
  id: string;
  row: string;
  number: number;
  /** ISO 8601 — when the user confirmed this seat, for display purposes only. */
  selectedAt: string;
  /**
   * ISO 8601 — the real Hold expiry from POST /api/seats (Task 009). Stored
   * alongside selectedAt so a later task can switch the booking/payment
   * pages' hold timers to this server-issued value instead of their current
   * `selectedAt + hardcoded 5min` calculation, without touching this storage
   * layer again.
   */
  holdExpiresAt: string;
}

export function saveSelectedSeat(seat: SeatSummary, holdExpiresAt: string): void {
  if (typeof window === "undefined") return;
  const payload: SelectedSeatStorage = {
    id: seat.id,
    row: seat.row,
    number: seat.number,
    selectedAt: new Date().toISOString(),
    holdExpiresAt,
  };
  window.sessionStorage.setItem(SELECTED_SEAT_STORAGE_KEY, JSON.stringify(payload));
}

function isValidSelectedSeat(value: unknown): value is SelectedSeatStorage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.row === "string" &&
    typeof v.number === "number" &&
    typeof v.selectedAt === "string" &&
    !Number.isNaN(new Date(v.selectedAt).getTime()) &&
    typeof v.holdExpiresAt === "string" &&
    !Number.isNaN(new Date(v.holdExpiresAt).getTime())
  );
}

export function getSelectedSeat(): SelectedSeatStorage | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(SELECTED_SEAT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSelectedSeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSelectedSeat(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SELECTED_SEAT_STORAGE_KEY);
}
