// Placeholder test-database connection helper.
// TODO(Task 002/006): replace with a real Prisma Client + @prisma/adapter-neon
// connection against a dedicated test database (not the dev/prod Neon branch).
export function getTestDb(): never {
  throw new Error(
    "getTestDb() is a stub — Task 002/006 must implement a real test database connection before this is used."
  );
}
