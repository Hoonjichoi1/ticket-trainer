# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ticket Trainer** is a ticketing simulation platform for K-pop fans to practice concert ticket booking in a safe environment. The app recreates real ticketing dynamics (queue pressure, seat contention, payment failures) without actual financial risk.

See `docs/PRD.md` for complete product specification and `AGENTS.md` for framework warnings.

## Language Rules
- Code, variable names, function names, and file names: English
- Code comments: English
- Commit messages: English
- All UI-facing text (buttons, labels, messages, page copy, etc.): English
  - Note: Korean ticketing-culture terms (e.g. "포도알") should be translated
    to their functional English equivalent (e.g. "available seat") rather than
    kept in Korean or transliterated.
- Exception: existing Korean-language documents (PRD.md, ROADMAP.md, CLAUDE.md,
  and already-completed files in /tasks) stay as-is — do not translate or
  modify them.
- Conversation with the user continues in Korean.

## Tech Stack & Key Constraints

### Critical: Next.js 16 Breaking Changes
This project uses **Next.js 16.2.11 + React 19.2.4** (latest versions). Per `AGENTS.md`, there are breaking changes from Next.js 14/15. **Always consult `node_modules/next/dist/docs/` before implementing features**, not online tutorials or training data. Key differences that may appear:

- Route handler caching behavior
- Component/async prop handling
- Metadata API changes
- Server component defaults

### Stack
- **Frontend**: Next.js 16 (App Router), React 19, TypeScript 5, TailwindCSS 4
- **Backend**: Route Handlers (no external backend yet)
- **Database**: Not yet initialized. Per PRD validation, will need:
  - PostgreSQL (Neon)
  - Prisma ORM with `@prisma/adapter-neon` for serverless
  - Raw SQL for transaction locks (`SELECT ... FOR UPDATE`)
- **Deployment**: Vercel (free tier — note pooled connection requirement)

### Styling
- TailwindCSS 4 with PostCSS (`@tailwindcss/postcss`)
- App uses path alias `@/*` for imports (configured in tsconfig.json)

## Development Commands

```bash
# Start dev server (localhost:3000)
npm run dev

# Build for production
npm build

# Run production server
npm start

# Lint code (ESLint)
npm run lint
# or lint a specific file:
npm run lint -- app/page.tsx

# (Future) Run migrations
# npm run db:migrate

# (Future) Reset database
# npm run db:reset
```

## Architecture (To Be Built)

### Current State
- Starter template only (`app/layout.tsx`, `app/page.tsx`)
- No API routes, database, or state management yet

### Planned Structure (from PRD)

```
app/
├── layout.tsx                 # Root layout with metadata
├── page.tsx                   # Home (tier selection + countdown)
├── queue/
│   └── page.tsx              # Queue waiting + position updates
├── seats/
│   └── page.tsx              # Seat selection with live map
├── booking/
│   └── page.tsx              # Booking info + hold timer
├── payment/
│   └── page.tsx              # Payment method selection + modal
├── result/
│   └── page.tsx              # Results report with feedback
├── api/
│   ├── queue/                # Queue management endpoints
│   ├── seats/                # Seat selection & lock
│   ├── booking/              # Booking confirmation
│   ├── payment/              # Payment simulation
│   └── session/              # Session token + admission
└── components/
    └── (shared UI components)

lib/
├── db.ts                      # Prisma client singleton
├── simulation.ts              # Simulation tick engine (critical)
└── types.ts                   # Shared types
```

### Critical: Simulation Tick Engine

From PRD validation, **bot/queue/hold-expiry are NOT real-time processes** in serverless. Instead, use a **"tick-on-request deterministic simulation"** pattern:

- Every user request (poll/select) triggers one server-side tick
- Tick advances elapsed time by (now - lastTick)
- Bot strength × elapsed time = seats bot claims
- Queue position decrements by (elapsed / drainInterval)
- Holds checked for expiry (expiresAt < now)
- **Result is deterministic**: same input = same output, suitable for serverless

This is NOT visible to users — appears as real-time behavior from polling/UX.

## Database Schema (To Be Implemented)

From `docs/PRD.md`, required tables and critical fields. **Must fix before development:**

