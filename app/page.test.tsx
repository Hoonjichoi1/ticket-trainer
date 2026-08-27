import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import HomeViewLoader from "./HomeViewLoader";
import { resolveDisplayOpenAt } from "./page";

const findFirstMock = vi.fn();

// Mocked at the same boundary SeatsView.test.tsx mocks `fetch` — this test
// is about app/page.tsx's plumbing (does it forward the DB row, not a
// hardcoded dummy?), not about Prisma/DB correctness, which lib/queue.test.ts
// etc. already cover against a real test DB.
vi.mock("@/lib/db", () => ({
  prisma: { concert: { findFirst: (...args: unknown[]) => findFirstMock(...args) } },
}));

const { default: HomePage } = await import("./page");

describe("resolveDisplayOpenAt (D-11 follow-up: getDummyConcert()'s demoable '+60s' restored as a display-only fallback)", () => {
  it("passes a still-future openAt through unchanged", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const openAt = new Date("2026-06-01T00:05:00.000Z");

    expect(resolveDisplayOpenAt(openAt, now)).toEqual(openAt);
  });

  it("displays a past openAt as 60s out from now, without needing to touch the stored value", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const openAt = new Date("2026-05-01T00:00:00.000Z"); // long past

    expect(resolveDisplayOpenAt(openAt, now)).toEqual(new Date("2026-06-01T00:01:00.000Z"));
  });
});

describe("HomePage (ROADMAP D-11: real Concert row, not getDummyConcert())", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the real Concert row's title/venue through, and a still-future openAt unchanged", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "concert-1",
      title: "Real Concert Title",
      venue: "Real Venue",
      openAt: new Date("2026-06-01T01:00:00.000Z"),
    });

    const element = await HomePage();

    expect(element.type).toBe(HomeViewLoader);
    expect(element.props.concert).toEqual({
      title: "Real Concert Title",
      venue: "Real Venue",
      openAt: "2026-06-01T01:00:00.000Z",
    });
  });

  it("displays a stale (already-past) openAt as 60s from the request's own now, not the stored value", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "concert-1",
      title: "Real Concert Title",
      venue: "Real Venue",
      openAt: new Date("2026-01-01T00:00:00.000Z"), // long past
    });

    const element = await HomePage();

    expect(element.props.concert.openAt).toBe("2026-06-01T00:01:00.000Z");
  });

  it("renders a fallback message instead of dummy data when no concert exists", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const element = await HomePage();
    const { container } = render(element);

    expect(container.textContent).toMatch(/no concert is configured/i);
  });
});
