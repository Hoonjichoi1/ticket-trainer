import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier, SimulationRunStatus, SeatStatus } from "@/lib/types";
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
const { POST } = await import("./route");

const db = getTestDb();
const createdConcertIds: string[] = [];
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-booking-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  }
  if (createdRunIds.length > 0) {
    await db.hold.deleteMany({ where: { seat: { simulationRunId: { in: createdRunIds } } } });
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

async function createActiveRun(sessionId: string) {
  const concert = await db.concert.create({
    data: { title: "booking-route-test", venue: "test-venue", openAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  createdConcertIds.push(concert.id);

  const run = await db.simulationRun.create({
    data: {
      concertId: concert.id,
      sessionId,
      tier: Tier.SMALL,
      status: SimulationRunStatus.ACTIVE,
      lastTickAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  createdRunIds.push(run.id);

  return run;
}

async function createHeldSeat(sessionId: string, run: { id: string; concertId: string }, expiresAt: Date) {
  const seat = await db.seat.create({
    data: { concertId: run.concertId, simulationRunId: run.id, row: "A", number: 1, status: SeatStatus.HELD },
  });
  await db.hold.create({ data: { seatId: seat.id, sessionId, expiresAt } });
  return seat;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/booking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { ticketCount: 1, deliveryMethod: "mobile", termsAgreed: true };

describe("POST /api/booking", () => {
  it("rejects a request with no session cookie", async () => {
    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the session has no active simulation run", async () => {
    await establishSession();
    const res = await POST(jsonRequest(VALID_BODY));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NO_ACTIVE_RUN");
  });

  it("returns 400 for an invalid deliveryMethod", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ ...VALID_BODY, deliveryMethod: "carrier_pigeon" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_DELIVERY_METHOD");
  });

  it("returns 400 when termsAgreed is not true", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest({ ...VALID_BODY, termsAgreed: false }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("TERMS_NOT_AGREED");
  });

  it("returns ok with holdExpiresAt for a session holding a seat, and records booking_info.exitedAt", async () => {
    const sessionId = await establishSession();
    const run = await createActiveRun(sessionId);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await createHeldSeat(sessionId, run, expiresAt);

    const res = await POST(jsonRequest(VALID_BODY));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok", holdExpiresAt: expiresAt.toISOString() });

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(
      (sessionResult.stageTimings as { booking_info?: { exitedAt?: string } }).booking_info?.exitedAt,
    ).toBeTruthy();
  });

  it("returns hold_expired for a session with no active hold", async () => {
    const sessionId = await establishSession();
    await createActiveRun(sessionId);

    const res = await POST(jsonRequest(VALID_BODY));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "hold_expired" });
  });
});
