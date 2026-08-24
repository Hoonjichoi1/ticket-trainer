"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";
import type { HomeViewProps } from "./HomeView";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/page.tsx can stay a Server
// Component that does the real Concert lookup (D-11). Same split as
// app/booking/BookingViewLoader.tsx.
const HomeView = dynamic(() => import("./HomeView"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="home" />
      <p className="text-center text-sm text-[var(--color-mute)]">Loading…</p>
    </div>
  ),
});

export default function HomeViewLoader(props: HomeViewProps) {
  return <HomeView {...props} />;
}
