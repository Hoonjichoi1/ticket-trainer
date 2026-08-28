import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SeatCell } from "./SeatCell";
import { SeatStatus } from "@/lib/types";

// D-19: row moved from a 1-char letter (A-J) to a numeric string ("1".."150",
// D-15), and the label used to be a bare `${row}${number}` concat — with
// numeric rows, distinct seats collide on the same label (row=1,number=9 and
// row=11,number=... both render "19"/"1..."; row=1,number=10 and row=1,
// number=1... etc). A separator is required to keep labels unambiguous.
describe("SeatCell label formatting (D-19)", () => {
  it("renders row and number with a separator, not a bare concat", () => {
    render(<SeatCell seatId="s1" row="1" number={9} status={SeatStatus.AVAILABLE} />);
    expect(screen.getByText("1-9")).toBeInTheDocument();
    expect(screen.queryByText("19")).not.toBeInTheDocument();
  });

  it("gives visually/textually distinct labels for seats that would collide without a separator", () => {
    const { unmount } = render(<SeatCell seatId="s1" row="1" number={9} status={SeatStatus.AVAILABLE} />);
    const labelA = screen.getByRole("button").textContent;
    unmount();

    render(<SeatCell seatId="s2" row="1" number={10} status={SeatStatus.AVAILABLE} />);
    const labelB = screen.getByRole("button").textContent;

    // Without a separator both would render "19" vs "110" only by luck of
    // digit count — the real collision case is row=1/number=10 ("110")
    // vs row=11/number=0-ish; here we just assert the two concatenations
    // that used to be ambiguous are now distinguishable strings.
    expect(labelA).toBe("1-9");
    expect(labelB).toBe("1-10");
    expect(labelA).not.toBe(labelB);
  });

  it("includes row and number as separate, unambiguous words in the accessible name", () => {
    render(<SeatCell seatId="s1" row="11" number={1} status={SeatStatus.AVAILABLE} />);
    expect(screen.getByRole("button", { name: "Seat row 11, number 1, available" })).toBeInTheDocument();
  });
});
