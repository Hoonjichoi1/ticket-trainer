# Task 006: 익명 세션 시스템 · 시뮬레이션 시작 API 구현

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 006 항목 업데이트

## 개요

Phase 3의 첫 백엔드 작업이자 최우선 순위 — 대기열 순번·hold 소유자·예매 전체가 사용자를 식별하는 기반이 되는 익명 세션(F012)과, 
그 세션에 티어를 기록하며 세션별 독립 시뮬레이션 인스턴스(`SimulationRun`)를 시작·리셋하는 API(F001 백엔드, D-2 결정 반영)를 구현한다. 
Task 007~011의 모든 API가 이 세션 식별과 `SimulationRun`에 의존하므로, 이 Task를 재작업 없이 먼저 완성해야 한다.

`lib/types.ts`에 이미 `StartSimulationRequest`/`StartSimulationResponse` 타입이 정의되어 있음(Task 003) — `POST /api/session`이 "세션 발급"과 "시뮬레이션 시작"을 한 요청으로 함께 처리하는 것이 기존 타입 설계의 전제다.

## 관련 파일

- `lib/session.ts` — 세션 쿠키 서명/검증, 세션 ID 발급·조회, 다른 라우트가 재사용할 `requireSession()` 헬퍼 (신규)
- `app/api/session/route.ts` — `POST`: 세션 쿠키 발급(또는 재사용) + `SimulationRun` 생성/리셋 + 200석 좌석 복제 (수정, 현재 `501 not_implemented` 스텁)
- `.env.example`, `.env.local` — 쿠키 서명 시크릿(`SESSION_SECRET`) 추가 (수정)
- `prisma/seed.ts` — 참고용(수정 없음): 200석 생성 템플릿(10행 × 20석, A~J)을 세션별 run에도 동일하게 적용
- `lib/types.ts` — 참고용, 필요 시 `requireSession()` 실패 응답 등 보강 (기존 `ApiErrorResponse` 재사용 우선)
- `lib/test-db.ts` — Task 001 스텁을 실제 테스트 DB Prisma client로 교체 (수정)
- `lib/test-db.test.ts` — 스텁이 `throw`한다는 기존 assertion을 실제 연결 확인으로 교체 (수정)
- `lib/session.test.ts` — `lib/session.ts` 단위 테스트 (신규)
- `app/api/session/route.test.ts` — `POST /api/session` 통합 테스트, 실제 DB 사용 (신규)
- `vitest.setup.ts` — 테스트 실행 전 `.env.local` 로드 (신규)
- `vitest.config.ts` — `test.setupFiles`에 위 파일 등록 (수정)

## 선행 조건

- Task 002 (스키마: `SimulationRun`, `Seat`, `Concert` — 특히 `Seat.simulationRunId` 필수 FK)
- Task 003 (타입: `StartSimulationRequest`/`StartSimulationResponse`)
- 사전 결정 사항 D-1 (세션별 독립 시뮬레이션 인스턴스), D-2 (티어는 시작 API 파라미터로 전달)

## 수락 기준

