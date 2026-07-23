import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Next.js convention: .env.local overrides .env and is gitignored.
config({ path: ".env.local" });
config();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // CLI (migrate/db seed/studio) uses the direct, non-pooled connection.
    // Runtime app code uses the pooled DATABASE_URL via @prisma/adapter-neon.
    url: env("DIRECT_URL"),
  },
});
