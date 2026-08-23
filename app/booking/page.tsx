import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getActiveRun } from "@/lib/queue";
import { expireStaleHolds, getOwnedHold } from "@/lib/seats";
import { getSessionResultRow, recordStageEntered } from "@/lib/session-result";
import BookingViewLoader from "./BookingViewLoader";

/**
 * Hold-ownership gate (Task 010, redirect target corrected by ROADMAP
 * D-9): redirects away unless the session currently owns an active hold
 * for its active run. Booking/payment aren't polled the way /seats is (no
 * GET request naturally sweeps expiry), so this is the only place that
 * notices a hold expired while the user sat elsewhere — expireStaleHolds
 * runs here before the ownership check, same as app/seats/page.tsx's
 * admission check runs after its own guards. When there's no hold, where
 * to send the session depends on whether it ever had one this run
 * (stageTimings.seat_selection.exitedAt is only set on a successful claim,
 * Task 009's app/api/seats/route.ts): if so, the hold existed and is now
 * gone (expired/released) — PRD says that's a terminal failure, so /result
 * (D-9). If not (e.g. a direct URL hit with no prior claim), fall back to
 * /seats as before. The confirmed hold (seat + real holdExpiresAt) is
 * passed down as props so BookingView never needs to read sessionStorage
 * as its source of truth — a single server-derived value instead of two
 * that could diverge.
 */
export default async function BookingPage() {
  const session = await requireSession();
  if ("error" in session) {
    redirect("/seats");
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    redirect("/seats");
  }

  const now = new Date();
  await expireStaleHolds({ runId: run.id, now });
  const hold = await getOwnedHold({ sessionId: session.sessionId, runId: run.id });
  if (!hold) {
    const resultRow = await getSessionResultRow(prisma, session.sessionId);
    redirect(resultRow?.stageTimings.seat_selection?.exitedAt ? "/result" : "/seats");
  }

  await recordStageEntered(prisma, session.sessionId, "booking_info", now);

  return (
    <BookingViewLoader
      seat={{ id: hold.seatId, row: hold.row, number: hold.number }}
      holdExpiresAt={hold.expiresAt.toISOString()}
    />
  );
}
