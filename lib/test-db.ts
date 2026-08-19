import { PrismaClient } from "@/lib/generated/prisma/client";
import { createPrismaAdapter } from "@/lib/prisma-adapter";

// Real DB, not a mock (ROADMAP.md's "모킹 금지" rule for lock/transaction
// tests) — but not a separate physical test database either, since no
// dedicated Neon test branch exists yet. Points at the same DATABASE_URL
// as lib/db.ts (local Postgres in dev, per vitest.setup.ts loading
// .env.local). Callers are responsible for cleaning up rows they create.
let client: PrismaClient | undefined;

export function getTestDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ adapter: createPrismaAdapter(process.env.DATABASE_URL) });
  }
  return client;
}
