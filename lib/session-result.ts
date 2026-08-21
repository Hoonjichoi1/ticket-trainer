// Shared SessionResult recording helpers, introduced by Task 008 and
// reused by Task 009/010 (ROADMAP "관측 데이터 원칙": each task records its
// own stageTimings/events the moment they happen; Task 011 only reads and
// aggregates this row into outcome + feedback, never writes stageTimings/
// events itself). One row per sessionId (unique constraint), upserted on
// first write so callers never need to pre-create it.
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { JudgmentEvent, SimulationStage, StageTimings } from "@/lib/types";

type Db = PrismaClient | Prisma.TransactionClient;

// Prisma's upsert() is a client-side SELECT-then-write, not a single
// atomic `INSERT ... ON CONFLICT` — two concurrent first writes for the
// same brand-new sessionId (e.g. React StrictMode double-invoking an
// effect that joins the queue) can both miss the row and both attempt
// create(), so the loser hits a P2002 unique violation instead of the
// upsert silently falling back to update. Treat that race as "someone
// else already created it" and just read the row.
async function getOrCreate(db: Db, sessionId: string) {
  try {
    return await db.sessionResult.upsert({
      where: { sessionId },
      create: { sessionId },
      update: {},
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    }
    throw error;
  }
}

/** Sets stageTimings[stage].enteredAt — a no-op if already set, so repeated calls (e.g. rejoining the queue) don't clobber the original entry time. */
export async function recordStageEntered(
  db: Db,
  sessionId: string,
  stage: SimulationStage,
  now: Date,
): Promise<void> {
  const row = await getOrCreate(db, sessionId);
  const timings = (row.stageTimings ?? {}) as StageTimings;
  if (timings[stage]?.enteredAt) return;

  const updated: StageTimings = { ...timings, [stage]: { ...timings[stage], enteredAt: now.toISOString() } };
  await db.sessionResult.update({ where: { id: row.id }, data: { stageTimings: toJson(updated) } });
}

/** Sets stageTimings[stage].exitedAt + durationMs relative to enteredAt (falls back to `now` as the baseline if the stage was never marked entered). */
export async function recordStageExited(
  db: Db,
  sessionId: string,
  stage: SimulationStage,
  now: Date,
): Promise<void> {
  const row = await getOrCreate(db, sessionId);
  const timings = (row.stageTimings ?? {}) as StageTimings;
  const enteredAt = timings[stage]?.enteredAt ?? now.toISOString();
  const durationMs = now.getTime() - new Date(enteredAt).getTime();

  const updated: StageTimings = { ...timings, [stage]: { enteredAt, exitedAt: now.toISOString(), durationMs } };
  await db.sessionResult.update({ where: { id: row.id }, data: { stageTimings: toJson(updated) } });
}

/** Appends a judgment event to SessionResult.events (never overwrites prior events). */
export async function recordJudgmentEvent(db: Db, sessionId: string, event: JudgmentEvent): Promise<void> {
  const row = await getOrCreate(db, sessionId);
  const events = (Array.isArray(row.events) ? row.events : []) as unknown as JudgmentEvent[];
  await db.sessionResult.update({ where: { id: row.id }, data: { events: toJson([...events, event]) } });
}

/**
 * Increments SessionResult.contentionLosses by 1 (Task 009: a seat claim
 * attempt lost to a bot/other session). Uses Prisma's atomic `increment`
 * (a single `UPDATE ... SET x = x + 1`, not read-then-write) so concurrent
 * losses in the same session can't clobber each other the way a
 * read-modify-write would.
 */
export async function incrementContentionLosses(db: Db, sessionId: string): Promise<void> {
  const row = await getOrCreate(db, sessionId);
  await db.sessionResult.update({ where: { id: row.id }, data: { contentionLosses: { increment: 1 } } });
}

// Prisma's InputJsonValue type requires structural index signatures that
// our domain types (StageTimings, JudgmentEvent[]) don't declare — this
// cast is safe since both are plain JSON-serializable shapes by construction.
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
