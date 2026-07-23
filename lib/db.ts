import { PrismaClient } from "@/lib/generated/prisma/client";
import { createPrismaAdapter } from "@/lib/prisma-adapter";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = createPrismaAdapter(process.env.DATABASE_URL);

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
