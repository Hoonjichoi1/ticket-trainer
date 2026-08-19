import { describe, it, expect } from "vitest";
import { getTestDb } from "@/lib/test-db";

describe("test environment sanity", () => {
  it("runs Vitest correctly", () => {
    expect(1 + 1).toBe(2);
  });

  it("getTestDb connects to the real database (Task 006)", async () => {
    const db = getTestDb();
    const concertCount = await db.concert.count();
    expect(concertCount).toBeGreaterThanOrEqual(0);
  });

  it("getTestDb returns the same client instance on repeated calls", () => {
    expect(getTestDb()).toBe(getTestDb());
  });
});
