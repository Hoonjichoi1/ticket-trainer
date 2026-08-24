import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueuePoller } from "./QueuePoller";

const pushMock = vi.fn();
// A stable object (not a fresh literal per call) — matches real Next.js
// useRouter()'s stable reference. QueuePoller's poll effect depends on
// [router], so a mock returning a new object every render would make the
// effect tear down/re-fire on every state update, looping forever.
const routerMock = { push: pushMock };

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

describe("QueuePoller (ROADMAP D-12: a failed join must not be treated as joined)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount (flushing QueuePoller's clearTimeout cleanup) while fake
    // timers are still installed, before switching back to real ones —
    // otherwise the previous test's still-mounted poller and this test's
    // fresh one can race under the timer-implementation swap.
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps retrying with POST and keeps showing the real error after SALE_NOT_OPEN (403)", async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "error",
            code: "SALE_NOT_OPEN",
            message: "Ticket sale has not opened yet.",
          }),
          { status: 403 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<QueuePoller />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Ticket sale has not opened yet.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });

    // Bug being fixed: previously hasJoinedRef flipped to true even on a
    // 403, so this next attempt would wrongly use GET (which 404s with no
    // queue entry and overwrites the message with a misleading one).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(screen.getByText("Ticket sale has not opened yet.")).toBeInTheDocument();
  });

  it("switches to GET polling once the join actually succeeds", async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ position: 5, aheadCount: 5, estimatedWaitSeconds: 1, status: "WAITING" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<QueuePoller />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Your position in line/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "GET" });
  });
});
