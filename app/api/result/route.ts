import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { aggregateSessionResult } from "@/lib/result";
import type { ApiErrorResponse, SessionResultResponse } from "@/lib/types";

// Result-report read (F011). Deliberately does not gate on getActiveRun
// (unlike app/api/booking|payment/route.ts) — aggregateSessionResult must
// still be reachable after the session's run has already transitioned to
// COMPLETED on a prior visit, which getActiveRun's ACTIVE-only filter
// would hide.
export async function GET() {
  const session = await requireSession();
  if ("error" in session) {
    return NextResponse.json<ApiErrorResponse>(session.error, { status: 401 });
  }

  const result = await aggregateSessionResult({ sessionId: session.sessionId, now: new Date() });
  if (!result) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "NO_RESULT", message: "No session result found for this session." },
      { status: 404 },
    );
  }

  return NextResponse.json<SessionResultResponse>(result);
}
