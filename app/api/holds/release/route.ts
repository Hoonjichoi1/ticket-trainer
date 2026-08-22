import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getActiveRun } from "@/lib/queue";
import { releaseHold } from "@/lib/seats";
import type { ApiErrorResponse } from "@/lib/types";

/**
 * Explicit hold release (Task 010, F010 + CLAUDE.md's page-unload
 * best-effort release note): the target of
 * `navigator.sendBeacon("/api/holds/release")` fired from
 * app/booking/BookingView.tsx / app/payment/PaymentView.tsx on
 * `pagehide`. sendBeacon can't attach custom headers, but it's a
 * same-origin request so the session cookie still rides along, and
 * requireSession() works unmodified. Always resolves to 204 (nothing for
 * a fire-and-forget beacon to do with a JSON error body) except when
 * there's no session at all — kept as 401 for consistency with the
 * other guarded routes and so this stays independently testable.
 * No-active-run / no-active-hold are both harmless no-ops, not errors:
 * there may simply be nothing left to release (payment already
 * succeeded, hold already expired, etc.) — idempotent against duplicate
 * unload events or a retried beacon.
 */
export async function POST() {
  const session = await requireSession();
  if ("error" in session) {
    return NextResponse.json<ApiErrorResponse>(session.error, { status: 401 });
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    return new NextResponse(null, { status: 204 });
  }

  await releaseHold({ sessionId: session.sessionId, runId: run.id, now: new Date() });
  return new NextResponse(null, { status: 204 });
}
