import { getDummySessionResult } from "@/lib/dummy-data";
import { SessionOutcome } from "@/lib/types";
import type { FeedbackItem, SimulationStage, StageTimings } from "@/lib/types";
import { StepIndicator } from "@/app/components/StepIndicator";
import { TryAgainButton } from "./TryAgainButton";

const STAGE_ORDER: SimulationStage[] = [
  "queue",
  "seat_selection",
  "booking_info",
  "payment",
];

const STAGE_LABELS: Record<SimulationStage, string> = {
  queue: "Queue",
  seat_selection: "Seat Selection",
  booking_info: "Booking Info",
  payment: "Payment",
};

const OUTCOME_META: Record<
  SessionOutcome,
  { label: string; headline: string; description: string; isSuccess: boolean }
> = {
  [SessionOutcome.SUCCESS]: {
    label: "Success",
    headline: "Booking confirmed",
    description: "You made it through the full flow and secured your seat.",
    isSuccess: true,
  },
  [SessionOutcome.QUEUE_TIMEOUT]: {
    label: "Queue timeout",
    headline: "You lost your place in queue",
    description:
      "A refresh or a long absence reset your queue position before you reached the front.",
    isSuccess: false,
  },
  [SessionOutcome.SEAT_LOST]: {
    label: "Seat lost",
    headline: "Your held seat was released",
    description:
      "The 5-minute hold expired before you finished booking, and the seat went back on sale.",
    isSuccess: false,
  },
  [SessionOutcome.PAYMENT_FAILED]: {
    label: "Payment failed",
    headline: "Payment didn't go through",
    description:
      "A refresh or navigation away during a payment error released your hold instead of retrying it.",
    isSuccess: false,
  },
  [SessionOutcome.ABANDONED]: {
    label: "Abandoned",
    headline: "Session abandoned",
    description: "You left the flow before completing the booking.",
    isSuccess: false,
  },
};

const FAILURE_FEEDBACK: Record<
  Exclude<SessionOutcome, typeof SessionOutcome.SUCCESS>,
  FeedbackItem[]
> = {
  [SessionOutcome.QUEUE_TIMEOUT]: [
    {
      eventType: "queue_reset",
      message:
        "Refreshing the queue page resets your position — closing the tab or reloading mid-wait cost you your spot in this run.",
    },
  ],
  [SessionOutcome.SEAT_LOST]: [
    {
      eventType: "hold_expired",
      message:
        "Your 5-minute hold ran out before you finished booking info and payment. Move faster through those steps once a seat is held.",
    },
  ],
  [SessionOutcome.PAYMENT_FAILED]: [
    {
      eventType: "payment_abandoned",
      message:
        "After the payment error, refreshing or navigating away released your hold instead of retrying inside the payment modal.",
    },
  ],
  [SessionOutcome.ABANDONED]: [
    {
      eventType: "payment_abandoned",
      message:
        "You left before finishing the flow. Next time, decide explicitly whether to retry or walk away rather than letting the hold expire passively.",
    },
  ],
};

function isSessionOutcome(value: string | undefined): value is SessionOutcome {
  return (
    typeof value === "string" &&
    (Object.values(SessionOutcome) as string[]).includes(value)
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function totalDurationMs(stageTimings: StageTimings): number {
  return STAGE_ORDER.reduce(
    (sum, stage) => sum + (stageTimings[stage]?.durationMs ?? 0),
    0,
  );
}

interface ResultPageProps {
  searchParams: Promise<{ outcome?: string }>;
}

/**
 * Fully server-rendered — the session result is dummy fixture data (Task
 * 005-1's sessionStorage state only covers the selected seat, not a full
 * result), so there's no client-only read that would hydration-mismatch.
 * `?outcome=` lets Task 005-8's E2E flow reach both a success and a
 * failure report without a real backend deciding the outcome yet.
 */
export default async function ResultPage({ searchParams }: ResultPageProps) {
  const { outcome: outcomeParam } = await searchParams;
  const outcome = isSessionOutcome(outcomeParam) ? outcomeParam : SessionOutcome.SUCCESS;

  const result = getDummySessionResult(
    outcome === SessionOutcome.SUCCESS
      ? {}
      : { outcome, feedback: FAILURE_FEEDBACK[outcome] },
  );
  const meta = OUTCOME_META[outcome];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="result" />

      <div
        className={[
          "flex flex-col items-center gap-3 rounded-2xl border p-8 text-center",
          meta.isSuccess
            ? "border-[var(--color-success)] bg-[var(--color-surface)]"
            : "border-[var(--color-danger)] bg-[var(--color-surface)]",
        ].join(" ")}
      >
        <span
          aria-hidden
          className={[
            "flex h-12 w-12 items-center justify-center rounded-full text-xl text-white",
            meta.isSuccess ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]",
          ].join(" ")}
        >
          {meta.isSuccess ? "✓" : "✕"}
        </span>
        <div>
          <p className="font-display text-2xl font-semibold text-[var(--color-ink)]">
            {meta.headline}
          </p>
          <p className="mt-1 text-sm text-[var(--color-mute)]">{meta.description}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
          <p className="text-xs text-[var(--color-mute)]">Total time</p>
          <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)]">
            {formatDuration(totalDurationMs(result.stageTimings))}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
          <p className="text-xs text-[var(--color-mute)]">Contention losses</p>
          <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)]">
            {result.contentionLosses}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Stage timeline</h2>
        <ol className="flex flex-col gap-2">
          {STAGE_ORDER.map((stage) => {
            const timing = result.stageTimings[stage];
            if (!timing) return null;
            return (
              <li
                key={stage}
                className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
              >
                <span className="text-sm text-[var(--color-ink)]">{STAGE_LABELS[stage]}</span>
                <span className="font-mono text-sm text-[var(--color-mute)]">
                  {timing.durationMs !== undefined ? formatDuration(timing.durationMs) : "—"}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {result.feedback.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Feedback</h2>
          <ul className="flex flex-col gap-2">
            {result.feedback.map((item, index) => (
              <li
                key={`${item.eventType}-${index}`}
                className="rounded-xl border-l-4 border-l-[var(--color-brand)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink)]"
              >
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <TryAgainButton />
    </div>
  );
}
