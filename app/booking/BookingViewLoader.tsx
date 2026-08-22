"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";
import type { BookingViewProps } from "./BookingView";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/booking/page.tsx can stay a
// Server Component that does the real hold-ownership guard (Task 010).
// BookingView itself no longer reads sessionStorage; app/booking/page.tsx
// passes the server-confirmed seat/holdExpiresAt down as props, so there's
// still a client/server boundary here but no hydration-mismatch risk to
// route around (contrast app/seats/SeatsViewLoader.tsx, which does have
// one since SeatsView owns its own client-only polling state).
const BookingView = dynamic(() => import("./BookingView"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="booking" />
      <p className="text-center text-sm text-[var(--color-mute)]">Loading…</p>
    </div>
  ),
});

export default function BookingViewLoader(props: BookingViewProps) {
  return <BookingView {...props} />;
}
