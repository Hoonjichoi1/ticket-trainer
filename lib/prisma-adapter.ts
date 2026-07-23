import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";

// Neon connection strings always resolve through a neon.tech hostname.
// Local/dev Postgres (Docker, Homebrew, etc.) doesn't, so this switches
// automatically based on DATABASE_URL — no separate flag to keep in sync
// when swapping between local Postgres and real Neon.
export function createPrismaAdapter(connectionString: string | undefined) {
  if (connectionString?.includes("neon.tech")) {
    return new PrismaNeon({ connectionString });
  }
  return new PrismaPg({ connectionString });
}
