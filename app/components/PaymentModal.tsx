"use client";

import { useEffect } from "react";

export type PaymentModalPhase = "loading" | "success" | "failure";

export interface PaymentModalProps {
  open: boolean;
  phase: PaymentModalPhase;
  /** shown when phase === "success", e.g. a dummy booking id. */
  successDetail?: string;
  /** shown when phase === "failure"; caller decides the exact wording. */
  errorMessage?: string;
  onClose: () => void;
  /** omit to hide the retry action even during "failure". */
  onRetry?: () => void;
}

/**
 * Fully controlled state-transition shell — no internal timer. The real
 * loading -> resolved transition is driven by the caller (a real
 * fetch() call in Task 010, or a setTimeout in Task 005's dummy page);
 * this component only knows how to render each of the 3 phases and wire
 * the close/retry actions.
 */
export function PaymentModal({
  open,
  phase,
  successDetail,
  errorMessage,
  onClose,
  onRetry,
}: PaymentModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Payment"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl bg-[var(--color-surface-raised)] p-6 shadow-xl">
        {phase === "loading" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <span
              aria-hidden
              className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)] motion-reduce:animate-none"
            />
            <p className="text-sm text-[var(--color-mute)]">
              Processing payment…
            </p>
          </div>
        )}

        {phase === "success" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-success)] text-lg text-white"
            >
              ✓
            </span>
            <div>
              <p className="font-display text-lg font-semibold text-[var(--color-ink)]">
                Payment complete
              </p>
              {successDetail && (
                <p className="mt-1 font-mono text-sm text-[var(--color-mute)]">
                  {successDetail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-full bg-[var(--color-brand)] px-6 py-2 text-sm font-medium text-white"
            >
              Done
            </button>
          </div>
        )}

        {phase === "failure" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-danger)] text-lg text-white"
            >
              ✕
            </span>
            <div>
              <p className="font-display text-lg font-semibold text-[var(--color-ink)]">
                Payment failed
              </p>
              {errorMessage && (
                <p className="mt-1 text-sm text-[var(--color-mute)]">
                  {errorMessage}
                </p>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-[var(--color-border)] px-5 py-2 text-sm font-medium text-[var(--color-ink)]"
              >
                Close
              </button>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-full bg-[var(--color-brand)] px-5 py-2 text-sm font-medium text-white"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
