import { Fragment } from "react";

// Deliberately its own type, not lib/types.ts's SimulationStage: that
// type tracks 4 server-timing stages (queue/seat_selection/booking_info/
// payment); this tracks 6 nav positions (adds home/result, uses
// route-slug names matching the app/ folder structure). Pages will often
// need both types side by side — keeping the names visibly distinct
// avoids conflating "where the user is in the UI" with "what the server
// is timing".
export type StepIndicatorStage =
  | "home"
  | "queue"
  | "seats"
  | "booking"
  | "payment"
  | "result";

export interface StepIndicatorProps {
  currentStage: StepIndicatorStage;
  className?: string;
}

const STEPS: Array<{ stage: StepIndicatorStage; label: string }> = [
  { stage: "home", label: "Home" },
  { stage: "queue", label: "Queue" },
  { stage: "seats", label: "Seats" },
  { stage: "booking", label: "Booking" },
  { stage: "payment", label: "Payment" },
  { stage: "result", label: "Result" },
];

export function StepIndicator({ currentStage, className }: StepIndicatorProps) {
  const currentIndex = STEPS.findIndex((step) => step.stage === currentStage);

  return (
    <ol
      className={["flex w-full items-start", className].filter(Boolean).join(" ")}
    >
      {STEPS.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = index === currentIndex;

        return (
          <Fragment key={step.stage}>
            {index > 0 && (
              <li aria-hidden className="mt-4 flex-1 self-start">
                <div
                  className={`h-px w-full ${
                    index <= currentIndex
                      ? "bg-[var(--color-brand)]"
                      : "bg-[var(--color-border)]"
                  }`}
                />
              </li>
            )}
            <li className="flex flex-col items-center gap-2">
              <span
                className={[
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 font-mono text-sm font-medium",
                  isCompleted
                    ? "border-[var(--color-brand)] bg-[var(--color-brand)] text-white"
                    : isCurrent
                      ? "border-[var(--color-brand)] bg-[var(--color-surface)] text-[var(--color-brand)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-mute)]",
                ].join(" ")}
              >
                {index + 1}
              </span>
              <span
                className={`whitespace-nowrap text-xs ${
                  isCurrent
                    ? "font-semibold text-[var(--color-ink)]"
                    : "text-[var(--color-mute)]"
                }`}
              >
                {step.label}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
