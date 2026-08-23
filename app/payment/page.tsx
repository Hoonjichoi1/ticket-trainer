import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getActiveRun } from "@/lib/queue";
import { expireStaleHolds, getOwnedHold } from "@/lib/seats";
import { getSessionResultRow, recordStageEntered } from "@/lib/session-result";
import PaymentViewLoader from "./PaymentViewLoader";

/**
 * Same hold-ownership gate as app/booking/page.tsx (see that file's
 * comment for the /result vs /seats branch, ROADMAP D-9), timing the
 * "payment" stage instead of "booking_info".
 */
export default async function PaymentPage() {
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

  await recordStageEntered(prisma, session.sessionId, "payment", now);

  return (
    <PaymentViewLoader
      seat={{ id: hold.seatId, row: hold.row, number: hold.number }}
      holdExpiresAt={hold.expiresAt.toISOString()}
    />
  );
}
