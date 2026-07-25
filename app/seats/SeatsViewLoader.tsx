"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/seats/page.tsx can stay a
// plain Server Component. SeatsView owns Math.random()-based dummy data
// that must never be computed during SSR (see SeatsView.tsx's top
// comment) or it hydration-mismatches on the "N/40 open" zone counts.
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

export default function SeatsViewLoader() {
  return <SeatsView />;
}
