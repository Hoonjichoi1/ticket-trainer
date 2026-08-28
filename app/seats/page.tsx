import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getActiveRun, redeemAdmissionToken, requireAdmission } from "@/lib/queue";
import SeatsViewLoader from "./SeatsViewLoader";

interface SeatsPageProps {
  // Next.js 16: searchParams is a Promise on Server Component pages
  // (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
  searchParams: Promise<{ admissionToken?: string }>;
}

/**
 * Admission gate (F004, anti-queue-skip): redirects to /queue unless the
 * session has an ADMITTED QueueEntry for its active run. A `?admissionToken=`
 * from the queue poll is redeemed (one-time invalidation) on the way in,
 * but requireAdmission() — not the token — is the actual gate, so a normal
 * reload of /seats after admission (no token in a fresh request) still
 * works.
 */
export default async function SeatsPage({ searchParams }: SeatsPageProps) {
  const { admissionToken } = await searchParams;

  const session = await requireSession();
  if ("error" in session) {
    redirect("/queue");
  }

  const run = await getActiveRun(session.sessionId);
  if (!run) {
    redirect("/queue");
  }

  if (admissionToken) {
    await redeemAdmissionToken({ sessionId: session.sessionId, runId: run.id, token: admissionToken, now: new Date() });
  }

  const admitted = await requireAdmission({ sessionId: session.sessionId, runId: run.id });
  if (!admitted) {
    redirect("/queue");
  }

  return <SeatsViewLoader zoneCount={run.config.zoneCount} />;
}
