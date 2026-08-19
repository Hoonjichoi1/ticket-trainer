"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSelectedSeat } from "@/lib/session-storage";
import type { DummyCardDetails, PaymentErrorType, PaymentMethod } from "@/lib/types";
import { HoldTimer } from "@/app/components/HoldTimer";
import { StepIndicator } from "@/app/components/StepIndicator";
import { PaymentModal, type PaymentModalPhase } from "@/app/components/PaymentModal";

const HOLD_DURATION_MS = 5 * 60_000;

const METHOD_META: Record<
  PaymentMethod,
  { label: string; description: string; durationMs: number; speedHint: string }
> = {
  bank_transfer: {
    label: "Bank Transfer",
    description: "Instant virtual account transfer.",
    durationMs: 600,
    speedHint: "~0.6s · fastest",
  },
  easy_pay: {
    label: "Easy Pay",
    description: "One-tap payment with a saved account.",
    durationMs: 1200,
    speedHint: "~1.2s",
  },
  card: {
    label: "Card",
    description: "Enter dummy card details manually.",
    durationMs: 2200,
    speedHint: "~2.2s · slowest",
  },
};

const METHOD_ORDER: PaymentMethod[] = ["easy_pay", "card", "bank_transfer"];

const ERROR_MESSAGES: Record<PaymentErrorType, string> = {
  timeout: "Error 504: Gateway Timeout — the payment server did not respond in time.",
  server_error: "Error 500: Internal Server Error. Please try again later.",
};

const EMPTY_CARD_DETAILS: DummyCardDetails = {
  cardNumber: "",
  expiryMonth: "",
  expiryYear: "",
  cvc: "",
};

/**
 * Rendered only on the client (see app/payment/PaymentViewLoader.tsx) — same
 * sessionStorage hydration-mismatch reason as app/booking/BookingView.tsx.
 */
export default function PaymentView() {
  const router = useRouter();
  const [selectedSeat] = useState(() => getSelectedSeat());
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [cardDetails, setCardDetails] = useState<DummyCardDetails>(EMPTY_CARD_DETAILS);
  const [forceFailure, setForceFailure] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalPhase, setModalPhase] = useState<PaymentModalPhase>("loading");
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<PaymentErrorType | null>(null);

  if (!selectedSeat) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
        <StepIndicator currentStage="payment" />
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

  const isCardFilled =
    cardDetails.cardNumber.trim() !== "" &&
    cardDetails.expiryMonth.trim() !== "" &&
    cardDetails.expiryYear.trim() !== "" &&
    cardDetails.cvc.trim() !== "";

  const canPay = method !== null && (method !== "card" || isCardFilled);

  function attemptPayment() {
    if (!method) return;
    setModalPhase("loading");
    setModalOpen(true);
    const { durationMs } = METHOD_META[method];
    window.setTimeout(() => {
      if (forceFailure) {
        setErrorType(Math.random() < 0.5 ? "timeout" : "server_error");
        setModalPhase("failure");
      } else {
        setBookingId(`BKG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
        setModalPhase("success");
      }
    }, durationMs);
  }

  function handleModalClose() {
    if (modalPhase === "success") {
      router.push("/result");
      return;
    }
    setModalOpen(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="payment" />

      <div className="flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div>
          <p className="text-xs text-[var(--color-mute)]">Selected seat</p>
          <p className="font-mono text-2xl font-semibold text-[var(--color-ink)]">
            {selectedSeat.row}
            {selectedSeat.number}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--color-mute)]">Hold expires in</p>
          <HoldTimer expiresAt={holdExpiresAt} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Payment method</h2>
        <div className="flex flex-col gap-2">
          {METHOD_ORDER.map((value) => {
            const meta = METHOD_META[value];
            const isSelected = method === value;
            return (
              <label
                key={value}
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-4",
                  isSelected
                    ? "border-[var(--color-brand)] bg-[var(--color-page)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)]",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="payment-method"
                  value={value}
                  checked={isSelected}
                  onChange={() => setMethod(value)}
                  className="mt-1"
                />
                <span className="flex flex-1 flex-col gap-1">
                  <span className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--color-ink)]">{meta.label}</span>
                    <span className="font-mono text-xs text-[var(--color-mute)]">{meta.speedHint}</span>
                  </span>
                  <span className="text-xs text-[var(--color-mute)]">{meta.description}</span>
                </span>
              </label>
            );
          })}
        </div>

        {method === "card" && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-mute)]">
              Card number (dummy)
              <input
                type="text"
                inputMode="numeric"
                placeholder="4242 4242 4242 4242"
                value={cardDetails.cardNumber}
                onChange={(event) =>
                  setCardDetails((prev) => ({ ...prev, cardNumber: event.target.value }))
                }
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-page)] px-3 py-2 text-sm text-[var(--color-ink)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-mute)]">
              Expiry month
              <input
                type="text"
                inputMode="numeric"
                placeholder="MM"
                value={cardDetails.expiryMonth}
                onChange={(event) =>
                  setCardDetails((prev) => ({ ...prev, expiryMonth: event.target.value }))
                }
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-page)] px-3 py-2 text-sm text-[var(--color-ink)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-mute)]">
              Expiry year
              <input
                type="text"
                inputMode="numeric"
                placeholder="YY"
                value={cardDetails.expiryYear}
                onChange={(event) =>
                  setCardDetails((prev) => ({ ...prev, expiryYear: event.target.value }))
                }
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-page)] px-3 py-2 text-sm text-[var(--color-ink)]"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--color-mute)]">
              CVC
              <input
                type="text"
                inputMode="numeric"
                placeholder="123"
                value={cardDetails.cvc}
                onChange={(event) =>
                  setCardDetails((prev) => ({ ...prev, cvc: event.target.value }))
                }
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-page)] px-3 py-2 text-sm text-[var(--color-ink)]"
              />
            </label>
          </div>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2 self-center text-xs text-[var(--color-mute)]">
        <input
          type="checkbox"
          checked={forceFailure}
          onChange={(event) => setForceFailure(event.target.checked)}
        />
        Simulate a payment failure (test)
      </label>

      <button
        type="button"
        disabled={!canPay}
        onClick={attemptPayment}
        className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        Pay now
      </button>

      <PaymentModal
        open={modalOpen}
        phase={modalPhase}
        successDetail={bookingId ?? undefined}
        errorMessage={errorType ? ERROR_MESSAGES[errorType] : undefined}
        onClose={handleModalClose}
        onRetry={attemptPayment}
      />
    </div>
  );
}
