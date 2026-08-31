// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SimulationRunStatus, SessionOutcome, Tier } from "@/lib/types";
import { getTestDb } from "@/lib/test-db";
import { recordJudgmentEvent, recordStageEntered, incrementContentionLosses } from "@/lib/session-result";
import { resolveQueueOpenAt } from "@/lib/simulation";

const store = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
  })),
}));

const { POST } = await import("./route");

const db = getTestDb();
const createdRunIds: string[] = [];
const createdSessionIds: string[] = [];

// MEDIUM/MEGA seat-map generation is a large bulk insert against a real DB
// (D-15 target scale: 7,000 / 15,000 rows) — the default 5000ms testTimeout
// is too tight for that against a remote (Neon) connection. Scoped to this
// file only, not vitest.config.ts's global default.
vi.setConfig({ testTimeout: 10000 });

function postSession(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/session", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  store.clear();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-secret-for-session-route-tests";
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.sessionResult.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
    createdSessionIds.length = 0;
  }
  if (createdRunIds.length === 0) return;
  await db.seat.deleteMany({ where: { simulationRunId: { in: createdRunIds } } });
  await db.simulationRun.deleteMany({ where: { id: { in: createdRunIds } } });
  createdRunIds.length = 0;
});

describe("POST /api/session", () => {
  it("rejects a missing/invalid tier", async () => {
    const res = await postSession({ tier: "NOT_A_TIER" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_TIER");
  });

  it("rejects an unparseable JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/session", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_BODY");
  });

  it("starts a simulation run scoped to a fresh session, with the tier's configured seat map", async () => {
    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.SMALL } });

    const res = await postSession({ tier: Tier.SMALL });
    expect(res.status).toBe(200);
    const json = await res.json();
    createdRunIds.push(json.runId);

    expect(json.tier).toBe(Tier.SMALL);
    expect(json.status).toBe(SimulationRunStatus.ACTIVE);
    expect(typeof json.concertId).toBe("string");

    const seats = await db.seat.findMany({ where: { simulationRunId: json.runId } });
    expect(seats).toHaveLength(config.seatRows * config.seatsPerRow);
    expect(seats.every((s) => s.status === "AVAILABLE")).toBe(true);

    // Row labels are numeric strings "1".."seatRows" (D-15: numeric labeling
    // replaces the old A-Z scheme so tiers with >26 rows are representable).
    const rowLabels = new Set(seats.map((s) => s.row));
    expect(rowLabels.size).toBe(config.seatRows);
    for (let i = 1; i <= config.seatRows; i++) {
      expect(rowLabels.has(String(i))).toBe(true);
    }
    expect(Math.min(...seats.map((s) => s.number))).toBe(1);
    expect(Math.max(...seats.map((s) => s.number))).toBe(config.seatsPerRow);

    // Cookie was issued for the new session.
    expect(store.size).toBe(1);
  });

  it("generates MEDIUM's configured seat count (D-15 target scale)", async () => {
    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.MEDIUM } });
    const res = await postSession({ tier: Tier.MEDIUM });
    const json = await res.json();
    createdRunIds.push(json.runId);

    const seatCount = await db.seat.count({ where: { simulationRunId: json.runId } });
    expect(seatCount).toBe(config.seatRows * config.seatsPerRow);
  });

  it("generates MEGA's configured seat count (D-15 target scale)", async () => {
    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.MEGA } });
    const res = await postSession({ tier: Tier.MEGA });
    const json = await res.json();
    createdRunIds.push(json.runId);

    const seatCount = await db.seat.count({ where: { simulationRunId: json.runId } });
    expect(seatCount).toBe(config.seatRows * config.seatsPerRow);
  });

  it("records the requested tier on the created SimulationRun", async () => {
    const res = await postSession({ tier: Tier.MEGA });
    const json = await res.json();
    createdRunIds.push(json.runId);

    const run = await db.simulationRun.findUniqueOrThrow({ where: { id: json.runId } });
    expect(run.tier).toBe(Tier.MEGA);
  });

  it("reuses the same session across two calls (no duplicate cookie issuance)", async () => {
    const first = await (await postSession({ tier: Tier.SMALL })).json();
    createdRunIds.push(first.runId);
    const second = await (await postSession({ tier: Tier.MEDIUM })).json();
    createdRunIds.push(second.runId);

    const firstRun = await db.simulationRun.findUniqueOrThrow({ where: { id: first.runId } });
    const secondRun = await db.simulationRun.findUniqueOrThrow({ where: { id: second.runId } });
    expect(firstRun.sessionId).toBe(secondRun.sessionId);
  });

  it("resets on restart: ends the previous ACTIVE run and its seats stay isolated from the new run", async () => {
    const config = await db.simulationConfig.findUniqueOrThrow({ where: { tier: Tier.SMALL } });
    const expectedSeatCount = config.seatRows * config.seatsPerRow;

    const first = await (await postSession({ tier: Tier.SMALL })).json();
    createdRunIds.push(first.runId);
    const second = await (await postSession({ tier: Tier.SMALL })).json();
    createdRunIds.push(second.runId);

    const firstRun = await db.simulationRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(firstRun.status).not.toBe(SimulationRunStatus.ACTIVE);

    const secondRun = await db.simulationRun.findUniqueOrThrow({ where: { id: second.runId } });
    expect(secondRun.status).toBe(SimulationRunStatus.ACTIVE);

    const firstRunSeats = await db.seat.count({ where: { simulationRunId: first.runId } });
    const secondRunSeats = await db.seat.count({ where: { simulationRunId: second.runId } });
    expect(firstRunSeats).toBe(expectedSeatCount);
    expect(secondRunSeats).toBe(expectedSeatCount);
  });

  it("resets SessionResult on restart (ROADMAP D-8): a prior attempt's stageTimings/events/contentionLosses/outcome don't bleed into the new run's report", async () => {
    const first = await (await postSession({ tier: Tier.SMALL })).json();
    createdRunIds.push(first.runId);

    const firstRun = await db.simulationRun.findUniqueOrThrow({ where: { id: first.runId } });
    const sessionId = firstRun.sessionId;
    createdSessionIds.push(sessionId);

    await recordStageEntered(db, sessionId, "queue", new Date("2026-01-01T00:00:00.000Z"));
    await incrementContentionLosses(db, sessionId);
    await recordJudgmentEvent(db, sessionId, {
      type: "queue_reset",
      stage: "queue",
      timestamp: "2026-01-01T00:00:01.000Z",
      positionBeforeReset: 10,
    });
    await db.sessionResult.update({ where: { sessionId }, data: { outcome: SessionOutcome.ABANDONED } });

    const second = await (await postSession({ tier: Tier.SMALL })).json();
    createdRunIds.push(second.runId);
    const secondRun = await db.simulationRun.findUniqueOrThrow({ where: { id: second.runId } });
    expect(secondRun.sessionId).toBe(sessionId); // same session, retry via cookie reuse

    const sessionResult = await db.sessionResult.findUniqueOrThrow({ where: { sessionId } });
    expect(sessionResult.outcome).toBeNull();
    expect(sessionResult.contentionLosses).toBe(0);
    expect(sessionResult.events).toEqual([]);
    expect(sessionResult.stageTimings).toEqual({});
  });

  it("falls back to the seeded concert when concertId is omitted", async () => {
    const res = await postSession({ tier: Tier.SMALL });
    const json = await res.json();
    createdRunIds.push(json.runId);
    expect(json.concertId).toBeTruthy();
  });

  it("snapshots SimulationRun.queueOpenAt from the concert's openAt at creation time (D-14)", async () => {
    const before = new Date();
    const res = await postSession({ tier: Tier.SMALL });
    const json = await res.json();
    createdRunIds.push(json.runId);
    const after = new Date();

    const run = await db.simulationRun.findUniqueOrThrow({ where: { id: json.runId } });
    const concert = await db.concert.findUniqueOrThrow({ where: { id: run.concertId } });

    // resolveQueueOpenAt is deterministic given (openAt, now) — the route's
    // own `now` falls somewhere in [before, after], so bound it both ways
    // rather than asserting one exact value.
    const expectedEarly = resolveQueueOpenAt(concert.openAt, before).getTime();
    const expectedLate = resolveQueueOpenAt(concert.openAt, after).getTime();
    expect(run.queueOpenAt.getTime()).toBeGreaterThanOrEqual(Math.min(expectedEarly, expectedLate));
    expect(run.queueOpenAt.getTime()).toBeLessThanOrEqual(Math.max(expectedEarly, expectedLate));
  });
});
