import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getActiveRun } from "@/lib/queue";
import { confirmBookingInfo } from "@/lib/booking";
import type { ApiErrorResponse, DeliveryMethod, SubmitBookingInfoRequest, SubmitBookingInfoResponse } from "@/lib/types";

const NO_ACTIVE_RUN_ERROR: ApiErrorResponse = {
  status: "error",
  code: "NO_ACTIVE_RUN",
  message: "No active simulation run for this session. Call POST /api/session first.",
};

const DELIVERY_METHODS: readonly DeliveryMethod[] = ["mobile", "onsite"];

/** Shared guard: session -> active run. No admission check needed here — owning a hold already implies the session got past /seats. */
async function requireActiveRun(): Promise<{ sessionId: string; runId: string } | { error: NextResponse }> {
  const session = await requireSession();
  if ("error" in session) {
    return { error: NextResponse.json<ApiErrorResponse>(session.error, { status: 401 }) };
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    return { error: NextResponse.json<ApiErrorResponse>(NO_ACTIVE_RUN_ERROR, { status: 404 }) };
  }

  return { sessionId: session.sessionId, runId: run.id };
}

// Booking-info confirmation (F013): validates request shape here (mirrors
// app/api/seats/route.ts validating seatId before calling into lib), then
// delegates hold-ownership/expiry checks to lib/booking.ts.
export async function POST(request: Request) {
  const guard = await requireActiveRun();
  if ("error" in guard) return guard.error;
  const { sessionId, runId } = guard;

  let body: Partial<SubmitBookingInfoRequest>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_BODY", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (typeof body.deliveryMethod !== "string" || !DELIVERY_METHODS.includes(body.deliveryMethod)) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_DELIVERY_METHOD", message: 'deliveryMethod must be "mobile" or "onsite".' },
      { status: 400 },
    );
  }

  if (body.termsAgreed !== true) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "TERMS_NOT_AGREED", message: "termsAgreed must be true." },
      { status: 400 },
    );
  }

  const result = await confirmBookingInfo({ sessionId, runId, now: new Date() });
  return NextResponse.json<SubmitBookingInfoResponse>(result);
}
