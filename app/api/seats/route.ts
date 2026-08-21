import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getActiveRun, requireAdmission } from "@/lib/queue";
import { claimSeat, listSeatMap, runSeatMapTick, seatBelongsToRun } from "@/lib/seats";
import { recordStageEntered, recordStageExited, recordJudgmentEvent, incrementContentionLosses } from "@/lib/session-result";
import type { ApiErrorResponse, SeatClaimRequest, SeatClaimResponse, SeatMapResponse } from "@/lib/types";

const NO_ACTIVE_RUN_ERROR: ApiErrorResponse = {
  status: "error",
  code: "NO_ACTIVE_RUN",
  message: "No active simulation run for this session. Call POST /api/session first.",
};

const NOT_ADMITTED_ERROR: ApiErrorResponse = {
  status: "error",
  code: "NOT_ADMITTED",
  message: "Not yet admitted past the queue for this run. Call GET /api/queue until admitted.",
};

/**
 * Shared guard for both handlers: session -> active run -> admission
 * (Task 008's requireAdmission, re-checked here as defense-in-depth on
 * top of app/seats/page.tsx's SSR redirect, since a direct API call would
 * otherwise bypass the page-level gate entirely).
 */
async function requireAdmittedRun(): Promise<
  { sessionId: string; runId: string } | { error: NextResponse }
> {
  const session = await requireSession();
  if ("error" in session) {
    return { error: NextResponse.json<ApiErrorResponse>(session.error, { status: 401 }) };
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    return { error: NextResponse.json<ApiErrorResponse>(NO_ACTIVE_RUN_ERROR, { status: 404 }) };
  }

  const admitted = await requireAdmission({ sessionId: session.sessionId, runId: run.id });
  if (!admitted) {
    return { error: NextResponse.json<ApiErrorResponse>(NOT_ADMITTED_ERROR, { status: 403 }) };
  }

  return { sessionId: session.sessionId, runId: run.id };
}

// Full seat map (F005), tick-on-request (F007 expiry, F008 bot claims) run
// once per poll before reading the map back out.
export async function GET() {
  const guard = await requireAdmittedRun();
  if ("error" in guard) return guard.error;
  const { sessionId, runId } = guard;

  await runSeatMapTick({ runId, now: new Date() });
  await recordStageEntered(prisma, sessionId, "seat_selection", new Date());

  const seats = await listSeatMap({ runId });
  return NextResponse.json<SeatMapResponse>({ seats });
}

// Atomic seat claim (F006, CLAUDE.md critical): conditional UPDATE + Hold
// insert via lib/seats.ts's claimSeat, shared verbatim with the bot's own
// claims in runSeatMapTick.
export async function POST(request: Request) {
  const guard = await requireAdmittedRun();
  if ("error" in guard) return guard.error;
  const { sessionId, runId } = guard;

  let body: Partial<SeatClaimRequest>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_BODY", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (typeof body?.seatId !== "string" || body.seatId.length === 0) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_SEAT_ID", message: "seatId is required." },
      { status: 400 },
    );
  }
  const { seatId } = body;

  // A seatId from a different session's independent run (D-1) must never
  // be claimable here, even though claimSeat() itself doesn't scope by
  // run — that scoping happens at this boundary instead.
  if (!(await seatBelongsToRun({ seatId, runId }))) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "SEAT_NOT_FOUND", message: "No such seat for this session's run." },
      { status: 404 },
    );
  }

  const now = new Date();
  const result = await claimSeat({ seatId, sessionId, now });

  if (result.status === "held") {
    await recordJudgmentEvent(prisma, sessionId, {
      type: "seat_claim_success",
      stage: "seat_selection",
      seatId,
      timestamp: now.toISOString(),
    });
    await recordStageExited(prisma, sessionId, "seat_selection", now);
  } else {
    await recordJudgmentEvent(prisma, sessionId, {
      type: "contention_loss",
      stage: "seat_selection",
      seatId,
      timestamp: now.toISOString(),
    });
    await incrementContentionLosses(prisma, sessionId);
  }

  return NextResponse.json<SeatClaimResponse>(result);
}
