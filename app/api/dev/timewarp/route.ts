import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { applyTimewarp } from "@/lib/dev-timewarp";
import type { ApiErrorResponse, TimewarpRequest, TimewarpResponse } from "@/lib/types";

// Dev/test-only utility (ROADMAP D-7): lets a developer skip past
// tick-on-request wait states (open-time countdown, queue-position
// countdown) during manual browser verification, by rewinding the
// stored timestamp anchors lib/simulation.ts's pure math reads from —
// never the tick math itself (see lib/dev-timewarp.ts). Next.js bundles
// this route file into the production build regardless of NODE_ENV (no
// build-time exclusion mechanism exists for Route Handlers), so
// production-safety is enforced at runtime: this always 404s when
// NODE_ENV === "production", satisfying ROADMAP D-7's "route doesn't
// exist or always 404" requirement.
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "NOT_FOUND", message: "Not found." },
      { status: 404 },
    );
  }

  const session = await requireSession();
  if ("error" in session) {
    return NextResponse.json<ApiErrorResponse>(session.error, { status: 401 });
  }

  let body: TimewarpRequest;
  try {
    body = (await request.json()) as TimewarpRequest;
  } catch {
    body = {};
  }
  const { openInMs, queueRewindMs, queueConsumedPct, lastTickRewindMs } = body;

  const numericFields = { openInMs, queueRewindMs, queueConsumedPct, lastTickRewindMs };
  for (const [key, value] of Object.entries(numericFields)) {
    if (value !== undefined && typeof value !== "number") {
      return NextResponse.json<ApiErrorResponse>(
        { status: "error", code: "INVALID_BODY", message: `${key} must be a number.` },
        { status: 400 },
      );
    }
  }

  if (queueRewindMs !== undefined && queueConsumedPct !== undefined) {
    return NextResponse.json<ApiErrorResponse>(
      {
        status: "error",
        code: "AMBIGUOUS_QUEUE_PARAMS",
        message: "Provide either queueRewindMs or queueConsumedPct, not both.",
      },
      { status: 400 },
    );
  }

  const result = await applyTimewarp({
    sessionId: session.sessionId,
    openInMs,
    queueRewindMs,
    queueConsumedPct,
    lastTickRewindMs,
    now: new Date(),
  });

  if (!result.ok) {
    if (result.code === "NO_ACTIVE_RUN") {
      return NextResponse.json<ApiErrorResponse>(
        {
          status: "error",
          code: "NO_ACTIVE_RUN",
          message: "No active simulation run for this session. Call POST /api/session first.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: result.code, message: result.message },
      { status: 400 },
    );
  }

  return NextResponse.json<TimewarpResponse>({ status: "ok", ...result.result });
}
