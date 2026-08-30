// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Tier, SimulationRunStatus, QueueEntryStatus, SeatStatus } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";

const store = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
  })),
}));

const { getOrCreateSessionId } = await import("@/lib/session");
const { GET, POST } = await import("./route");

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-seats-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.hold.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
    await db.queueEntry.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.seat.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
    await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
  if (createdConcertIds.length > 0) {
    await db.concert.deleteMany({ where: { id: { in: createdConcertIds } } });
  }
  createdSessionIds.length = 0;
  createdRunIds.length = 0;
  createdConcertIds.length = 0;
});

async function establishSession(): Promise<string> {
  const { sessionId } = await getOrCreateSessionId();
  createdSessionIds.push(sessionId);
  return sessionId;
}

async function createActiveRun(sessionId: string, opts: { tier?: Tier; admitted?: boolean } = {}) {
  const concert = await db.concert.create({
    data: { title: "seats-route-test", venue: "test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: opts.tier ?? Tier.SMALL,
      status: SimulationRunStatus.ACTIVE,
      // D-21: queueOpenAt (not lastTickAt) anchors computeBotClaimCount's elapsed.
      queueOpenAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);

  if (opts.admitted !== false) {
    await db.queueEntry.create({
      data: {
        concertId: concert.id,
        simulationRunId: run.id,
        sessionId,
        position: 0,
        status: QueueEntryStatus.ADMITTED,
      },
    });
  }

  return run;
}

async function createSeats(runId: string, concertId: string, count: number) {
  const seats = [];
  for (let i = 0; i < count; i++) {
    seats.push(await db.seat.create({ data: { concertId, simulationRunId: runId, row: "1", number: i + 1 } }));
  }
  return seats;
}

async function createSeatsAtNumbers(runId: string, concertId: string, numbers: number[]) {
  const seats = [];
  for (const number of numbers) {
    seats.push(await db.seat.create({ data: { concertId, simulationRunId: runId, row: "1", number } }));
  }
  return seats;
}

async function createSeatsAt(runId: string, concertId: string, coords: Array<[row: string, number: number]>) {
  const seats = [];
  for (const [row, number] of coords) {
    seats.push(await db.seat.create({ data: { concertId, simulationRunId: runId, row, number } }));
  }
  return seats;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/seats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(zone?: string): NextRequest {
  const url = zone !== undefined ? `http://localhost/api/seats?zone=${zone}` : "http://localhost/api/seats";
  return new NextRequest(url);
}

describe("GET /api/seats", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await GET(getRequest("1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session has no active simulation run", async () => {
    await establishSession();
    const res = await GET(getRequest("1"));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_RUN");
  });

  it("rejects with 403 when the session hasn't been admitted past the queue yet", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId, { admitted: false });

    const res = await GET(getRequest("1"));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("NOT_ADMITTED");
  });

  it("returns 400 when the zone query param is missing", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId, { tier: Tier.SMALL });

    const res = await GET(getRequest());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_ZONE");
  });

  it("returns 400 for a zone value out of range for the tier's zoneCount", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId, { tier: Tier.SMALL }); // SMALL zoneCount is 8 (see prisma/seed.ts)

    const res = await GET(getRequest("99"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_ZONE");
  });

  it("returns only the requested zone's seats, not the whole run's seat map (D-17 2D banding)", async () => {
    const sessionId = await establishSession();
    // SMALL zoneCount 8 -> 2 bands x 4 splits (see lib/seat-zones.ts's
    // computeZoneGrid): zone "1" (band 0, split 0) covers rows 1-13, numbers 1-25.
    const run = await createActiveRun(sessionId, { tier: Tier.SMALL });
    const inZone = await createSeatsAt(run.id, run.concertId, [
      ["1", 1],
      ["13", 25],
      ["7", 13],
    ]);
    await createSeatsAt(run.id, run.concertId, [
      ["1", 26], // same band, different split -> zone 2
      ["14", 1], // different band, same split -> zone 5
    ]);

    const res = await GET(getRequest("1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.seats.map((s: { id: string }) => s.id).sort()).toEqual(inZone.map((s) => s.id).sort());
  });

  it("runs the tick (bot claim + expired-hold release) across the whole run, independent of the requested zone", async () => {
    const sessionId = await establishSession();
    // MEGA zoneCount 25 -> 5 bands x 5 splits: zone "1" (band 0, split 0)
    // covers rows 1-30, numbers 1-20; zone "2" (band 0, split 1) covers
    // rows 1-30, numbers 21-40 — same band, adjacent split.
    const run = await createActiveRun(sessionId, { tier: Tier.MEGA }); // D-21 botCurveK, queueOpenAt far in the past
    const zone1Seats = await createSeatsAtNumbers(run.id, run.concertId, [1, 2, 3, 4]);
    const zone2Seats = await createSeatsAtNumbers(run.id, run.concertId, [21, 22, 23, 24]);

    const res = await GET(getRequest("1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.seats).toHaveLength(4);

    // queueOpenAt fixed far in the past and "now" is real wall-clock time,
    // so the depletion curve is fully saturated -> the bot claim covers
    // every AVAILABLE seat in the run, not just the requested zone's.
    const heldCount = json.seats.filter((s: { status: string }) => s.status === "HELD").length;
    expect(heldCount).toBe(4);

    const allSeatIds = [...zone1Seats, ...zone2Seats].map((s) => s.id);
    const holds = await db.hold.findMany({ where: { seatId: { in: allSeatIds } } });
    expect(holds).toHaveLength(8);
  });
});

describe("POST /api/seats", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await POST(jsonRequest({ seatId: "does-not-matter" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session has no active simulation run", async () => {
    await establishSession();
    const res = await POST(jsonRequest({ seatId: "does-not-matter" }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_RUN");
  });

  it("rejects with 403 when the session hasn't been admitted past the queue yet", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId, { admitted: false });
    const [seat] = await createSeats(run.id, run.concertId, 1);

    const res = await POST(jsonRequest({ seatId: seat.id }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("NOT_ADMITTED");
  });

  it("returns 400 for a missing/invalid seatId", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_SEAT_ID");
  });

  it("returns 404 for a seatId that belongs to a different run", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);
    const otherRun = await createActiveRun(`seats-route-other-${crypto.randomUUID()}`);
    const [otherSeat] = await createSeats(otherRun.id, otherRun.concertId, 1);

    const res = await POST(jsonRequest({ seatId: otherSeat.id }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("SEAT_NOT_FOUND");
  });

  it("claims an available seat, records seat_claim_success, and marks seat_selection as exited", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const [seat] = await createSeats(run.id, run.concertId, 1);

    const res = await POST(jsonRequest({ seatId: seat.id }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("held");
    expect(json.holdExpiresAt).toBeTruthy();

    const persistedSeat = await db.seat.findUniqueOrThrow({ where: { id: seat.id } });
    expect(persistedSeat.status).toBe(SeatStatus.HELD);

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events.some((e) => e.type === "seat_claim_success")).toBe(true);
    expect(
      (sessionResult.stageTimings as { seat_selection?: { exitedAt?: string } }).seat_selection?.exitedAt,
    ).toBeTruthy();
  });

  it("returns a conflict for an already-taken seat and records contention_loss + increments contentionLosses", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const [seat] = await createSeats(run.id, run.concertId, 1);
    await POST(jsonRequest({ seatId: seat.id })); // first claim succeeds

    const res = await POST(jsonRequest({ seatId: seat.id })); // second claim by the same session conflicts

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("conflict");
    expect(json.code).toBe("SEAT_ALREADY_TAKEN");

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(sessionResult.contentionLosses).toBe(1);
    const events = sessionResult.events as unknown as Array<{ type: string }>;
    expect(events.filter((e) => e.type === "contention_loss")).toHaveLength(1);
  });
});
