import { prisma } from "@/lib/db";
import HomeViewLoader from "./HomeViewLoader";

// D-11: a plain Prisma call isn't a Request-time API Next.js tracks (unlike
// cookies()/headers()), so under the legacy caching model (no cacheComponents
// here) this page would otherwise be eligible for build-time static
// rendering, freezing concert.openAt forever. See node_modules/next/dist/docs/
// 01-app/02-guides/caching-without-cache-components.md.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const concert = await prisma.concert.findFirst();

  if (!concert) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-[var(--color-mute)]">
          No concert is configured yet. Run the database seed script.
        </p>
      </div>
    );
  }

  return (
    <HomeViewLoader
      concert={{
        title: concert.title,
        venue: concert.venue,
        openAt: concert.openAt.toISOString(),
      }}
    />
  );
}
