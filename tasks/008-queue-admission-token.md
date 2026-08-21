# Task 008: 대기열 순번 · 입장 토큰 API

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 008 항목 업데이트

## 개요

Phase 3 우선순위 작업(F002 서버 검증, F003 대기열 순번, F004 입장 토큰) — `app/api/queue/route.ts`는 현재 `501 not_implemented`
스텁이고, `app/queue/page.tsx`는 `getDummyQueuePosition()` 더미 데이터를 렌더링한다. 이 Task는 이 둘을 실제 대기열 진입/폴링 API와
연결하고, 순번이 0에 도달했을 때 좌석 선택 페이지로의 **입장 토큰**을 발급·검증하는 경로를 만든다.

**범위 경계 (ROADMAP 명시):** 대기열 순번 감소 계산 자체(`computeQueuePosition`)는 Task 007에서 이미 순수 함수로 구현 완료됐다 —
이 Task는 그 함수를 호출하는 **오케스트레이션**(QueueEntry 조회/생성/갱신, 토큰 발급·검증, API 라우트 연결)만 담당한다. hold 만료·좌석
선점(F005~F008 실행)은 Task 009, 결제 실패 분기(F009/F010)는 Task 010의 몫이며 이 Task에서는 건드리지 않는다.

**설계 결정:**

- **대기열 (재)진입** — `POST /api/queue`: 세션의 활성 `SimulationRun`에 대해 기존 `WAITING` `QueueEntry`가 있으면 `EXPIRED`로
  전환하고 새 `QueueEntry`(`position = SimulationConfig.virtualQueueSize`, `joinedAt = now`)를 생성한다. 기존 `WAITING` 엔트리를
  대체한 경우(=새로고침/재진입)에만 `queue_reset` 판단 이벤트를 기록한다 — 최초 진입은 리셋이 아니므로 기록하지 않는다.
  `Concert.openAt` 이전 요청은 거부(F002 서버 측 검증 — 버튼 비활성화만으로는 우회 가능하므로 API 레벨 차단 필수).
- **순번 폴링** — `GET /api/queue`: 세션의 최신 non-`EXPIRED` `QueueEntry`를 조회해 `computeQueuePosition`(Task 007, 이미 구현됨)에
  `elapsed = computeElapsedTime({ since: joinedAt, now })`을 넘겨 순번을 계산한다. 계산 결과 `position <= 0`이고 상태가 아직
  `WAITING`이면, **그 폴링 요청 안에서** 상태를 `ADMITTED`로 전환하고 랜덤·비추측 가능한 `admissionToken`(`sessionId` 바인딩)을
  발급해 `QueueEntry.admissionToken`에 저장 — 응답에 포함한다.
- **입장 토큰 검증 (1회성)** — `/seats` 접근 가드(`lib/queue.ts`의 `requireAdmission()`)는 세션의 활성 run에 `status === ADMITTED`인
  `QueueEntry`가 있는지로 1차 판정(무효 시 `/queue`로 리디렉션 — 새치기 방지의 핵심). 최초 진입은 폴링 응답이 준 `admissionToken`을
  쿼리 파라미터(`/seats?admissionToken=...`, `?tier=` 기존 패턴과 동일한 방식 — Task 005-1)로 실어 오며, 이때 토큰이
  `QueueEntry.admissionToken`과 정확히 일치하는지 검증한 뒤 **즉시 `null`로 무효화**한다(1회성 — 위조/재사용 토큰 거부). 이후
  새로고침 등 정상 재방문은 토큰 없이도 `status === ADMITTED`만으로 통과시켜, 정상적인 좌석 선택 플로우 중 새로고침까지 차단하지
  않는다.
- **관측 데이터 (신규 공통 인프라)** — `lib/session-result.ts`(신규)를 이 Task에서 처음 도입한다: 세션당 1개의 `SessionResult` 행을
  upsert하며 `stageTimings`/`events` JSON 컬럼에 증분 기록하는 헬퍼. `stageTimings.queue.enteredAt`은 최초 진입 시, `exitedAt`은
  토큰 검증 성공(=좌석 페이지 진입) 시 기록한다. Task 009/010이 동일 헬퍼를 재사용해 각자의 stage/event를 기록하고, Task 011은 이
  행을 **읽기 전용**으로 집계·피드백 매핑만 한다 (ROADMAP "관측 데이터 원칙").

## 관련 파일

