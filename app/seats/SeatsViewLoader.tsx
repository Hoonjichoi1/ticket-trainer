"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/seats/page.tsx can stay a
// plain Server Component.
const SeatsView = dynamic(() => import("./SeatsView"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="seats" />
      <p className="text-center text-sm text-[var(--color-mute)]">
        Loading seat map…
      </p>
    </div>
  ),
});

interface SeatsViewLoaderProps {
  zoneCount: number;
}

export default function SeatsViewLoader({ zoneCount }: SeatsViewLoaderProps) {
  return <SeatsView zoneCount={zoneCount} />;
}
