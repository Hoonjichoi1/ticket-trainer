import { describe, it, expect } from "vitest";
import { getTestDb } from "@/lib/test-db";

describe("test environment sanity", () => {
  it("runs Vitest correctly", () => {
    expect(1 + 1).toBe(2);
  });

  it("getTestDb throws until Task 002/006 implements it", () => {
    expect(() => getTestDb()).toThrow();
  });
});
