"use client";

import { useRouter } from "next/navigation";
import { clearSelectedSeat } from "@/lib/session-storage";

/**
 * A plain <Link href="/"> would leave the previous run's seat in
 * sessionStorage, so a fresh "Try again" run could briefly see stale hold
 * data before the seat-selection page overwrites it. This clears it first.
 */
export function TryAgainButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        clearSelectedSeat();
        router.push("/");
      }}
      className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white"
    >
      Try again
    </button>
  );
}
