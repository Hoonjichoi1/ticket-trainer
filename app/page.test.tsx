import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import HomeViewLoader from "./HomeViewLoader";

const findFirstMock = vi.fn();

// Mocked at the same boundary SeatsView.test.tsx mocks `fetch` — this test
// is about app/page.tsx's plumbing (does it forward the DB row, not a
// hardcoded dummy?), not about Prisma/DB correctness, which lib/queue.test.ts
// etc. already cover against a real test DB.
vi.mock("@/lib/db", () => ({
  prisma: { concert: { findFirst: (...args: unknown[]) => findFirstMock(...args) } },
}));

const { default: HomePage } = await import("./page");

describe("HomePage (ROADMAP D-11: real Concert row, not getDummyConcert())", () => {
  it("passes the real Concert row's title/venue/openAt through to HomeViewLoader", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "concert-1",
      title: "Real Concert Title",
      venue: "Real Venue",
      openAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const element = await HomePage();

    expect(element.type).toBe(HomeViewLoader);
    expect(element.props.concert).toEqual({
      title: "Real Concert Title",
      venue: "Real Venue",
      openAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("renders a fallback message instead of dummy data when no concert exists", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const element = await HomePage();
    const { container } = render(element);

    expect(container.textContent).toMatch(/no concert is configured/i);
  });
});
