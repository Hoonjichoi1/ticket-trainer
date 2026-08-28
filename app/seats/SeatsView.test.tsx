import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SeatsView from "./SeatsView";
import { SeatStatus, type SeatClaimResponse, type SeatSummary } from "@/lib/types";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function seat(id: string, number: number, status: SeatStatus): SeatSummary {
  return { id, row: "A", number, status };
}

describe("SeatsView (ROADMAP D-6: click is local-only, confirm performs the real claim)", () => {
  let seatMap: SeatSummary[];
  let claimResponse: SeatClaimResponse;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushMock.mockReset();
    seatMap = [
      seat("seat-1", 1, SeatStatus.AVAILABLE),
      seat("seat-2", 2, SeatStatus.AVAILABLE),
    ];
    claimResponse = {
      status: "held",
      holdExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({ seats: seatMap }), { status: 200 });
      }
      return new Response(JSON.stringify(claimResponse), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a seat click purely local; a confirm conflict (bot already took the seat) clears the selection so the user can reselect and confirm a different seat", async () => {
    const user = userEvent.setup();
    render(<SeatsView zoneCount={8} />);

    const zoneButton = await screen.findByRole("button", { name: /Zone 1/ });
    await user.click(zoneButton);

    const seat1Button = await screen.findByRole("button", { name: /Seat row A, number 1, available/i });
    await user.click(seat1Button);

    // Clicking a seat must not have sent any claim request — it's local
    // selection only (the bug D-6 fixes: a seat that *looks* available
    // could already be taken server-side, and claiming on click could get
    // a user stuck on it).
    const postCallsAfterClick = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCallsAfterClick).toHaveLength(0);
    expect(seat1Button).toHaveAttribute("aria-pressed", "true");

    const confirmButton = screen.getByRole("button", { name: /Confirm Seat Selection/i });

    // Simulate a bot having claimed seat-1 in the meantime: confirm now
    // conflicts, and the server's map (read back via refetch) reflects
    // seat-1 as HELD.
    claimResponse = {
      status: "conflict",
      code: "SEAT_ALREADY_TAKEN",
      message: "This seat has already been taken.",
    };
    seatMap = [seat("seat-1", 1, SeatStatus.HELD), seat("seat-2", 2, SeatStatus.AVAILABLE)];

    await user.click(confirmButton);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/just taken/i);
    expect(pushMock).not.toHaveBeenCalled();

    // Selection is cleared and the map refetch is reflected: seat-1 is now
    // disabled (HELD), and confirm is disabled again with no selection.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Seat row A, number 1, held/i })).toBeDisabled(),
    );
    expect(confirmButton).toBeDisabled();

    // The core D-6 assertion: reselecting a different seat is NOT blocked.
    const seat2Button = screen.getByRole("button", { name: /Seat row A, number 2, available/i });
    await user.click(seat2Button);
    expect(seat2Button).toHaveAttribute("aria-pressed", "true");
    expect(confirmButton).toBeEnabled();

    // Confirming the new seat succeeds -> navigates to /booking.
    claimResponse = {
      status: "held",
      holdExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    await user.click(confirmButton);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/booking"));
  });
});
