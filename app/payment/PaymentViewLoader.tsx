"use client";

import dynamic from "next/dynamic";
import { StepIndicator } from "@/app/components/StepIndicator";
import type { PaymentViewProps } from "./PaymentView";

// `ssr: false` is only allowed inside a Client Component (per
// node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md) — this
// file exists solely to host that call so app/payment/page.tsx can stay a
// Server Component that does the real hold-ownership guard (Task 010).
// See app/booking/BookingViewLoader.tsx for the same pattern: seat/
// holdExpiresAt now arrive as server-confirmed props, not sessionStorage.
const PaymentView = dynamic(() => import("./PaymentView"), {
  ssr: false,
  loading: () => (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-8">
      <StepIndicator currentStage="payment" />
      <p className="text-center text-sm text-[var(--color-mute)]">Loading…</p>
    </div>
  ),
});

export default function PaymentViewLoader(props: PaymentViewProps) {
  return <PaymentView {...props} />;
}