- [x] `POST /api/session` 호출 시 세션 쿠키가 없으면 새로 발급, 있고 서명이 유효하면 기존 세션 재사용 (HTTP-only, 서명된 쿠키, UUID 값)
- [x] 서명이 위변조되었거나 형식이 잘못된 쿠키는 거부하고 새 세션을 발급 (구 쿠키를 신뢰하지 않음)
- [x] 요청 바디의 `tier`(`StartSimulationRequest`)가 새로 생성되는 `SimulationRun.tier`에 그대로 기록됨
- [x] 시작 시 해당 세션에 새 `SimulationRun`(상태 `ACTIVE`)이 생성되고, 그 run에 귀속된 200석(`Seat`, 전부 `AVAILABLE`)이 함께 생성됨 — `Seat` 생성과 `SimulationRun` 생성은 같은 트랜잭션
- [x] 동일 세션으로 재호출("다시 도전" 포함) 시 기존 `ACTIVE` run은 종료 처리되고 완전히 새로운 run + 새 200석이 생성됨(리셋) — 이전 run의 좌석/hold를 재사용하지 않음
- [x] `requireSession()` 같은 재사용 가능한 세션 검증 헬퍼가 `lib/session.ts`에 존재하고, 유효하지 않은/누락된 세션에 대해 일관된 에러 형태(`ApiErrorResponse`)를 반환할 수 있음 — Task 007~011이 각자의 라우트에서 그대로 호출해 쓸 수 있는 형태
- [x] 응답이 `StartSimulationResponse`(`runId`, `tier`, `status`, `concertId`) 형태와 정확히 일치
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `SESSION_SECRET` 환경변수 추가(`.env.example`/`.env.local`) — 서명에 사용할 대칭키
2. [x] `lib/session.ts`: Node `crypto`(HMAC-SHA256)로 세션 쿠키 서명/검증 함수 작성 — 외부 라이브러리(iron-session 등) 추가 없이 최소 구현. `crypto.timingSafeEqual`로 서명 비교(타이밍 공격 방지)
3. [x] `lib/session.ts`: 쿠키에서 세션 ID를 읽고, 없거나 서명이 무효하면 `crypto.randomUUID()`로 새 세션 ID를 발급하는 `getOrCreateSessionId()` 작성
4. [x] `lib/session.ts`: 다른 Route Handler가 재사용할 `requireSession(request)` 검증 헬퍼 작성(세션 쿠키 유효성만 확인 — DB 조회는 호출자 책임)
5. [x] Next.js 16 문서(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`) 기준으로 `cookies()`가 비동기(`await cookies()`)임을 확인하고 그에 맞게 구현 — 구버전 동기 패턴 사용 금지
6. [x] **런타임 결정**: Route Handler 내부의 `requireSession()`/`getOrCreateSessionId()` 호출 방식으로 확정 (`middleware.ts` 미도입) — 근거는 아래 "변경 사항 요약" 참조
7. [x] `app/api/session/route.ts`의 `POST` 구현:
   - 요청 바디 파싱(`StartSimulationRequest`), `concertId` 생략 시 시드된 단일 콘서트를 조회해 사용
   - `getOrCreateSessionId()`로 세션 확보 → 응답에 `Set-Cookie`(httpOnly, 서명, 적절한 `maxAge`/`sameSite`) 반영
   - 해당 세션의 기존 `ACTIVE` `SimulationRun`이 있으면 종료 처리(리셋)
   - 트랜잭션 내에서 새 `SimulationRun` 생성 + `prisma/seed.ts`와 동일한 10행×20석 템플릿으로 200개 `Seat` `createMany`
   - `StartSimulationResponse` 형태로 응답
8. [x] 타입 체크·린트 통과 확인
9. [x] Vitest 단위 테스트 작성(아래 테스트 체크리스트 참조)
10. [x] Playwright MCP E2E 테스트 작성 및 실행(아래 테스트 체크리스트 참조)

## 테스트 체크리스트

### 단위 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] 쿠키 없이 요청 시 신규 세션이 발급되고 응답에 `Set-Cookie`가 포함됨
- [x] 유효한 기존 쿠키로 재요청 시 동일 세션 ID가 재사용됨
- [x] 서명이 위변조된 쿠키(값 임의 변경)는 거부되고 새 세션이 발급됨
- [x] 형식이 깨진 쿠키(구분자 없음, 빈 문자열 등)도 안전하게 새 세션으로 폴백됨(예외로 요청이 죽지 않음)
- [x] 요청한 `tier` 값이 생성된 `SimulationRun.tier`에 정확히 기록됨
- [x] 최초 시작 시 `SimulationRun` 1건 + `Seat` 200건(모두 `AVAILABLE`, 해당 run에 귀속)이 생성됨
- [x] 동일 세션으로 재시작("다시 도전") 시: 이전 run은 `ACTIVE`가 아니게 되고, 새 run + 새 200석이 생성되며 이전 run의 좌석과 섞이지 않음
- [x] `concertId`를 생략해도 시드된 콘서트로 정상 동작함
- [x] `requireSession()`이 유효/무효 세션 각각에 대해 예상대로 동작함(유효 시 세션 ID 반환, 무효 시 일관된 에러)

### E2E 테스트 (Playwright MCP)

- [x] 최초 접속 후 `fetch("/api/session", {method:"POST", body:{tier}})` 호출 시 쿠키가 자동 발급되는지 확인 — 단, 홈 페이지 UI는 아직 이 API를 호출하도록 연결돼 있지 않아(더미 데이터 단계) "티어 선택 버튼 클릭"이 아닌 브라우저 콘솔에서 직접 fetch로 검증. UI 연동은 이 API를 소비하는 이후 Task(007+) 범위
- [x] 쿠키 삭제(`context().clearCookies()`) 후 재시작 시 새 세션이 발급되는지 확인(DB 조회로 `sessionId`가 달라짐을 검증)
- [x] 동일 세션(쿠키 유지)으로 두 번째 요청을 보내도 같은 세션이 재사용되는지 확인(DB 조회로 `sessionId` 동일함 검증)
- [x] "다시 도전"(동일 세션 재시작) 시 이전 run이 `EXPIRED`로 바뀌고 새 `SimulationRun` + 200석이 생성되는지 DB 직접 조회로 확인(좌석맵 API가 아직 없어 — Task 009 — DB 조회로 대체, 문서에 명시된 대로)
- [x] 세션 쿠키가 `httpOnly: true`(스크립트로 `document.cookie`에 노출 안 됨 + `page.context().cookies()`로 `httpOnly:true`/`sameSite:"Lax"`/`secure:false`(dev) 직접 확인)임을 검증

## 변경 사항 요약

- **세션 쿠키 서명**: 외부 라이브러리(iron-session 등) 추가 없이 Node `crypto`의 HMAC-SHA256으로 직접 구현(`lib/session.ts`). 쿠키 값은 `${sessionId}.${signatureBase64url}` 형태 — `verify()`는 서명을 재계산해 `crypto.timingSafeEqual`로 비교하고, 길이가 다르면(길이가 다르면 `timingSafeEqual`이 예외를 던지므로) 비교 전에 먼저 길이를 확인해 안전하게 `null`을 반환한다. 실패 케이스(서명 불일치, 구분자 없음, 빈 문자열)는 전부 `getOrCreateSessionId()`가 조용히 새 세션 발급으로 폴백 — 예외로 요청이 죽지 않음.
- **런타임 결정: `middleware.ts` 미도입**: 세션 검증은 각 Route Handler가 `requireSession()`/`getOrCreateSessionId()`를 직접 호출하는 방식으로 확정했다. `middleware.ts`는 기본적으로 Edge 런타임에서 실행되는데, 이 프로젝트의 세션 서명은 Node `crypto`(HMAC/timingSafeEqual)를 쓰고 이후 Task(007~011)도 모두 Prisma로 DB를 조회해야 하므로 Edge 런타임과 계속 충돌한다. Route Handler는 기본이 Node.js 런타임이라 이 문제가 없고, `requireSession()`을 각 라우트 진입부에서 호출하는 것만으로 충분히 재사용 가능하다 — 별도 미들웨어 계층의 이점(요청이 라우트 코드에 도달하기 전 차단)보다 Edge/Node 런타임 불일치 리스크가 더 크다고 판단.
- **`SimulationRun` 리셋 시 상태값: `EXPIRED` 채택**: 스키마의 `SimulationRunStatus`에는 리셋(새 run이 이전 run을 대체)을 위한 전용 값이 없다(`ACTIVE`/`COMPLETED`/`EXPIRED` 3종). `COMPLETED`는 Task 011이 "실제 플로우로 종료된 run"에 쓸 값으로 예약해두는 게 맞다고 판단해, "다시 도전으로 대체됨"은 `EXPIRED`로 기록하기로 결정 — Task 011 구현 시 이 해석을 참고할 것.
- **세션 발급/시작을 하나의 트랜잭션으로 묶지 않은 이유**: `getOrCreateSessionId()`(쿠키 read/write, `cookies()` API)는 Prisma `$transaction` 콜백 밖에서 먼저 실행한다 — Next.js가 `cookies().set()`을 Route Handler 본문에서만 허용하고 임의의 비동기 콜백 내부에서는 허용하지 않기 때문. DB 쓰기(이전 run 종료 + 새 run 생성 + 200석 생성)만 `prisma.$transaction`으로 원자성을 보장한다.
- **좌석 생성 템플릿 일치**: `app/api/session/route.ts`의 `SEAT_ROWS`/`SEATS_PER_ROW`는 `prisma/seed.ts`와 동일한 10행(A~J) × 20석 상수를 그대로 사용 — 공유 함수로 추출하지 않고 각자 파일에 상수로 둔 이유는 seed 스크립트가 런타임 코드와 별도 실행 컨텍스트(빌드에 포함 안 됨)라 임포트 경로를 얽을 필요가 없다고 판단했기 때문. 값이 바뀌면 두 곳을 함께 수정해야 함을 각 파일에 주석으로 남겨둘 필요는 향후 리팩터링 시 고려.
- **`lib/test-db.ts` 실 구현**: Task 001의 스텁(`throw`)을 실제 Prisma client로 교체 — 별도의 테스트 전용 물리 DB(Neon 테스트 브랜치 등)는 아직 없어서, `lib/db.ts`와 동일한 `DATABASE_URL`(로컬 Postgres)에 연결하는 별도 `PrismaClient` 인스턴스를 반환한다. 기존 `lib/test-db.test.ts`의 "throw해야 한다" assertion은 더 이상 유효하지 않아 실제 연결 확인 테스트로 교체.
- **Vitest 환경변수 로딩**: Vitest는 `next dev`처럼 `.env.local`을 자동 로드하지 않아, `prisma.config.ts`와 동일한 패턴(`dotenv`의 `config({path:".env.local"})` → `config()`)으로 `vitest.setup.ts`를 추가하고 `vitest.config.ts`의 `test.setupFiles`에 등록했다. Vitest의 `setupFiles`는 테스트 모듈 임포트보다 먼저 실행되는 것이 보장되므로(반대로 스크립트 내 일반 `import`는 파일 상단에서 즉시 평가되어 이후의 `config()` 호출보다 먼저 실행돼버려 `DATABASE_URL`이 비어있는 채로 `lib/db.ts`가 초기화되는 문제가 있었다 — 임시 진단 스크립트에서 실제로 재현·확인함) 이 방식이 안전하다.
- **`next/headers`의 `cookies()` 모킹**: Vitest는 실제 Next.js 요청 스코프 밖에서 실행되므로 `cookies()`를 그대로 호출하면 예외가 난다. `lib/session.test.ts`/`app/api/session/route.test.ts` 양쪽에서 `vi.mock("next/headers", ...)`로 `get`/`set`만 지원하는 `Map` 기반 가짜 쿠키 스토어를 주입해 실제 서명/검증 로직은 그대로 실행하고 Next.js 런타임 의존성만 격리했다.
- **Route Handler 통합 테스트**: `app/api/session/route.test.ts`는 `POST()`를 `NextRequest`로 직접 호출하는 방식(실제 서버 기동 불필요)으로 실제 로컬 Postgres에 대해 실행되며, 각 테스트가 생성한 `SimulationRun`/`Seat`를 `afterEach`에서 정리해 DB에 잔여 데이터를 남기지 않는다.
- **검증**: `npx vitest run`(17 tests, 3 files 모두 통과), `npx tsc --noEmit`, `npm run lint` 모두 통과. dev server(`localhost:3000`)에 대해 Playwright MCP로 브라우저 `fetch()` 기반 E2E 확인(세션 발급/재사용/리셋/쿠키 삭제 후 재발급/`httpOnly` 속성)까지 마쳤고, E2E 중 생성된 `SimulationRun`/`Seat` 행은 스크립트로 정리했다.
- **알려진 갭 (다음 Task 인계 사항)**: (1) 홈 페이지 UI가 아직 이 API를 호출하지 않음 — "예매하기" 클릭이 `POST /api/session`을 트리거하도록 연결하는 작업은 Task 008(대기열) 또는 프론트 연동을 담당하는 후속 Task 범위. (2) `requireSession()`은 쿠키 서명 유효성만 확인하고 DB에 해당 세션의 `ACTIVE` `SimulationRun`이 실제로 존재하는지는 확인하지 않는다 — Task 007~011에서 각 라우트가 필요에 따라 직접 조회해야 함(의도적으로 얇게 유지: 세션 검증과 "이 세션에 활성 run이 있는가"는 별개 질문이라고 판단).
