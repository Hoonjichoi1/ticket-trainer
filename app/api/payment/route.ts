import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getActiveRun } from "@/lib/queue";
import { attemptPayment } from "@/lib/payment";
import type { ApiErrorResponse, PaymentMethod, SubmitPaymentRequest, SubmitPaymentResponse } from "@/lib/types";

const NO_ACTIVE_RUN_ERROR: ApiErrorResponse = {
  status: "error",
  code: "NO_ACTIVE_RUN",
  message: "No active simulation run for this session. Call POST /api/session first.",
};

const PAYMENT_METHODS: readonly PaymentMethod[] = ["easy_pay", "card", "bank_transfer"];

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

// Payment attempt (F014, F009 tier-based error injection, F010 branching):
// validates request shape here, then delegates hold ownership, error
// injection, and the sale transaction to lib/payment.ts.
export async function POST(request: Request) {
  const guard = await requireActiveRun();
  if ("error" in guard) return guard.error;
  const { sessionId, runId } = guard;

  let body: Partial<SubmitPaymentRequest>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_BODY", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (typeof body.method !== "string" || !PAYMENT_METHODS.includes(body.method)) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_METHOD", message: "method must be one of easy_pay, card, bank_transfer." },
      { status: 400 },
    );
  }

  const result = await attemptPayment({ sessionId, runId, now: new Date() });
  return NextResponse.json<SubmitPaymentResponse>(result);
}
