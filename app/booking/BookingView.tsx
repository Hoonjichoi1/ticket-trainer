"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DeliveryMethod, SubmitBookingInfoResponse } from "@/lib/types";
import { HoldTimer } from "@/app/components/HoldTimer";
import { StepIndicator } from "@/app/components/StepIndicator";

const DELIVERY_OPTIONS: Array<{ value: DeliveryMethod; label: string; description: string }> = [
  { value: "mobile", label: "Mobile Ticket", description: "Scan a QR code at entry — no printing needed." },
  { value: "onsite", label: "Pick Up at Venue", description: "Collect a physical ticket at the box office." },
];

export interface BookingViewProps {
  seat: { id: string; row: string; number: number };
  /** ISO 8601 — server-confirmed Hold.expiresAt (app/booking/page.tsx), not a client-side guess. */
  holdExpiresAt: string;
}

/**
 * Rendered only on the client (see app/booking/BookingViewLoader.tsx) so
 * `pagehide`/fetch wiring has a browser to run in. Unlike Task 005/009's
 * version, seat + holdExpiresAt come in as props from app/booking/page.tsx
 * (Server Component) rather than being read from sessionStorage here —
 * the server already re-derived them from the session's real Hold row, so
 * there'd be nothing gained (and a staleness risk) from also trusting the
 * client-side copy.
 */
export default function BookingView({ seat, holdExpiresAt }: BookingViewProps) {
  const router = useRouter();
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod | null>(null);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedRefundPolicy, setAgreedRefundPolicy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canProceed = deliveryMethod !== null && agreedTerms && agreedRefundPolicy && !submitting;

  // Best-effort hold release on navigation away/tab close (CLAUDE.md:
  // sendBeacon, not guaranteed to fire or arrive — the 5-minute Hold
  // expiry remains the real safety net). Same-origin request, so the
  // session cookie rides along without needing custom headers.
  useEffect(() => {
    function handlePageHide() {
      navigator.sendBeacon("/api/holds/release");
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  async function handleSubmit() {
    if (!deliveryMethod || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketCount: 1, deliveryMethod, termsAgreed: agreedTerms }),
      });
      const json: SubmitBookingInfoResponse = await res.json();

      if (json.status === "hold_expired") {
        // ROADMAP D-9: hold loss is a terminal failure per PRD, not a
        // reason to send the user back to pick a new seat.
        router.push("/result");
        return;
      }

      router.push("/payment");
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  const holdExpiresAtDate = new Date(holdExpiresAt);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="booking" />

      <div className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div>
          <p className="text-xs text-[var(--color-mute)]">Selected seat</p>
          <p className="font-mono text-2xl font-semibold text-[var(--color-ink)]">
            Row {seat.row}, Seat {seat.number}
          </p>
          <p className="mt-1 text-xs text-[var(--color-mute)]">1 ticket</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--color-mute)]">Hold expires in</p>
          <HoldTimer expiresAt={holdExpiresAtDate} onExpire={() => router.push("/result")} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Delivery method</h2>
        <div className="flex flex-col gap-2">
          {DELIVERY_OPTIONS.map((option) => {
            const isSelected = deliveryMethod === option.value;
            return (
              <label
                key={option.value}
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-4",
                  isSelected
                    ? "border-[var(--color-brand)] bg-[var(--color-page)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)]",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="delivery-method"
                  value={option.value}
                  checked={isSelected}
                  onChange={() => setDeliveryMethod(option.value)}
                  className="mt-1"
                />
                <span className="flex flex-col gap-1">
                  <span className="font-semibold text-[var(--color-ink)]">{option.label}</span>
                  <span className="text-xs text-[var(--color-mute)]">{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Terms</h2>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            checked={agreedTerms}
            onChange={(event) => setAgreedTerms(event.target.checked)}
          />
          I agree to the terms of service
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-ink)]">
          <input
            type="checkbox"
            checked={agreedRefundPolicy}
            onChange={(event) => setAgreedRefundPolicy(event.target.checked)}
          />
          I agree to the refund policy
        </label>
      </div>

      {errorMessage && (
        <p className="text-center text-sm text-[var(--color-danger)]">{errorMessage}</p>
      )}

      <button
        type="button"
        disabled={!canProceed}
        onClick={handleSubmit}
        className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Processing…" : "Proceed to Payment"}
      </button>
    </div>
  );
}
