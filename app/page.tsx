"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Tier } from "@/lib/types";
import { getDummyConcert, TIER_LABELS } from "@/lib/dummy-data";
import { CountdownTimer } from "@/app/components/CountdownTimer";
import { StepIndicator } from "@/app/components/StepIndicator";

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  [Tier.SMALL]: "Beginner friendly — light queue, weak bots, plenty of open seats.",
  [Tier.MEDIUM]: "Moderate contention — realistic queue pressure and occasional payment errors.",
  [Tier.MEGA]: "Hardest mode — massive queue, aggressive bots, frequent payment failures.",
};

const TIERS = [Tier.SMALL, Tier.MEDIUM, Tier.MEGA] as const;

export default function HomePage() {
  const router = useRouter();
  const [concert] = useState(() => getDummyConcert());
  const openAt = new Date(concert.openAt);
  const [isOpen, setIsOpen] = useState(() => openAt.getTime() <= Date.now());
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const canBook = isOpen && selectedTier !== null && !isStarting;

  async function handleBook() {
    if (!canBook || !selectedTier) return;
    setIsStarting(true);
    try {
      // Starts (or restarts) this session's SimulationRun and records the
      // chosen tier on it (D-2) — the queue-join API reads the tier from
      // there, so no ?tier= query param needs to travel with the navigation.
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: selectedTier }),
      });
      if (!res.ok) return;
      router.push("/queue");
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="home" />

      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-semibold text-[var(--color-ink)]">
          {concert.title}
        </h1>
        <p className="text-[var(--color-mute)]">{concert.venue}</p>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <span className="text-sm text-[var(--color-mute)]">
          {isOpen ? "Sale is open" : "Sale opens in"}
        </span>
        <CountdownTimer targetDate={openAt} onComplete={() => setIsOpen(true)} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">
          Choose your fandom tier
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {TIERS.map((tier) => {
            const isSelected = selectedTier === tier;
            return (
              <button
                key={tier}
                type="button"
                onClick={() => setSelectedTier(tier)}
                aria-pressed={isSelected}
                className={[
                  "flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors",
                  isSelected
                    ? "border-[var(--color-brand)] bg-[var(--color-page)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand)]",
                ].join(" ")}
              >
                <span className="font-[family-name:var(--font-space-grotesk)] text-lg font-semibold text-[var(--color-ink)]">
                  {TIER_LABELS[tier]}
                </span>
                <span className="text-xs text-[var(--color-mute)]">
                  {TIER_DESCRIPTIONS[tier]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleBook()}
        disabled={!canBook}
        className="rounded-full bg-[var(--color-brand)] px-6 py-3 font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isStarting ? "Starting…" : "Book Now"}
      </button>
    </div>
  );
}
