import { config } from "dotenv";
import "@testing-library/jest-dom/vitest";

// Vitest runs standalone (not through `next dev`, which auto-loads
// .env.local) — mirrors prisma.config.ts's loading order so tests see
// the same DATABASE_URL/SESSION_SECRET as the app and Prisma CLI.
config({ path: ".env.local" });
config();
