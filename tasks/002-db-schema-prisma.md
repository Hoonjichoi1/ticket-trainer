# Task 002: DB 스키마 · Prisma · 환경 설정

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 002 항목 업데이트

## 개요

Concert, Seat, Hold, Booking, QueueEntry, SimulationConfig, SessionResult 및 시뮬레이션 인스턴스 상태를 포함하는 Prisma 스키마를 작성한다. CLAUDE.md 크리티컬 이슈(부분 유니크 제약, tick 엔진 영속화)를 스키마 단계에서 반영해야 이후 Task가 재작업 없이 진행 가능.

## 관련 파일

- `schema.prisma` — 전체 데이터 모델 (신규)
- `.env.local` — Neon pooled connection (`-pooler` 접미사 필수) (신규, gitignore 대상)
- `.env.example` — 환경변수 레퍼런스 (신규)
- `lib/db.ts` — Prisma client 싱글톤 (신규)
- `prisma/seed.ts` — 시드 스크립트 (신규)

## 선행 조건

- 사전 결정 사항 D-1 (시뮬레이션 인스턴스 단위: 세션별 독립 인스턴스로 확정됨)
- 사전 결정 사항 D-2 (티어 선택 전달 경로: 대기열 진입 API 파라미터로 확정됨)

## 수락 기준

- [x] `Hold` 테이블에 이중 hold 방지 부분 유니크 제약 존재 — 단, `WHERE expiresAt > now()`가 아닌 `WHERE releasedAt IS NULL`로 구현 (아래 변경 사항 요약 참조)
- [x] `QueueEntry.joinedAt`(DateTime), `SimulationConfig.admissionRatePerSec`(Float) 필드 존재
- [x] 인덱스 존재: `Seat.concertId`, `Hold.expiresAt`, `Hold(seatId, expiresAt)` 부분 유니크, `QueueEntry(concertId, sessionId)`
- [x] D-1 결정(세션별 인스턴스) 반영: `SimulationRun` 모델(`id`, `sessionId`, `tier`, `lastTickAt`, `status`) 존재, `Seat`/`QueueEntry`가 스코프 키로 연결됨
- [x] `lastTickAt`이 메모리가 아닌 DB(`SimulationRun`)에 영속화됨
- [x] D-2 결정 반영: 선택 티어를 기록할 필드(`SimulationRun.tier`) 확정
- [x] `.env.local`의 `DATABASE_URL`이 Neon **pooled**(`-pooler`) 커넥션을 사용 — 단, 실제 Neon 프로젝트가 아직 없어 현재는 로컬 Postgres 값으로 대체 (아래 변경 사항 요약 참조)
- [x] `npx prisma migrate dev` 성공 확인 (로컬 Postgres). seed 스크립트의 데이터 셰이프는 임시 로컬 드라이런으로 검증했으나, `prisma/seed.ts` 자체(Neon adapter 사용)는 실제 Neon 연결 전까지 미실행 상태 (아래 변경 사항 요약 참조)

## 구현 단계

1. [x] `schema.prisma` 초안 작성 (Concert, Seat, Hold, Booking, QueueEntry, SimulationConfig, SessionResult, SimulationRun)
2. [x] `Hold` 부분 유니크 제약 및 인덱스 반영
3. [x] `SimulationRun.lastTickAt` 및 봇 결정론 유지용 필드(누적 처리 카운터/시드) 추가
4. [x] `@prisma/adapter-neon` 연동 설정
5. [x] `.env.local`(pooled connection) / `.env.example` 작성
6. [x] `lib/db.ts` Prisma client 싱글톤 구현
7. [x] 초기 마이그레이션 실행
8. [x] `prisma/seed.ts` 작성 (콘서트 1개, 200석 배치 템플릿, 소/중/메가 3티어 `SimulationConfig`)
9. [x] seed 실행 후 DB 상태 확인 (로컬 드라이런 기준)

## 변경 사항 요약

> **Hold 이중 hold 방지 제약 수정**: 태스크 원문의 `UNIQUE(seatId) WHERE expiresAt > now()`는 PostgreSQL에서 생성 불가능하다 — partial index predicate는 IMMUTABLE 함수만 허용하는데 `now()`는 STABLE이라 마이그레이션이 "functions in index predicate must be marked IMMUTABLE" 에러로 실패한다(Context7로 Prisma 공식 문서 확인). 대신 `Hold.releasedAt DateTime?` 필드를 추가하고 `@@unique([seatId], where: raw("\"releasedAt\" IS NULL"))`로 제약을 걸었다. `expiresAt`은 그대로 두고 실제 만료 판정(Task 007/009)에 계속 쓰인다 — tick 엔진이 만료를 발견하면 `Seat.status`를 되돌리는 같은 트랜잭션에서 `releasedAt`을 설정한다. 로컬 드라이런으로 "같은 좌석에 대한 두 번째 활성 hold는 DB가 거부한다"를 실제로 검증했다.
>
> **Prisma v7 채택**: 설치 시점 최신 버전(7.9.0)을 사용 — `prisma.config.ts` 필수, driver adapter 기본 활성화(`previewFeatures = ["partialIndexes"]`만 필요), `provider = "prisma-client"` + `output` 경로 필수, `datasource.url`은 schema.prisma가 아닌 `prisma.config.ts`/adapter 생성자에서만 지정 가능. 생성된 클라이언트의 진입점은 `index.ts`가 아니라 `client.ts`라서 `lib/generated/prisma/client`로 import한다.
>
> **DB 연결 검증**: 실제 Neon 프로젝트가 없어 처음엔 Homebrew로 로컬 Postgres 16을 설치해 `npx prisma migrate dev`를 드라이런했다 — 마이그레이션 자체(스키마 정확성, partial unique index 생성)는 실제로 검증 완료. 당시 `prisma/seed.ts`(운영 코드, `@prisma/adapter-neon` 전용)는 `@neondatabase/serverless`가 websocket/fetch 프로토콜로만 통신해 일반 로컬 Postgres에 연결할 수 없어, 데이터 셰이프 검증만 임시 스크립트로 우회했었다.
>
> **어댑터 자동 전환 추가**: 이후 사용자가 Docker로 로컬 Postgres를 준비하면서, `lib/db.ts`/`prisma/seed.ts`가 `DATABASE_URL`에 `neon.tech`가 포함되는지로 `PrismaNeon`/`PrismaPg`를 자동 선택하도록 `lib/prisma-adapter.ts` 공유 헬퍼를 추가했다 — 이제 로컬 Postgres 연결도 임시 스크립트 없이 정식 코드로 직접 지원한다. `@prisma/adapter-pg`, `pg`를 영구 의존성으로 설치. 실제 Neon 프로젝트로의 연결 자체는 여전히 미검증 — 실제 Neon URL로 교체 시 `neon.tech` 문자열 매칭으로 자동으로 `PrismaNeon` 경로를 타게 된다.
>
> 신규 파일: `prisma/schema.prisma`, `prisma.config.ts`, `lib/db.ts`, `lib/prisma-adapter.ts`, `prisma/seed.ts`, `.env.example`, `.env.local`(gitignored), `prisma/migrations/20260723001110_init/`. `package.json`에 `db:generate`/`db:migrate`/`db:seed`/`db:reset` 스크립트 추가(`npm pkg set`으로, 직접 Edit 금지 정책에 따름), `@prisma/adapter-pg`/`pg` 의존성 추가. `.gitignore`에 `/lib/generated/` 추가.
