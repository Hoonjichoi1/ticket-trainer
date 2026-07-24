"use client";

import { useEffect, useRef, useState } from "react";

export interface CountdownTimerProps {
  targetDate: Date;
  onComplete?: () => void;
  className?: string;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * This setInterval exists ONLY to trigger a re-render so the displayed
 * remaining time stays fresh. It does NOT own simulation state: the
 * server-side tick engine (lib/simulation.ts, Phase 3) is the source of
 * truth for the real sale-open time. If this tab is backgrounded or this
 * interval drifts, the server independently enforces the real cutoff on
 * the next request — this component never decides "it's open now" on
 * its own, it only reflects targetDate.
 */
export function CountdownTimer({
  targetDate,
  onComplete,
  className,
}: CountdownTimerProps) {
  const [remainingMs, setRemainingMs] = useState(
    () => targetDate.getTime() - Date.now(),
  );
  const hasFiredComplete = useRef(false);

  useEffect(() => {
    const tick = () => setRemainingMs(targetDate.getTime() - Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [targetDate]);

  useEffect(() => {
    if (remainingMs <= 0 && !hasFiredComplete.current) {
      hasFiredComplete.current = true;
      onComplete?.();
    }
  }, [remainingMs, onComplete]);

  return (
    <span
      className={[
        "font-mono text-2xl tabular-nums text-[var(--color-ink)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {formatRemaining(remainingMs)}
    </span>
  );
}
