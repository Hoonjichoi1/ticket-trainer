// Booking-info confirmation orchestration (Task 010) — the "caller" layer
// for POST /api/booking. Sits between Task 009's hold ownership lookup
// (lib/seats.ts's getOwnedHold/expireStaleHolds) and the observability
// helpers (lib/session-result.ts). deliveryMethod/ticketCount aren't
// persisted anywhere: the Booking model only gets a row on payment
// success (lib/payment.ts), and PRD-wise this step is a UI flow gate
// (terms agreed + a still-valid hold) rather than data the report needs.
import { prisma } from "@/lib/db";
import { recordStageExited } from "@/lib/session-result";
import { getOwnedHold, expireStaleHolds } from "@/lib/seats";
import type { SubmitBookingInfoResponse } from "@/lib/types";

/**
 * Confirms the booking-info step for the session's currently held seat.
 * Sweeps expired holds first (booking/payment aren't polled the way
 * /seats is, so this sweep is the only place that notices a hold expired
 * while the user sat on this page) then requires the session to still own
 * an active hold. deliveryMethod/termsAgreed shape validation happens at
 * the route boundary (app/api/booking/route.ts), matching how
 * app/api/seats/route.ts validates seatId before calling into lib/seats.ts
 * — this function only needs to know the terms step happened at all.
 */
export async function confirmBookingInfo(params: {
  sessionId: string;
  runId: string;
  now: Date;
}): Promise<SubmitBookingInfoResponse> {
  const { sessionId, runId, now } = params;

  await expireStaleHolds({ runId, now });
  const hold = await getOwnedHold({ sessionId, runId });
  if (!hold) {
    return { status: "hold_expired" };
  }

  await recordStageExited(prisma, sessionId, "booking_info", now);

  return { status: "ok", holdExpiresAt: hold.expiresAt.toISOString() };
}
