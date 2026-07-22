import { NextResponse } from "next/server";

// TODO(Task 004+): issue anonymous session (HTTP-only signed cookie, UUID)
// and bind an admission token per CLAUDE.md session management notes.
export async function POST() {
  return NextResponse.json({ status: "not_implemented" }, { status: 501 });
}
