# Task 010: 개발/테스트 전용 시간 가속 유틸 (ROADMAP D-7)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` D-7 항목 업데이트

## 개요

ROADMAP D-7: tick-on-request 기반 변경 사항(D-4/D-6 등)을 수동으로 검증하려면 매번 실제 오픈 시각과 실제
대기열 감소 시간을 기다려야 해 개발 사이클이 느려지는 문제 발견 → dev 환경 전용으로 시뮬레이션 시각 필드
(`Concert.openAt`, `QueueEntry.joinedAt`, `SimulationRun.lastTickAt`)를 인위적으로 밀어넣는 유틸 추가.

**범위 경계 (ROADMAP D-7 명시):** `lib/simulation.ts`의 tick 계산 로직(`computeElapsedTime`,
`computeQueuePosition`, `computeBotClaimCount`, `findExpiredHolds`)은 순수 함수로 `now`와 저장된 시각의 차이만
계산한다 — 이 파일은 전혀 건드리지 않는다. 저장된 시각 자체를 조작해 그 순수 함수가 자연스럽게 "이미
경과함" 결과를 내도록 하는 것이 이 Task의 전부다.

**설계 결정:**

- **API 엔드포인트만 채택, CLI 스크립트는 도입하지 않음** — D-7의 목적 자체가 "브라우저에서 수동 검증
  중인 개발자"의 사이클 단축(CLAUDE.md 워크플로우: `npm run dev` + 브라우저 테스트)이라, 이미 브라우저에
  있는 서명된 세션 쿠키(`lib/session.ts::requireSession()`)를 그대로 재사용하는 편이 CLI가 별도로 세션
  식별 방식을 재구현하는 것보다 낫다. 이 저장소에는 `scripts/` 디렉토리나 CLI 부트스트랩 전례가 전혀
  없어, 새 인프라를 만드는 비용이 이 dev 편의 기능의 가치에 비해 과했다.
- **`POST /api/dev/timewarp` 하나의 엔드포인트, 세 필드 모두 optional & 조합 가능** — `openInMs`(부호로
  양방향 표현: 양수=아직 미래 오픈, 음수=이미 오픈), `queueRewindMs`(raw) 또는 `queueConsumedPct`(0-100,
  `admissionRatePerSec` 기반 편의 계산, 서로 배타적), `lastTickRewindMs`(raw). 한 요청에서 여러 필드를
  동시에 지정해 "오픈 30초 전 + 대기열 90% 소진" 같은 복합 시나리오를 한 번에 재현할 수 있다.
- **얇은 라우트 + 뚱뚱한 lib 모듈** — `lib/queue.ts`/`lib/seats.ts`와 동일한 컨벤션. `lib/dev-timewarp.ts`가
  실제 Prisma mutation을 소유하고, `getActiveRun()`(`lib/queue.ts`, 재구현 없이 재사용)으로 세션의
  run/concert/config를 조회한다. 세 필드 mutation은 하나의 `prisma.$transaction`으로 묶어 조합 시나리오가
  "반쯤만 적용"되는 상태를 방지한다.
- **프로덕션 안전장치** — `POST` 핸들러 맨 첫 줄에서 `NODE_ENV === "production"`이면 즉시 404
  (`lib/db.ts`/`lib/session.ts`와 동일한 인라인 체크 스타일, 새 추상화 없음). Next.js는 런타임 env와 무관하게
  `app/api/*` 라우트 파일을 프로덕션 빌드에 항상 포함시키므로 "라우트가 존재하지 않음" 자체는 별도 빌드
  툴링 없이는 불가능 — ROADMAP D-7이 "라우트가 존재하지 않거나 **항상 404**"를 대안으로 명시하고 있어
  런타임 게이트로 충분히 요건을 충족한다. 라우트 파일 상단 주석에 이 사실을 명시해 뒀다.
