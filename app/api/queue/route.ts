import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getActiveRun, joinQueue, pollQueue } from "@/lib/queue";
import type { ApiErrorResponse, QueuePollResponse } from "@/lib/types";

const NO_ACTIVE_RUN_ERROR: ApiErrorResponse = {
  status: "error",
  code: "NO_ACTIVE_RUN",
  message: "No active simulation run for this session. Call POST /api/session first.",
};

// Joins (or rejoins) the queue for the session's active SimulationRun
// (F002 server-side openAt check, F003).
export async function POST() {
  const session = await requireSession();
  if ("error" in session) {
    return NextResponse.json<ApiErrorResponse>(session.error, { status: 401 });
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    return NextResponse.json<ApiErrorResponse>(NO_ACTIVE_RUN_ERROR, { status: 404 });
  }

  const result = await joinQueue({ sessionId: session.sessionId, runId: run.id, now: new Date() });
  if (!result.ok) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: result.code, message: "Ticket sale has not opened yet." },
      { status: 403 },
    );
  }

  return NextResponse.json<QueuePollResponse>(result.snapshot);
}

// Tick-on-request poll (F003, F004): advances the session's queue position
// by elapsed time and, on reaching 0, issues the one-time admission token.
export async function GET() {
  const session = await requireSession();
  if ("error" in session) {
    return NextResponse.json<ApiErrorResponse>(session.error, { status: 401 });
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    return NextResponse.json<ApiErrorResponse>(NO_ACTIVE_RUN_ERROR, { status: 404 });
  }

  const result = await pollQueue({ sessionId: session.sessionId, runId: run.id, now: new Date() });
  if (!result.ok) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: result.code, message: "Not currently in the queue. Call POST /api/queue first." },
      { status: 404 },
    );
  }

  return NextResponse.json<QueuePollResponse>(result.snapshot);
}