- `app/api/queue/route.ts` — `POST`(진입/재진입) + `GET`(폴링) 핸들러 구현, `501` 스텁 제거 (수정)
- `app/api/queue/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/queue.ts` — `joinQueue`, `pollQueue`, `requireAdmission`, `redeemAdmissionToken` 오케스트레이션 함수 (신규, `lib/tick.ts`와
  같은 위치의 "caller" 레이어 — `lib/simulation.ts`의 순수 함수를 호출)
- `lib/queue.test.ts` — 위 함수들의 단위/통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/session-result.ts` — `SessionResult` upsert + `stageTimings`/`events` 증분 기록 공용 헬퍼, Task 009/010 재사용 전제로 설계
  (신규)
- `lib/session-result.test.ts` — 단위 테스트 (신규)
- `lib/simulation.ts` — 참고용(수정 없음): `computeElapsedTime`, `computeQueuePosition` 재사용
- `lib/session.ts` — 참고용(수정 없음): `requireSession()` 재사용 (모든 신규 라우트에서 세션 검증)
- `lib/types.ts` — `POST /api/queue` 요청/응답 타입 추가(현재 `QueuePollResponse`는 `GET` 응답만 정의됨), 필요 시 조정 (수정)
- `app/queue/page.tsx` — `getDummyQueuePosition()` 제거, 실제 폴링으로 교체 (수정)
- `app/queue/QueuePoller.tsx` — 2초 간격 `GET /api/queue` 폴링 + `admissionToken` 수신 시 `/seats?admissionToken=...`로 이동하는
  클라이언트 컴포넌트 (신규, `app/seats/SeatsViewLoader.tsx`/`SeatsView.tsx` 서버·클라이언트 분리 패턴 참고)
- `app/seats/page.tsx` — `requireAdmission()` 가드 적용, 무효 시 `/queue` 리디렉션 (수정) — **Next.js 16에서 페이지 컴포넌트
  `searchParams`가 `Promise`로 바뀌었는지 `node_modules/next/dist/docs/`에서 확인 후 반영** (CLAUDE.md 경고 사항)
- `prisma/schema.prisma` — **계획 변경(수정)**: `QueueEntry.status/admissionToken/joinedAt`, `SimulationConfig.virtualQueueSize/admissionRatePerSec`는
  기존 필드 그대로 사용했으나, `SessionResult`는 구현 중 세션당 1행 upsert가 불가능함을 발견해 `sessionId`에 `@unique` 추가 +
  `outcome` nullable화 + `stageTimings`/`events`/`contentionLosses`에 기본값 부여로 변경 (아래 변경 사항 요약 참조)
- `prisma/migrations/20260820171522_session_result_progressive_recording/migration.sql` — 위 스키마 변경의 마이그레이션 (신규)
- `app/page.tsx` — **계획에 없던 추가 수정**: "Book Now" 클릭 시 `POST /api/session`을 호출해 `SimulationRun`을 실제로
  생성하도록 연결 (기존에는 어떤 페이지도 이 API를 호출하지 않아, 대기열 진입 API가 연결할 활성 run이 애초에 존재하지 않았음)

## 선행 조건

- Task 002 (스키마: `QueueEntry`, `SimulationConfig.virtualQueueSize`, `SessionResult`)
- Task 006 (세션 발급, `SimulationRun` 생성 — 대기열 진입 대상 run이 있어야 함)
- Task 007 (`computeQueuePosition`, `computeElapsedTime` 순수 함수)

## 수락 기준

- [x] `Concert.openAt` 이전 `POST /api/queue` 요청은 거부됨 (F002 서버 측 검증)
- [x] `POST /api/queue`: 최초 진입 시 `QueueEntry` 생성(`position = virtualQueueSize`, `joinedAt = now`)
- [x] `POST /api/queue`: 기존 `WAITING` 엔트리가 있는 재진입은 그 엔트리를 `EXPIRED`로 전환 + 새 엔트리 생성 + `queue_reset` 판단
      이벤트 기록 (최초 진입은 이벤트 기록 안 함)
- [x] `GET /api/queue`: `computeQueuePosition` 기반으로 경과 시간에 따라 순번이 감소해 응답됨
- [x] `GET /api/queue`: 순번이 0에 도달하면 그 요청에서 정확히 1회 `status: ADMITTED` 전환 + `admissionToken` 발급(랜덤·비추측
      가능·`sessionId` 바인딩)이 일어나고, 이후 폴링은 재발급하지 않음
- [x] `/seats` 접근 가드: `admissionToken` 없이 또는 위조/타 세션 토큰으로 접근 시 `/queue`로 리디렉션
- [x] `admissionToken`은 최초 검증 성공 시 무효화(`null`)되어 재사용(같은 토큰으로 두 번째 최초-진입 시도) 불가
- [x] 토큰 무효화 이후에도, 이미 `ADMITTED`인 세션의 `/seats` 정상 재방문(새로고침 등)은 차단되지 않음
- [x] 대기열 진입 시각·입장 토큰 발급 시각이 `SessionResult.stageTimings.queue`에 기록됨
- [x] `queue_reset` 판단 이벤트가 `SessionResult.events`에 기록됨
- [x] `app/queue/page.tsx`, `app/seats/page.tsx` 진입 가드가 더미 데이터 대신 실 API를 사용
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] ~~`lib/types.ts`: `POST /api/queue` 요청/응답 타입 정의~~ — 기존 `QueuePollResponse`가 두 응답 모두를 정확히 표현해
      재사용, 신규 타입 불필요 (별도 계획 변경 없이 판단만 확정)
2. [x] `lib/session-result.ts` 신규: `SessionResult` upsert(세션당 1행) + `recordStageEntered`/`recordStageExited`/`recordJudgmentEvent`
      헬퍼 — Task 009/010이 그대로 재사용할 수 있는 시그니처로 설계
3. [x] `lib/queue.ts`: `joinQueue(sessionId, runId, now)` — `openAt` 검증, 기존 `WAITING` 엔트리 처리, 신규 생성, `queue_reset`
      이벤트 기록을 하나의 트랜잭션으로 묶음
4. [x] `lib/queue.ts`: `pollQueue(sessionId, runId, now)` — 최신 엔트리 조회 → `computeQueuePosition` 호출 → 0 도달 시
      `ADMITTED` 전환 + 토큰 발급을 원자적으로 처리 (동시 폴링 요청이 토큰을 중복 발급하지 않도록 Task 007 `lib/tick.ts`의 락 패턴
      참고)
5. [x] `lib/queue.ts`: `requireAdmission(sessionId, runId)` — `status === ADMITTED` 여부만으로 판정하는 durable 가드
6. [x] `lib/queue.ts`: `redeemAdmissionToken(sessionId, runId, token)` — 토큰 일치 시 `null`로 무효화하는 1회성 검증
7. [x] `app/api/queue/route.ts`: `requireSession()` + 위 함수들을 연결해 `POST`/`GET` 핸들러 구현, `501` 스텁 제거
8. [x] `app/seats/page.tsx`: `searchParams`에서 `admissionToken` 읽어 `redeemAdmissionToken` → 실패/부재 시 `requireAdmission`
      확인 → 둘 다 실패하면 `/queue`로 리디렉션 (Next.js 16 `searchParams` API를 `node_modules/next/dist/docs/`에서 먼저 확인)
9. [x] `app/queue/QueuePoller.tsx` 신규 클라이언트 컴포넌트: 2초 간격 `GET /api/queue` 폴링, `admissionToken` 수신 시
      `/seats?admissionToken=...`로 이동
10. [x] `app/queue/page.tsx`: `getDummyQueuePosition()` 제거, `QueuePoller` 연결
11. [x] 타입 체크·린트 통과 확인
12. [x] Vitest 단위/통합 테스트 작성 (아래 테스트 체크리스트 참조)
13. [x] Playwright MCP로 실제 dev 서버를 구동해 E2E 플로우 검증 (별도 스펙 파일로 커밋하지 않음 — 기존 Task들과 동일하게
      대화형 검증만 수행, 커밋되는 자동화 테스트는 Vitest만 유지)

## 테스트 체크리스트

### 단위 테스트 (Vitest)

- [x] `joinQueue`: 최초 진입 시 `position = virtualQueueSize`, `joinedAt` 기록
- [x] `joinQueue`: `openAt` 이전 호출 거부
- [x] `joinQueue`: 기존 `WAITING` 엔트리 재진입 시 `EXPIRED` 전환 + 신규 생성 + `queue_reset` 이벤트 기록
- [x] `joinQueue`: 최초 진입은 `queue_reset` 이벤트를 기록하지 않음
- [x] `pollQueue`: 경과 시간에 따른 순번 감소 반영 (`computeQueuePosition` 위임 확인)
- [x] `pollQueue`: 0 도달 시 `ADMITTED` 전환 + `admissionToken` 발급, 재폴링 시 토큰 재발급되지 않음
- [x] `requireAdmission`: `ADMITTED` 엔트리 존재/부재 각각 정확히 판정
- [x] `redeemAdmissionToken`: 정상 토큰 검증 성공 + 즉시 무효화, 위조/타 세션 토큰 거부, 이미 무효화된 토큰 재사용 거부
- [x] `session-result.ts`: `stageTimings`/`events` 증분 기록이 기존 값을 덮어쓰지 않고 누적됨
- [x] (추가) `session-result.ts`: 동일 세션에 대한 최초 동시 쓰기 레이스(React StrictMode 이중 effect 등)가 예외 없이 처리됨 —
      구현 중 실제로 발견된 회귀([변경 사항 요약](#변경-사항-요약) 참조)

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `POST /api/queue` → `GET /api/queue` 폴링 전 과정이 실제 DB 상태와 일치
- [x] **동시성**: 동일 `QueueEntry`에 대해 병렬 `GET /api/queue` 폴링이 `admissionToken`을 중복 발급하지 않음
- [x] 세션 미검증(쿠키 없음/위조) 요청이 거부됨

### E2E 검증 (Playwright MCP, 실제 dev 서버 대화형 구동 — Task 006/007과 동일하게 커밋되는 스펙 파일 없음)

- [x] 대기열 진입 → 순번 감소 관찰 → 토큰 발급 → 좌석 페이지 자동 이동
- [x] 새로고침 시 순번이 초기값으로 리셋됨 (경고 배너 문구와 실제 동작 일치 — 459 → 리로드 후 469로 재시작 확인)
- [x] 입장 토큰 없이 `/seats` 직접 접근 시 `/queue`로 리디렉션 (307 확인)
- [x] 유효하지 않은/타 세션 토큰으로 `/seats` 접근 시 리디렉션 (307 확인)
- [x] 토큰으로 정상 진입 후 `/seats` 새로고침 시 리디렉션되지 않고 유지됨 (이미 소비된 토큰이어도 `requireAdmission` durable
      가드로 통과)
- [x] `openAt` 이전 대기열 진입 시도 시 서버가 거부함 (자동화된 route 테스트로 검증 — 별도 미래 콘서트 openAt으로 재현)

## 변경 사항 요약

- **`SessionResult` 스키마를 "최종 1회 기록"에서 "세션당 1행 progressive upsert"로 변경**: 원래 스키마는 `outcome`/`contentionLosses`/`events`가 모두 `NOT NULL`이고 `sessionId`에 유니크 제약이 없어, Task 011이 결과를 확정할 때 한 번만 행을 만드는 모델이었다. 이 Task부터 `stageTimings`/`events`를 발생 시점에 증분 기록해야 하는데(ROADMAP "관측 데이터 원칙"), 그러려면 세션당 정확히 1행을 안전하게 upsert할 수 있는 유니크 키가 필요했다. `sessionId`에 `@unique` 추가, `outcome`을 nullable로(아직 결정되지 않은 상태를 표현), `stageTimings`/`events`/`contentionLosses`에 기본값(`{}`/`[]`/`0`)을 부여하는 마이그레이션(`20260820171522_session_result_progressive_recording`)을 추가했다. `npx prisma migrate dev`가 비-TTY 환경에서 인터랙티브 확인을 요구해 실패해서, 기존 `20260723001110_init` 마이그레이션과 동일한 SQL 스타일로 마이그레이션 파일을 직접 작성한 뒤 `prisma migrate deploy`로 적용했다.
- **`lib/session-result.ts` 신규 — Task 009/010이 재사용할 공용 기록 레이어**: `recordStageEntered`/`recordStageExited`/`recordJudgmentEvent` 3개 함수가 `SessionResult`를 upsert하며 JSON 컬럼에 증분 기록한다. `recordStageEntered`는 이미 `enteredAt`이 있으면 덮어쓰지 않아 재진입(새로고침) 시에도 최초 진입 시각을 보존한다.
- **동시성 버그를 실제 브라우저 E2E 검증 중 발견하고 수정함 (단위 테스트 없이 넘어갔다면 놓쳤을 사례)**: `getOrCreate`의 `sessionResult.upsert()`가 Postgres의 원자적 `INSERT ... ON CONFLICT`가 아니라 클라이언트 사이드 SELECT-then-write로 동작해, 같은 `sessionId`에 대한 두 개의 동시 최초 쓰기(React StrictMode가 개발 모드에서 effect를 이중 호출하며 `POST /api/queue`를 거의 동시에 두 번 보냄)가 둘 다 "행 없음"을 보고 둘 다 `create()`를 시도했다 — 패자가 `P2002` 유니크 제약 위반으로 500을 던졌다. 이 레이스를 재현하는 Vitest 테스트(`lib/session-result.test.ts`의 "handles two concurrent first-writes...")를 먼저 작성해 실패를 확인한 뒤, `getOrCreate`가 `P2002`를 잡아 `findUniqueOrThrow`로 폴백하도록 고쳤다. StrictMode가 아니어도(다중 탭, 네트워크 재시도 등) 실제로 발생할 수 있는 레이스라 프로덕션 정합성 수정으로 유지한다.
- **`lib/queue.ts` 신규 — 대기열 진입/폴링/입장 토큰 오케스트레이션**: `joinQueue`는 기존 `WAITING` 엔트리가 있으면 그 엔트리의 **저장된 초기값이 아니라 재진입 시점까지 실제로 감쇠한 위치**(`computeQueuePosition`으로 재계산)를 `queue_reset` 이벤트의 `positionBeforeReset`에 기록한다 — 사용자가 실제로 잃은 진행분을 리포트에 정확히 반영하기 위함. `pollQueue`는 `lib/tick.ts`와 동일한 `SELECT ... FOR UPDATE` + 트랜잭션 패턴으로 순번 0 도달 시 정확히 1회만 `admissionToken`을 발급한다.
- **입장 토큰 검증을 "1회성 소비"와 "재방문 허용"으로 분리**: `requireAdmission()`(세션의 활성 run에 `ADMITTED` 엔트리가 있는지)이 `/seats` 접근의 실제 게이트이고, `redeemAdmissionToken()`은 최초 진입 시 URL의 `?admissionToken=`을 검증·무효화하는 부가 절차다. 이렇게 분리한 덕에 토큰이 이미 소비된 뒤에도 `/seats` 새로고침이 깨지지 않는다 — 브라우저로 직접 재현해 확인함(아래 검증 항목 참조).
- **계획에 없던 `app/page.tsx` 수정**: Task 006이 `POST /api/session`을 구현했지만 어떤 페이지도 실제로 호출하지 않고 있었다(홈 페이지는 여전히 더미 콘서트로 `/queue?tier=...`에 쿼리 파라미터만 넘겼음). 이 상태로는 대기열 진입 API가 연결할 `SimulationRun`이 존재하지 않아 이 Task가 동작할 수 없었다. "Book Now" 클릭 시 `POST /api/session`을 호출해 실제 run을 만들도록 연결했고, 티어는 이제 `SimulationRun.tier`에서 서버가 조회하므로(D-2) `?tier=` 쿼리 파라미터는 제거했다(다른 페이지가 참조하지 않음을 확인).
- **검증**: `npx tsc --noEmit`, `npm run lint`(`eslint .`) 모두 통과. `npx vitest run` 67 tests / 8 files 전부 통과 (`lib/session-result.test.ts` 5건, `lib/queue.test.ts` 16건 — 동시성 케이스 포함, `app/api/queue/route.test.ts` 7건, 기존 파일 39건). Playwright MCP로 실제 dev 서버를 구동해 전체 플로우(홈 → 세션 시작 → 대기열 진입 → 실시간 순번 감소 관찰(500 → 459) → 100초 경과 후 자동 ADMITTED 전환 → 토큰과 함께 `/seats` 자동 이동 → 좌석 구역 선택 화면 렌더링), 새로고침 시 순번 리셋(459 → 469로 재시작), 토큰 소비 후 `/seats` 새로고침 시 유지, 세션 없이/위조 토큰으로 `/seats` 접근 시 307 리디렉션까지 확인. 테스트/수동 검증 중 DB에 남은 데이터는 모두 정리함.
- **다음 Task 인계 사항**: (1) Task 009는 `requireAdmission`을 다시 구현할 필요 없이 `lib/queue.ts`에서 그대로 import해 좌석 API 가드에도 적용할 수 있다. (2) Task 009/010은 `lib/session-result.ts`의 `recordStageEntered`/`recordStageExited`/`recordJudgmentEvent`를 그대로 재사용하면 된다 — `SessionResult` upsert/동시성 처리가 이미 돼 있다. (3) 홈 페이지는 여전히 `getDummyConcert()`(가짜 60초 카운트다운)를 쓰고 실제 `Concert.openAt`과 무관하다 — 실 콘서트 데이터로 교체하는 작업은 이 Task 범위 밖으로 남겨둠.