- **`Concert.openAt` 공유 row 리스크는 스키마 변경 없이 가시성으로만 완화** — `Concert`는
  `prisma.concert.findFirst()`로 선택되는 단일 row라 `openInMs`가 그 concert를 가리키는 모든 세션에 영향을
  준다. 스코핑(concert 복제 등)은 데이터 모델 변경이라 이 dev 편의 유틸의 범위를 벗어난다고 판단해
  시도하지 않았다. 대신 `concert.applied === true`인 모든 응답에 `warnings` 배열로 매번 경고를 포함시킨다.
- **`queueConsumedPct`의 기준값은 `QueueEntry.position`** — `pollQueue()`가 DB의 `position`을 갱신하지 않고
  매 폴링마다 경과시간으로 재계산하는 방식(`lib/queue.ts` 확인)이라, `position`은 join 시점의 "초기 순번"을
  그대로 보관한다. 이를 그대로 목표 % 계산의 기준값으로 재사용했다.

## 관련 파일

- `lib/dev-timewarp.ts` — `applyTimewarp({ sessionId, openInMs?, queueRewindMs?, queueConsumedPct?,
  lastTickRewindMs?, now })`: 세 시각 필드 mutation을 트랜잭션으로 묶는 fat-lib 모듈 (신규)
- `app/api/dev/timewarp/route.ts` — `POST` 전용 thin 라우트: NODE_ENV 게이트 → `requireSession` → body
  검증(숫자 타입, `queueRewindMs`/`queueConsumedPct` 동시 지정 거부) → `applyTimewarp` 호출 → 응답 매핑 (신규)
- `app/api/dev/timewarp/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/types.ts` — `TimewarpRequest`/`TimewarpConcertResult`/`TimewarpQueueResult`/
  `TimewarpSimulationRunResult`/`TimewarpResponse` 추가 (수정)
- `lib/simulation.ts` — 참고용(수정 없음): tick 계산 순수 함수, 이 Task가 절대 건드리지 않는 대상
- `lib/queue.ts` — 참고용(수정 없음): `getActiveRun` 재사용

## 선행 조건

- Task 006 (세션/`SimulationRun` 생성), Task 007 (tick 엔진), Task 008 (`getActiveRun`)

## 수락 기준

- [x] `NODE_ENV === "production"`이면 세션/body 상태와 무관하게 항상 404
- [x] `openInMs`: 양수면 `Concert.openAt`이 미래로, 음수면 과거로 정확히 `now + openInMs`에 설정됨
- [x] `queueRewindMs`: `QueueEntry.joinedAt`이 정확히 `now - queueRewindMs`로 설정됨
- [x] `queueConsumedPct`: 계산된 `joinedAt`으로 실제 `pollQueue()`를 호출하면 그 비율만큼 소진된 position이
      나옴 (편의 공식이 `lib/simulation.ts`의 실제 공식과 일치함을, 그 파일을 건드리지 않고 증명)
- [x] `queueRewindMs`와 `queueConsumedPct` 동시 지정 시 400 `AMBIGUOUS_QUEUE_PARAMS`
- [x] 활성 `QueueEntry` 없이 queue 필드만 지정해도 요청 전체가 실패하지 않고 `queue.applied: false`로
      부분 응답, 나머지 필드는 정상 적용
- [x] `lastTickRewindMs`: `SimulationRun.lastTickAt`을 `now - X`로 설정한 뒤 실제 `advanceTick()`을 호출하면
      기대한 경과시간이 반영됨 (tick 계산 로직 자체는 건드리지 않았음을 증명)
- [x] 세 필드를 한 요청에 조합해도 모두 원자적으로 적용됨
- [x] 세션 없음(401), 활성 run 없음(404 `NO_ACTIVE_RUN`) 가드 동작
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `lib/types.ts`: `TimewarpRequest`/`TimewarpResponse` 계열 타입 추가
2. [x] `lib/dev-timewarp.ts`: `applyTimewarp()` — `getActiveRun` 조회 → 세 필드 mutation을
      `prisma.$transaction`으로 묶어 실행 → 구조화된 결과 반환