### Critical Issues (from validation)
1. **`Hold` table**: Add `UNIQUE(seatId) WHERE expiresAt > now()` to prevent double-holding
2. **Transactional consistency**: `Seat.status` changes must be applied in the same transaction as `Hold`/`Booking` operations. Single conditional `UPDATE` on `Seat` (with `RETURNING`) atomically updates status; hold/booking writes must follow in the same transaction.
3. **Queue calculation fields**: Add `QueueEntry.joinedAt` (DateTime) and `SimulationConfig.admissionRatePerSec`
4. **Admission token security**: Implement as random, non-guessable token with sessionId binding (one-time validation)

### Entity Relationships
```
Concert (1) ──→ (many) Seat
Concert (1) ──→ (many) Booking
Concert (1) ──→ (many) QueueEntry

Seat (1) ──→ (0..1) Hold (active + expiresAt > now)
Seat (1) ──→ (0..1) Booking (final)

QueueEntry ──→ Session (sessionId)
Hold ──→ Session
Booking ──→ Session
```

**Indexes required** (for performance):
- `Seat.concertId` (filter seats)
- `Hold.expiresAt` (lazy cleanup + availability check)
- `Hold(seatId, expiresAt)` (partial unique constraint)
- `QueueEntry.concertId, sessionId`

## Development Notes

### Concurrency & Atomicity
- **Seat selection**: Use conditional `UPDATE seats SET status='held' WHERE id=$1 AND status='available' RETURNING id` to atomically reserve seat. This single query is atomic and avoids explicit locks. Follow immediately with `INSERT INTO holds (seatId, sessionId, expiresAt)` within the same transaction to maintain consistency.
- **Transactional boundary**: All seat state changes (status → held/available) must wrap seat updates + hold inserts/deletes in a single transaction to prevent race conditions.
- **Connection pooling**: Must use Neon pooled connection (`-pooler` suffix) or `@prisma/adapter-neon` for serverless
- **Polling**: 2-second interval for 200-seat map is sufficient (Route Handlers not cached by default)

### Session Management
- Anonymous sessions via HTTP-only, signed cookies (UUID per session)
- Admission token issued by server, validated once, invalidated on use (prevents queue-skipping)

### Error Handling in Payment
- Client-side `navigator.sendBeacon` for hold release on page unload (not 100% reliable)
- 5-minute hold expiry serves as safety net for missed releases
- Tier-based error injection (probability per `SimulationConfig.errorRate`)

### Testing Strategy
- No test framework configured yet; consider Vitest for API routes
- Integration tests must hit real (test) database for lock validation
- Avoid mocking database transactions (mocked locks hide race conditions)

## Documentation References
- **PRD**: `docs/PRD.md` (complete feature spec, user flow, data model)
- **PRD Validation Report**: Embedded in PRD comments; indicates critical items (tick engine, schema fixes)
- **Next.js Docs**: `node_modules/next/dist/docs/` (especially `01-app/01-getting-started/15-route-handlers.md`)
- **Framework Warnings**: `AGENTS.md`

## Before First Commit
1. **Schema initialization**: Create `schema.prisma` with validated model (fix critical issues above)
2. **Env setup**: Add `.env.local` with `DATABASE_URL` (Neon pooled), `.env.example` for reference
3. **Simulation engine skeleton**: Stub `lib/simulation.ts` with tick-on-request pattern
4. **API route structure**: Create empty route handlers for planning

## Common Pitfalls
- ❌ Assuming Next.js 14/15 patterns work in 16 — check `node_modules/next/dist/docs/` first
- ❌ Splitting `Seat.status` update from `Hold` write into separate transactions — will cause state divergence under concurrent access
- ❌ Implementing bot as `setInterval` — serverless functions don't persist between requests
- ❌ Forgetting Neon pooler — will work locally, fail in production under load
- ❌ Mocking database in tests — won't catch real locking bugs

## Quick Start for New Features
1. **Read**: `docs/PRD.md` section for the feature
2. **Check**: Next.js docs in `node_modules/` for API (not npm/online docs)
3. **Sketch**: Route handler signature + request/response types
4. **Implement**: Using deterministic tick for time-based logic
5. **Test**: Against real database (test Neon instance or local Postgres)

## Task 완료 보고 규격
Task 완료 시 아래 4항목으로 보고한다 (리뷰 기준: docs/REVIEW.md):
1. 이번 Task의 설계 결정 (선택지 + 채택 이유)
2. 플랜에서 벗어난 부분 (deviation)
3. 다음 Task로 미룬 것 (deferred)
4. 스스로 리스크가 있다고 판단하는 지점
