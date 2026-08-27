import { prisma } from "@/lib/db";
import HomeViewLoader from "./HomeViewLoader";

// D-11: a plain Prisma call isn't a Request-time API Next.js tracks (unlike
// cookies()/headers()), so under the legacy caching model (no cacheComponents
// here) this page would otherwise be eligible for build-time static
// rendering, freezing concert.openAt forever. See node_modules/next/dist/docs/
// 01-app/02-guides/caching-without-cache-components.md.
export const dynamic = "force-dynamic";

// getDummyConcert() (removed by D-11) always generated openAt as "+60s from
// this request", so every visit got a fresh, demoable countdown regardless
// of how stale the seed data was. Restoring that property without writing
// to Concert.openAt (D-11's whole point was making the DB row the source of
// truth): if the real openAt has already passed, DISPLAY it as if it were
// 60s out from *this* request's "now" — computed fresh per request, never
// persisted, so concurrent visitors each get their own independent
// countdown with no shared mutable state to race on. Display-only,
// deliberately NOT shared with lib/simulation.ts's resolveQueueOpenAt
// (D-14): that one persists the *actual* queue-open reference the
// SALE_NOT_OPEN gate and D-4 position math use, and must clamp a stale
// openAt to "now", not "now + 60s" — otherwise every session would face an
// artificial 60s wait to join the queue right after this countdown
// finishes. This function only ever makes the *display* more conservative
// than the backend (a harmless short extra wait before Book Now is
// clickable), never the reverse.
const DEMO_REOPEN_MS = 60_000;

/** Exported for direct unit testing (pure function, same style as lib/simulation.ts's calc helpers). */
export function resolveDisplayOpenAt(openAt: Date, now: Date): Date {
  return openAt > now ? openAt : new Date(now.getTime() + DEMO_REOPEN_MS);
}

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

  const displayOpenAt = resolveDisplayOpenAt(concert.openAt, new Date());

  return (
    <HomeViewLoader
      concert={{
        title: concert.title,
        venue: concert.venue,
        openAt: displayOpenAt.toISOString(),
      }}
    />
  );
}