3. [x] `app/api/dev/timewarp/route.ts`: NODE_ENV 게이트 → `requireSession` → body 검증 → `applyTimewarp` 호출
      → 응답 매핑
4. [x] `app/api/dev/timewarp/route.test.ts`: 12개 시나리오(아래 테스트 체크리스트) 작성
5. [x] 타입 체크·린트 통과 확인
6. [x] `docs/ROADMAP.md` D-7 체크박스 갱신

## 테스트 체크리스트

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `NODE_ENV=production`이면 세션/body와 무관하게 404
- [x] 세션 쿠키 없으면 401
- [x] 활성 `SimulationRun` 없으면 404 `NO_ACTIVE_RUN`
- [x] `openInMs` 양수 → `Concert.openAt`이 미래로 정확히 설정됨 (F002 경계값 시나리오)
- [x] `openInMs` 음수 → `Concert.openAt`이 과거로 설정됨 (이미 오픈 상태)
- [x] `queueRewindMs` → `QueueEntry.joinedAt`이 정확히 `now - X`
- [x] `queueConsumedPct: 90` → 실제 `pollQueue()` 결과가 ~90% 소진과 일치
- [x] 활성 큐 엔트리 없이 queue 필드만 지정 → 부분 적용(`NO_ACTIVE_QUEUE_ENTRY`), 나머지 필드는 정상 적용
- [x] `queueRewindMs`+`queueConsumedPct` 동시 지정 → 400 `AMBIGUOUS_QUEUE_PARAMS`
- [x] `lastTickRewindMs` → 실제 `advanceTick()` 호출 시 기대한 만큼 봇 클레임 발생
- [x] 세 필드 조합 요청이 원자적으로 모두 적용됨
- [x] 숫자가 아닌 필드 값 → 400 `INVALID_BODY`

## 변경 사항 요약

- **플랜 대비 편차 없음**: 계획 문서(`/Users/hunji/.claude/plans/docs-roadmap-md-d-7-lively-storm.md`)의 설계를
  그대로 구현했다 — API 엔드포인트만 채택, `openInMs` 부호 단일 필드, `queueRewindMs`/`queueConsumedPct`
  배타적 편의 필드, `lastTickRewindMs`, 트랜잭션 원자성, 런타임 404 게이트, 공유-row 경고, 12개 테스트
  시나리오(플랜의 11개 + `INVALID_BODY` 케이스 1개 추가) 모두 계획대로 구현·통과.
- **다음 Task로 미룬 것**: 없음 — 이 Task는 자기완결적인 dev 전용 유틸로, 프로덕션 코드 경로를 전혀
  건드리지 않는다.
- **리스크**:
  1. `Concert.openAt`이 공유 row라, 동일 concert를 가리키는 여러 세션이 동시에 테스트 중이면 서로
     영향을 준다 — 응답의 `warnings`로만 완화, 실질적 차단은 하지 않음 (설계상 의도적 결정, 위 참고).
  2. 브라우저/curl을 통한 실제 dev 서버 대화형 검증은 이번 세션에서 권한이 거부되어 수행하지 못했다 —
     `npx tsc --noEmit`, `npm run lint`, `npx vitest run`(109 tests / 12 files, 신규 12건 포함) 전부
     통과했지만, 실제 브라우저 폴링 흐름(`/queue`, `/seats`)에서 시간 조작 후 UI가 기대대로 반응하는지는
     아직 수동으로 확인되지 않았다. 다음에 이어서 작업할 때 `npm run dev` 실행 후
     `fetch("/api/dev/timewarp", {...})`로 직접 확인 권장.
  3. `queueConsumedPct`는 `admissionRatePerSec === 0`인 티어에서 400 `INVALID_CONFIG`를 반환하도록
     방어했지만, 현재 시드 데이터(SMALL/MEDIUM/MEGA)는 모두 0보다 크므로 이 분기는 테스트로 직접
     커버하지 않았다.
