"use client";

import { useEffect, useRef, useState } from "react";

export interface HoldTimerProps {
  expiresAt: Date;
  /** ms remaining below which the digits switch to the danger color; default 60_000 (1 minute). */
  warningThresholdMs?: number;
  onExpire?: () => void;
  className?: string;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * This setInterval exists ONLY to trigger a re-render so the displayed
 * remaining hold time stays fresh. It does NOT own simulation state: the
 * server enforces the real 5-minute hold expiry (lib/simulation.ts,
 * Phase 3) independently of this tab. If this component drifts or the
 * tab is backgrounded, the next request to the server is what actually
 * decides whether the hold is still valid — this component only
 * reflects expiresAt, it never releases a hold on its own.
 */
export function HoldTimer({
  expiresAt,
  warningThresholdMs = 60_000,
  onExpire,
  className,
}: HoldTimerProps) {
  const [remainingMs, setRemainingMs] = useState(
    () => expiresAt.getTime() - Date.now(),
  );
  const hasFiredExpire = useRef(false);

  useEffect(() => {
    const tick = () => setRemainingMs(expiresAt.getTime() - Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  useEffect(() => {
    if (remainingMs <= 0 && !hasFiredExpire.current) {
      hasFiredExpire.current = true;
      onExpire?.();
    }
  }, [remainingMs, onExpire]);

  const isUrgent = remainingMs > 0 && remainingMs <= warningThresholdMs;

  return (
    <span
      className={[
        "font-mono text-2xl tabular-nums",
        isUrgent ? "text-[var(--color-danger)]" : "text-[var(--color-ink)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {formatRemaining(remainingMs)}
    </span>
  );
}
