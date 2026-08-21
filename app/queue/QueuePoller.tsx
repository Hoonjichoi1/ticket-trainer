"use client";

// Tick-on-request queue polling (F003, F004): joins the queue once on
// mount, then polls GET /api/queue every 2s (CLAUDE.md polling interval
// guidance) to reflect the server-computed position. Navigates to /seats
// with the one-time admission token the instant the poll response carries
// one — the server, not this timer, is the source of truth for admission.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiErrorResponse, QueuePollResponse } from "@/lib/types";

const POLL_INTERVAL_MS = 2000;

function formatWaitTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.max(0, Math.round(seconds % 60));
  return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
}

export function QueuePoller() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<QueuePollResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasJoinedRef = useRef(false);
  const isNavigatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/queue", { method: hasJoinedRef.current ? "GET" : "POST" });
        hasJoinedRef.current = true;

        if (cancelled) return;

        if (!res.ok) {
          const body = (await res.json()) as ApiErrorResponse;
          setErrorMessage(body.message);
          return;
        }

        const body = (await res.json()) as QueuePollResponse;
        setSnapshot(body);
        setErrorMessage(null);

        if (body.admissionToken) {
          isNavigatingRef.current = true;
          router.push(`/seats?admissionToken=${encodeURIComponent(body.admissionToken)}`);
        }
      } catch {
        if (!cancelled) setErrorMessage("Connection lost. Retrying…");
      } finally {
        if (!cancelled && !isNavigatingRef.current) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      }
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  if (errorMessage) {
    return (
      <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center text-sm text-[var(--color-mute)]">
        {errorMessage}
      </p>
    );
  }

  if (!snapshot) {
    return (
      <p className="text-center text-sm text-[var(--color-mute)]">Joining the queue…</p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
      <span className="text-sm text-[var(--color-mute)]">Your position in line</span>
      <span className="font-mono text-5xl font-semibold tabular-nums text-[var(--color-brand)]">
        {Math.ceil(snapshot.position).toLocaleString()}
      </span>
      <div className="flex gap-8 text-sm text-[var(--color-mute)]">
        <div className="flex flex-col items-center gap-1">
          <span className="font-mono text-lg text-[var(--color-ink)]">
            {snapshot.aheadCount.toLocaleString()}
          </span>
          ahead of you
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="font-mono text-lg text-[var(--color-ink)]">
            {formatWaitTime(snapshot.estimatedWaitSeconds)}
          </span>
          estimated wait
        </div>
      </div>
      {snapshot.admissionToken && (
        <span className="text-sm text-[var(--color-brand)]">Entering seat selection…</span>
      )}
    </div>
  );
}
