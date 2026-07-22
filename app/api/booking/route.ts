import { NextResponse } from "next/server";

// TODO(Task 008+): confirm booking — seat status + Hold/Booking writes must
// stay in the same transaction per CLAUDE.md concurrency notes.
export async function POST() {
  return NextResponse.json({ status: "not_implemented" }, { status: 501 });
}
