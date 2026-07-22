import { NextResponse } from "next/server";

// TODO(Task 007+): seat map + bot claim tick, atomic conditional UPDATE
// (status='held' WHERE status='available' RETURNING id) per CLAUDE.md.
export async function GET() {
  return NextResponse.json({ status: "not_implemented" }, { status: 501 });
}
