"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/booking/page.tsx can stay a
// plain Server Component. BookingView reads sessionStorage, which is
// always empty during SSR, so rendering it server-side would
// hydration-mismatch against the client's real value (see
// app/seats/SeatsViewLoader.tsx for the same pattern).
const BookingView = dynamic(() => import("./BookingView"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="booking" />
      <p className="text-center text-sm text-[var(--color-mute)]">Loading…</p>
    </div>
  ),
});

export default function BookingViewLoader() {
  return <BookingView />;
}
