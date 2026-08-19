"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSelectedSeat } from "@/lib/session-storage";
import type { DeliveryMethod } from "@/lib/types";
import { HoldTimer } from "@/app/components/HoldTimer";
import { StepIndicator } from "@/app/components/StepIndicator";

const HOLD_DURATION_MS = 5 * 60_000;

const DELIVERY_OPTIONS: Array<{ value: DeliveryMethod; label: string; description: string }> = [
  { value: "mobile", label: "Mobile Ticket", description: "Scan a QR code at entry — no printing needed." },
  { value: "onsite", label: "Pick Up at Venue", description: "Collect a physical ticket at the box office." },
];

/**
 * Rendered only on the client (see app/booking/BookingViewLoader.tsx): the
 * selected seat lives in sessionStorage, so an SSR pass would always see
 * "no seat" while client hydration sees the real value — same hydration
 * mismatch class as app/seats/SeatsView.tsx.
 */
export default function BookingView() {
  const router = useRouter();
  const [selectedSeat] = useState(() => getSelectedSeat());
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod | null>(null);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedRefundPolicy, setAgreedRefundPolicy] = useState(false);

  const canProceed = deliveryMethod !== null && agreedTerms && agreedRefundPolicy;

  if (!selectedSeat) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
        <StepIndicator currentStage="booking" />
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
          <p className="text-[var(--color-ink)]">No seat selected yet.</p>
          <Link
            href="/seats"
            className="rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white"
          >
            Go choose a seat
          </Link>
        </div>
      </div>
    );
  }

  const holdExpiresAt = new Date(
    new Date(selectedSeat.selectedAt).getTime() + HOLD_DURATION_MS,
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="booking" />

      <div className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div>
          <p className="text-xs text-[var(--color-mute)]">Selected seat</p>
          <p className="font-mono text-2xl font-semibold text-[var(--color-ink)]">
            {selectedSeat.row}
            {selectedSeat.number}
          </p>
          <p className="mt-1 text-xs text-[var(--color-mute)]">1 ticket</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--color-mute)]">Hold expires in</p>
          <HoldTimer expiresAt={holdExpiresAt} />
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

      <button
        type="button"
        disabled={!canProceed}
        onClick={() => router.push("/payment")}
        className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        Proceed to Payment
      </button>
    </div>
  );
}
