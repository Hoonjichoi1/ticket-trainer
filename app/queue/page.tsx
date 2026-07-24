import Link from "next/link";
import { getDummyQueuePosition } from "@/lib/dummy-data";
import { StepIndicator } from "@/app/components/StepIndicator";
import { WarningBanner } from "@/app/components/WarningBanner";

function formatWaitTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
}

export default function QueuePage() {
  const queue = getDummyQueuePosition();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="queue" />

      <WarningBanner message="Refreshing this page resets your queue position." />

      <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <span className="text-sm text-[var(--color-mute)]">Your position in line</span>
        <span className="font-mono text-5xl font-semibold tabular-nums text-[var(--color-brand)]">
          {queue.position.toLocaleString()}
        </span>
        <div className="flex gap-8 text-sm text-[var(--color-mute)]">
          <div className="flex flex-col items-center gap-1">
            <span className="font-mono text-lg text-[var(--color-ink)]">
              {queue.aheadCount.toLocaleString()}
            </span>
            ahead of you
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="font-mono text-lg text-[var(--color-ink)]">
              {formatWaitTime(queue.estimatedWaitSeconds)}
            </span>
            estimated wait
          </div>
        </div>
      </div>

      <Link
        href="/seats"
        className="self-center rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white"
      >
        Continue to Seat Selection
      </Link>
    </div>
  );
}
