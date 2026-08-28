import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getOrCreateSessionId } from "@/lib/session";
import { resetSessionResult } from "@/lib/session-result";
import { resolveQueueOpenAt } from "@/lib/simulation";
import {
  SimulationRunStatus,
  Tier,
  type ApiErrorResponse,
  type StartSimulationRequest,
  type StartSimulationResponse,
} from "@/lib/types";

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (Object.values(Tier) as string[]).includes(value);
}

// Starts (or restarts) a session's simulation: issues/reuses the
// anonymous session cookie (F012), ends that session's previous ACTIVE
// run if any (D-1 "다시 도전" reset), then creates a fresh SimulationRun
// with its own seat map sized per the tier's SimulationConfig (F001
// backend, D-2: tier arrives as a request param here, not stored on the
// session cookie itself; D-15: seat count/rows are tier-parameterized,
// no longer a fixed 200).
export async function POST(request: NextRequest) {
  let body: Partial<StartSimulationRequest>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_BODY", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (!isTier(body?.tier)) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "INVALID_TIER", message: "tier is required and must be SMALL, MEDIUM, or MEGA." },
      { status: 400 },
    );
  }

  const concert = body.concertId
    ? await prisma.concert.findUnique({ where: { id: body.concertId } })
    : await prisma.concert.findFirst();

  if (!concert) {
    return NextResponse.json<ApiErrorResponse>(
      { status: "error", code: "CONCERT_NOT_FOUND", message: "No concert available to start a simulation for." },
      { status: 404 },
    );
  }

  // Cookie must be issued/read before the transaction: getOrCreateSessionId()
  // calls cookies().set(), which Next.js only allows in a Route Handler /
  // Server Function — not inside an arbitrary async callback.
  const { sessionId } = await getOrCreateSessionId();

  // D-14: snapshot this run's own open-time reference once, here, rather
  // than letting lib/queue.ts re-derive it on every request — same reason
  // D-4 fixes QueueEntry.position at join time and only ever decays it
  // afterward, never recomputes it.
  const now = new Date();
  const queueOpenAt = resolveQueueOpenAt(concert.openAt, now);

  const run = await prisma.$transaction(async (tx) => {
    // Superseded, not "completed" — the user didn't finish this run via
    // the real flow, a new one just replaced it (retry or duplicate
    // start). EXPIRED reads closer to that than SimulationRunStatus.COMPLETED,
    // which Task 011 should reserve for runs that reached a real outcome.
    await tx.simulationRun.updateMany({
      where: { sessionId, status: SimulationRunStatus.ACTIVE },
      data: { status: SimulationRunStatus.EXPIRED },
    });

    // ROADMAP D-8: SessionResult is keyed by sessionId, not runId — reset
    // it here so the previous attempt's stageTimings/events/outcome don't
    // bleed into this new run's report (Task 011 is the first reader/
    // writer of outcome; a no-op if this session has no row yet).
    await resetSessionResult(tx, sessionId);

    const newRun = await tx.simulationRun.create({
      data: {
        concertId: concert.id,
        sessionId,
        tier: body.tier as Tier,
        queueOpenAt,
      },
    });

    // D-15: row labels are numeric ("1".."seatRows") rather than A-Z so
    // tiers with more than 26 rows (MEDIUM 70, MEGA 150) remain representable,
    // while still preserving "row number = distance from stage".
    const config = await tx.simulationConfig.findUniqueOrThrow({ where: { tier: newRun.tier } });
    await tx.seat.createMany({
      data: Array.from({ length: config.seatRows }, (_, rowIndex) => String(rowIndex + 1)).flatMap((row) =>
        Array.from({ length: config.seatsPerRow }, (_, i) => ({
          concertId: concert.id,
          simulationRunId: newRun.id,
          row,
          number: i + 1,
        })),
      ),
    });

    return newRun;
  });

  return NextResponse.json<StartSimulationResponse>({
    runId: run.id,
    tier: run.tier,
    status: run.status,
    concertId: run.concertId,
  });
}
