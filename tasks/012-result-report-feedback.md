# Task 011: 결과 리포트 집계·피드백 API (F011)

> 파일명은 `012-`로 시작하지만 ROADMAP.md 기준으로는 **Task 011**이다. `011-` 번호는 이미
> `tasks/011-queue-arrival-rate-position.md`(D-4 post-hoc 수정 문서)가 선점하고 있어, 새 충돌을
> 만들지 않기 위해 tasks/ 디렉토리의 다음 순번(012)을 파일명으로 쓰고 제목만 ROADMAP과 일치시켰다.

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 011 항목 업데이트

## 개요

Phase 3 마지막 기능 작업(F011) — Task 006~010이 이미 기록해 둔 `SessionResult.stageTimings`/
`contentionLosses`/`events`를 **집계**하고, `outcome`을 처음으로 확정하며, 판단 이벤트를 정해진 코칭
문구에 매핑한다(ROADMAP "관측 데이터 원칙": 이 Task는 새 타이밍/이벤트를 기록하지 않는다). 결과
페이지(`app/result/page.tsx`)의 더미 데이터(`getDummySessionResult`, `?outcome=` 쿼리 오버라이드)를
실 데이터로 교체하는 것이 최종 목표.

**범위 경계:** `lib/session-result.ts`의 쓰기 헬퍼(`recordStageEntered`/`recordStageExited`/
`recordJudgmentEvent`/`incrementContentionLosses`)는 이미 완성되어 있고 Task 008~010이 호출부다 —
이 Task는 그 결과물을 **읽기만** 한다. 새로 쓰는 유일한 필드는 `SessionResult.outcome`
(Task 010이 명시적으로 "여기서 쓰지 않는다"고 남긴 필드, 이 Task가 첫 writer)과, 부수적으로
`SimulationRun.status`를 `COMPLETED`로 전이시키는 것(아래 설계 결정 참조 — 지금까지 어떤 Task도
`COMPLETED`를 쓴 적이 없어 `ACTIVE`/`EXPIRED` 두 값만 실제로 쓰이고 있었다).

## 관련 파일

- `lib/result.ts` — `aggregateSessionResult({ sessionId, now })`(메인 진입점), `determineOutcome`(순수
  함수), `buildFeedback`(순수 함수), `TIER_BENCHMARKS`(상수), `evaluateBenchmarks`(순수 함수) (신규)
- `lib/result.test.ts` — 위 순수 함수 단위 테스트 + `aggregateSessionResult` 통합 테스트 (신규)
- `app/api/result/route.ts` — `GET` 핸들러: `requireSession` → `aggregateSessionResult` 호출 →
  `SessionResultResponse` 반환 (신규)
- `app/api/result/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/session-result.ts` — 읽기 헬퍼 `getSessionResultRow(db, sessionId)` 추가(`stageTimings`/
  `contentionLosses`/`events`/`outcome` 전체 반환, 없으면 `null` — `getSessionEvents`처럼 부작용 없음)
  (수정)
- `lib/session-result.test.ts` — 위 함수 테스트 (수정)
- `app/api/session/route.ts` — 새 런 생성 트랜잭션 안에서 `resetSessionResult` 호출 추가(D-8) (수정)
- `app/api/session/route.test.ts` — 재시작 시 `SessionResult` 리셋 검증 테스트 추가 (수정)
- `app/result/page.tsx` — `getDummySessionResult`/`?outcome=` 오버라이드/로컬 `FAILURE_FEEDBACK` 제거,
  `aggregateSessionResult` 직접 호출(Server Component — `app/booking/page.tsx`처럼 lib 함수를 직접
  호출, 자기 자신의 API 라우트를 fetch하지 않음)로 교체. `OUTCOME_META`(outcome별 headline/설명)는
  이벤트 단위가 아니라 outcome 단위 정적 카피라 그대로 유지 (수정)
- `app/booking/page.tsx` — hold 없음 가드 분기 수정: `getOwnedHold`가 `null`이면서
  `stageTimings.seat_selection.exitedAt`이 존재하면(= 한때 hold를 보유했었다는 뜻) `/result`로,
  존재하지 않으면(= 직접 URL 접근 등 애초에 hold가 없었음) 기존대로 `/seats`로 리다이렉트 (수정)
- `app/payment/page.tsx` — 동일한 가드 분기 수정 (수정)
- `app/booking/BookingView.tsx` — `HoldTimer onExpire`뿐 아니라 `POST /api/booking`의
  `hold_expired` 응답 분기도 함께 `router.push("/seats")` → `router.push("/result")`로 변경(D-9의
  "hold 상실은 항상 종결"이 타이머 만료 경로에만 국한되지 않음을 구현 중 확인) (수정)
- `app/payment/PaymentView.tsx` — 동일(`HoldTimer onExpire` + `POST /api/payment`의 `hold_expired`
  응답 분기) (수정)
- `lib/types.ts` — `JudgmentEventType`을 `JudgmentEvent["type"] | "slow_total_time" |
  "high_contention_losses"`로 확장(Task 011 착수 전 확정 사항, `SessionResultResponse`/`FeedbackItem`
  자체는 Task 003에서 이미 정의됨) (수정)
- `lib/dummy-data.ts` — `getDummySessionResult`는 `app/result/page.tsx`에서만 쓰였음을 확인 → 함수와
  전용 import(`SessionOutcome`/`SessionResultResponse`/`FeedbackItem`/`JudgmentEvent`) 제거 (수정)
- `prisma/schema.prisma` — 변경 없음 예상(`SessionResult.outcome`/`SimulationRun.status`는 Task 002가
  이미 만들어 둔 필드, 새로 쓰기 시작할 뿐 스키마 변경 아님)

## 선행 조건

- Task 006(`app/api/session/route.ts`의 재시작 시 `SessionResult` 리셋 로직 — 아래 설계 결정 1 참조,
  **이 Task의 착수 조건**으로 Task 006 파일을 먼저 수정해야 함)
- Task 008(`queue_reset` 이벤트), Task 009(`contention_loss`/`seat_claim_success`/`hold_expired` 이벤트,
  `expireStaleHolds`), Task 010(`payment_error`/`payment_retry_success`/`payment_abandoned` 이벤트,
  `getOwnedHold`) — 모두 완료되어 이미 기록 중

## 설계 결정

- **[사용자 확정] SessionResult는 세션당 1개, "다시 도전" 시 리셋한다.** `SessionResult.sessionId`는
  `@unique`라 런(run) 단위가 아니라 세션 단위로 묶인다 — "다시 도전"으로 새 `SimulationRun`을 만들어도
  같은 row에 이전 시도의 `stageTimings`/`events`/`contentionLosses`/`outcome`이 그대로 남아 다음 시도와
  섞인다. 스키마 변경(`SessionResult.simulationRunId` 추가) 대신, `app/api/session/route.ts`의 `POST`가
  새 `SimulationRun`을 만드는 **같은 트랜잭션**에서 해당 세션의 `SessionResult` row를 초기화
  (`stageTimings: {}`, `contentionLosses: 0`, `events: []`, `outcome: null`; row가 없으면 그냥 스킵 —
  아직 아무 것도 기록되지 않았으므로) — "최신 시도 결과만 남는다"는 현재 PRD 범위(기록 비교/랭킹은 v2
  제외 항목)와 정확히 일치한다. **이 변경은 이미 완료된 Task 006 파일(`app/api/session/route.ts`)
  수정을 동반**하지만, 신규 필드나 다른 Task의 호출부 변경은 없다.
- **[사용자 확정] `QUEUE_TIMEOUT`은 이번 범위에서 제외한다.** `SessionOutcome` enum에 이미 존재하고
  결과 페이지 더미 카피도 준비돼 있지만, 현재 대기열 로직(`lib/queue.ts`)에는 "좌석 소진으로 입장
  실패" 같은 트리거가 전혀 없어(순번은 `admissionRatePerSec`로 언젠가 반드시 0에 도달 — 영구 대기
  없음) 도달할 방법이 없다. 이 outcome을 만들려면 `lib/queue.ts`(Task 008 파일) 로직 변경이 필요해
  "이미 기록된 관측 데이터만 집계한다"는 이 Task의 범위를 넘어선다. `determineOutcome`은
  `QUEUE_TIMEOUT`을 반환하지 않으며, 대기열 단계에서만 이탈한 세션(아래 규칙상 특정 신호가 없는
  경우)은 `ABANDONED`로 분류된다. **후속 과제로 ROADMAP에 기록**(별도 Task, 대기열 좌석 소진 감지
  로직 추가가 선행되어야 함).
- **`determineOutcome` 판정 규칙 (순수 함수, `lib/result.ts`)** — 입력: `hasBooking: boolean`,
  `events: JudgmentEvent[]`. 우선순위 순서대로 첫 매치를 반환:
  1. `hasBooking` → `SUCCESS` (결제 성공 시 `Booking` row 생성 — Task 010에서 이미 완료, 가장 확실한
     신호)
  2. `events`에 `payment_abandoned` 존재 → `PAYMENT_FAILED` (에러 후 새로고침/이탈로 hold 상실)
  3. `events`에 `hold_expired` 존재 → `SEAT_LOST` (5분 hold 자연 만료)
  4. 위 셋 다 아니면 → `ABANDONED` (그 외 모든 경우 — 대기열/좌석 단계에서 특별한 이벤트 없이 이탈,
     또는 `QUEUE_TIMEOUT` 범위 제외로 인한 대기열 이탈 포함)
  - `payment_abandoned`과 `hold_expired`는 실제로 동시에 발생하지 않는다(hold는 한 번만
    `releasedAt`이 설정됨 — 명시적 `releaseHold` 경로 또는 `expireStaleHolds` 스윕 경로 중 하나만
    탄다) — 우선순위는 방어적 안전장치.
- **`/result` 도달 시점 = 판정 시점, 부수적으로 sweep을 먼저 실행한다.** 클라이언트의 `HoldTimer
  onExpire`는 순전히 클라 타이머 기준으로 즉시 `router.push("/result")`하므로, 서버가 아직
  `expireStaleHolds`를 실행해 `hold_expired` 이벤트를 기록하기 전에 `/result`에 도달하는 경쟁이
  가능하다. 따라서 `aggregateSessionResult`는 outcome을 계산하기 **전에** 세션의 (아직 `ACTIVE`인)
  런을 찾아 `expireStaleHolds({ runId, now })`를 먼저 호출한다(런이 이미 `ACTIVE`가 아니면 — 즉 이전
  방문에서 이미 종결됐으면 — 스킵). 이렇게 하면 위 규칙 3이 놓치는 경우가 없다.
- **outcome은 최초 1회만 계산·저장, 이후 재방문은 저장된 값을 그대로 반환한다.**
  `aggregateSessionResult`는 `SessionResult.outcome`이 이미 non-null이면 재계산 없이 그 값과 기존
  `stageTimings`/`contentionLosses`/`events`를 그대로 읽어 응답을 구성한다(단, `feedback`은 매번 순수
  함수로 다시 계산 — DB에 저장하지 않음, 코칭 문구를 나중에 바꿔도 과거 세션에 소급 적용됨). `outcome`이
  `null`이면 위 규칙으로 계산한 뒤 **같은 트랜잭션**에서 `SessionResult.outcome`을 쓰고, 세션의 (아직
  `ACTIVE`인) `SimulationRun.status`를 `COMPLETED`로 전이한다(지금까지 어떤 Task도 `COMPLETED`를 쓴 적이
  없음 — `EXPIRED`는 "다시 도전으로 대체됨"을 뜻하는 것과 구분되는, "실제로 결말을 봤다"는 의미의
  전이). 정상 플로우에서는 `/result`가 정확히 결말 시점에만 열리므로(결제 성공 push, hold 상실
  리다이렉트) 이 "최초 1회" 판정이 진행 중인 세션을 잘못 종결시킬 위험은 없다 — 다만 사용자가 URL을
  직접 쳐서 진행 중에 `/result`를 열면 그 시점 기준 `ABANDONED`로 조기 확정될 수 있음을 알려진 한계로
  남긴다(정상 UI 네비게이션은 이 경로를 타지 않음).
- **구현 시 정정 — `hasBooking` 조회는 세션이 아니라 현재 런으로 스코프한다.** 계획 단계에서는 "Booking
  존재 여부 조회"라고만 적었으나, 구현하면서 `Booking`이 `sessionId`만 갖고(`simulationRunId` 없음)
  "다시 도전"으로도 삭제되지 않는다는 점을 재확인했다 — D-8이 리셋하는 건 `SessionResult`뿐이라, 옛
  런에서 결제까지 성공한 세션이 재도전하면 세션에는 옛 `Booking`이 그대로 남는다. `sessionId`만으로
  `hasBooking`을 조회하면 이번 런은 아직 아무것도 안 했는데도 옛 성공 때문에 `SUCCESS`로 잘못
  판정된다. 그래서 `Booking → Seat → simulationRunId`를 거쳐 **현재 런으로 스코프**해 조회하도록
  구현했다(`lib/result.test.ts`의 "scopes the Booking lookup..." 케이스로 회귀 검증).
- **hold 상실 리다이렉트 목적지: `/seats` → `/result`로 정정.** PRD 결과 리포트 페이지 절
  ("진입 조건: 예매 성공 또는 실패 확정", "진입 경로: 결제 성공, hold 상실/만료, 세션 실패 확정 시
  자동 이동")과 예매정보/결제 페이지 절("다음 이동: hold 만료 → 결과 리포트(실패)")이 명시하는
  목적지는 `/result`인데, Task 010 구현은 `/seats`로 보내고 있었다(재선택 기회를 주는 형태) — ROADMAP
  D-5의 "만료 시 좌석 복원 대신 F010 실패 결과로 **종결**"과도 맞지 않는다. 이 Task에서 정정한다:
  - **서버 가드** (`app/booking/page.tsx`/`app/payment/page.tsx`): `getOwnedHold`가 `null`일 때
    `stageTimings.seat_selection.exitedAt` 존재 여부로 분기 — 존재하면(한때 hold를 실제로 보유했다는
    뜻) `/result`, 없으면(직접 URL 접근 등 애초에 hold가 없었던 경우) 기존대로 `/seats`.
  - **클라이언트 타이머** (`BookingView`/`PaymentView`의 `HoldTimer onExpire`): 항상 hold를 보유한 뒤
    도달하는 상태이므로 무조건 `/result`로 변경.
- **피드백 매핑 규칙 (`buildFeedback`, 순수 함수)** — `events`를 스테이지 순서(`queue` →
  `seat_selection` → `booking_info` → `payment`)로 순회하며, 존재하는 이벤트 타입마다 최대 1개의
  `FeedbackItem`을 생성(같은 타입이 여러 번 발생해도 발생 횟수를 문구에 반영한 문장 하나로 합침):
  - `queue_reset` (N건) → `"You refreshed the queue N time(s), which reset your position each time — closing the tab (not reloading it) preserves your spot better next run."`
  - `contention_loss` (N건, `contentionLosses`로 집계) → N > 0일 때만:
    `"You lost N seat race(s) to bots or other sessions before securing yours — that's normal at this tier, but picking a seat farther from the busiest section can lower it."`
  - `payment_error` 있고 뒤이어 `payment_retry_success` 있음 → 긍정 피드백:
    `"You hit a payment error and recovered by retrying inside the modal instead of refreshing — that's exactly the right move, your hold stayed intact."`
  - `payment_error` 있고 뒤이어 `payment_abandoned` 있음 → `"After the payment error, refreshing or navigating away forfeited your hold. Closing just the error modal and retrying keeps the hold alive instead."`
  - `hold_expired` → `"Your 5-minute hold ran out before you finished booking info and payment — once a seat is held, treat the timer as the real deadline it is."`
  - **구현 시 정정**: 계획서는 "이벤트가 전혀 없고 `outcome === ABANDONED`일 때 대체 문구"도 넣기로
    했으나, 구현하면서 이 대체 문구에 붙일 마땅한 `eventType`이 없음을 발견했다(기존 관측 이벤트도,
    새로 추가한 `slow_total_time`/`high_contention_losses`도 의미상 맞지 않음 — 억지로 아무 값이나
    채우면 `FeedbackItem.eventType`의 "왜 이 피드백이 나왔는지" 의미가 흐려진다). 대신 `buildFeedback`이
    이 경우 그냥 빈 배열을 반환하도록 단순화했다 — `app/result/page.tsx`는 이미 `feedback.length > 0`일
    때만 "Feedback" 섹션을 렌더링하므로 UI 쪽 변경도 필요 없었다.
- **티어별 기준치 비교 (`evaluateBenchmarks`, 순수 함수 + `TIER_BENCHMARKS` 상수)** — PRD 요구
  ("소요 시간·패배 횟수를 티어별 기준치와 비교")를 만족시키는 최소 구현. `SimulationConfig`에는 비교용
  "기준치" 필드가 없으므로(존재하는 필드는 `admissionRatePerSec`/`botIntensity`/`errorRate`/`latencyMs`
  등 시뮬레이션 계수뿐), `lib/result.ts`에 티어별 목표값을 상수로 새로 정의한다(seed 데이터의 티어별
  강도 차이에 대략 비례하도록 잡은 **초기값** — 정밀 튜닝은 이 Task 범위 밖):
    ```
    SMALL:  targetTotalMs = 90_000  (1m30s), maxContentionLosses = 1
    MEDIUM: targetTotalMs = 150_000 (2m30s), maxContentionLosses = 3
    MEGA:   targetTotalMs = 240_000 (4m),    maxContentionLosses = 6
    ```
  총 소요 시간(`stageTimings`의 `durationMs` 합)이 `targetTotalMs`를 초과하거나 `contentionLosses`가
  `maxContentionLosses`를 초과하면 각각 별도의 `FeedbackItem`을 추가한다.
  **[사용자 확정] `eventType`은 `"slow_total_time"`/`"high_contention_losses"` 신규 리터럴로 표현한다**
  (기존 관측 이벤트 타입 재사용 안 함 — 벤치마크 평가 결과는 관측 이벤트와 성격이 다르므로 타입에서
  구분되어야 한다는 판단). `lib/types.ts`의 `JudgmentEventType`을 `JudgmentEvent["type"] |
  "slow_total_time" | "high_contention_losses"`로 확장(이미 반영 완료 — Task 011 착수 전 확정 사항).
  `JudgmentEvent`(관측 이벤트 유니온) 자체는 건드리지 않으므로 이 두 리터럴이 `SessionResult.events`에
  실제로 저장될 일은 없다 — `FeedbackItem.eventType`에서만 쓰인다.
  티어는 `SessionResult`가 아니라 세션의 **가장 최근** `SimulationRun`(상태 무관, `createdAt desc`
  1건)에서 조회 — 리셋 설계(위 첫 번째 결정)로 인해 이것이 항상 이 결과가 속한 런과 일치한다.

## 수락 기준

- [x] `GET /api/result`: 결제 성공(`Booking` 존재) 세션 → `{outcome: "SUCCESS", ...}`,
      `SimulationRun.status`가 `COMPLETED`로 전이됨
- [x] `GET /api/result`: `payment_abandoned` 이벤트가 기록된 세션 → `outcome: "PAYMENT_FAILED"`
- [x] `GET /api/result`: `hold_expired` 이벤트가 기록된 세션(결제 관련 이벤트 없음) →
      `outcome: "SEAT_LOST"`
- [x] `GET /api/result`: 위 셋 다 해당 없는 세션 → `outcome: "ABANDONED"`
- [x] `GET /api/result`: `outcome`이 이미 저장돼 있으면 재계산 없이 저장된 값을 그대로 반환(재방문
      시 결과가 바뀌지 않음)
- [x] `GET /api/result`: 응답에 `stageTimings`/`contentionLosses`/`events`가 기록된 값 그대로 포함되고,
      `feedback`이 이벤트 종류에 맞게 매핑됨(재시도 성공은 긍정 피드백, 실패 이벤트는 코칭 문구)
- [x] `GET /api/result`: 총 소요 시간·`contentionLosses`가 티어 기준치를 넘으면 해당 피드백이 추가됨
- [x] `POST /api/session`("다시 도전" 재시작): 새 런 생성과 같은 트랜잭션에서 해당 세션의
      `SessionResult`(`stageTimings`/`contentionLosses`/`events`/`outcome`)가 초기화됨 — 이전 시도의
      기록이 다음 시도에 섞이지 않음
- [x] `app/booking/page.tsx`/`app/payment/page.tsx`: hold가 애초에 없었던 세션(직접 URL 접근)은
      여전히 `/seats`로, hold를 보유했다가 상실한 세션은 `/result`로 리다이렉트됨
- [x] `BookingView`/`PaymentView`의 `HoldTimer` 만료 시 `/result`로 이동함(클라이언트 타이머 만료
      시점에 서버가 아직 sweep 전이어도 `/result`가 정확한 `SEAT_LOST`를 표시함 — sweep 경쟁 처리 확인)
- [x] `app/result/page.tsx`: 더미 데이터·`?outcome=` 오버라이드 제거, 실 API/lib 데이터로 렌더링
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `lib/session-result.ts`: `getSessionResultRow(db, sessionId)` 읽기 헬퍼 추가(row 없으면 `null`)
2. [x] `app/api/session/route.ts`: 새 런 생성 트랜잭션 안에서 세션의 기존 `SessionResult` row를
      초기화(`stageTimings: {}`, `contentionLosses: 0`, `events: []`, `outcome: null`; row 없으면 스킵)
3. [x] `lib/result.ts`: `determineOutcome({ hasBooking, events })` 순수 함수 작성
4. [x] `lib/result.ts`: `TIER_BENCHMARKS` 상수 + `evaluateBenchmarks({ tier, stageTimings, contentionLosses })`
      순수 함수 작성
5. [x] `lib/result.ts`: `buildFeedback({ events, outcome, benchmarkFeedback })` 순수 함수 작성(위 설계
      결정의 이벤트별 코칭 문구 매핑)
6. [x] `lib/result.ts`: `aggregateSessionResult({ sessionId, now })` 작성 — `SessionResult` row 조회 →
      `outcome`이 이미 있으면 그대로 반환(feedback만 재계산) → 없으면: (a) 세션의 `ACTIVE` 런 조회 시
      `expireStaleHolds` 먼저 실행 (b) `Booking` 존재 여부 조회 (c) `determineOutcome` 호출 (d) 같은
      트랜잭션에서 `SessionResult.outcome` 저장 + `ACTIVE` 런이 있으면 `COMPLETED`로 전이 (e) 최근 런의
      `tier`로 `evaluateBenchmarks` → `buildFeedback` → `SessionResultResponse` 조립
7. [x] `app/api/result/route.ts`: `requireSession` 가드 → `aggregateSessionResult` 호출 → 세션/런 없으면
      적절한 에러 응답(신규)
8. [x] `app/booking/page.tsx`: hold 없음 분기를 `getSessionResultRow` 기반으로 `/seats`/`/result` 분기로
      수정
9. [x] `app/payment/page.tsx`: 동일하게 수정
10. [x] `app/booking/BookingView.tsx`: `HoldTimer onExpire`를 `/result`로 변경
11. [x] `app/payment/PaymentView.tsx`: 동일하게 변경
12. [x] `app/result/page.tsx`: `aggregateSessionResult` 직접 호출로 교체, 더미/오버라이드 제거,
      `OUTCOME_META`는 outcome 단위 정적 카피로 유지
13. [x] 타입 체크·린트 통과 확인
14. [x] Vitest 단위/통합 테스트 작성 (아래 테스트 체크리스트 참조)
15. [x] Playwright MCP로 실제 dev 서버를 구동해 E2E 플로우 검증 (Task 006~010과 동일하게 대화형
       검증만 수행, 커밋되는 자동화 테스트는 Vitest만 유지)

## 테스트 체크리스트

### 단위 테스트 (Vitest)

- [x] `determineOutcome`: `hasBooking` → `SUCCESS`, `payment_abandoned` → `PAYMENT_FAILED`,
      `hold_expired`(결제 이벤트 없음) → `SEAT_LOST`, 아무 신호 없음 → `ABANDONED`, 우선순위 검증
      (`hasBooking`이 다른 이벤트보다 우선)
- [x] `evaluateBenchmarks`: 기준치 이하/초과 각각 경계값 포함 검증(티어 3종 모두)
- [x] `buildFeedback`: 이벤트 타입별 문구 매핑, 동일 타입 반복 시 문구 1개로 합쳐지는지, 재시도 성공
      긍정 피드백, 이벤트 없음 + `ABANDONED` 시 대체 문구

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `aggregateSessionResult`: 결제 성공 세션 fixture → `SUCCESS` 저장 + 런 `COMPLETED` 전이 확인
- [x] `aggregateSessionResult`: `payment_abandoned`/`hold_expired` 세션 fixture 각각 올바른 outcome
- [x] `aggregateSessionResult`: `outcome` 이미 저장된 row 재호출 시 재계산 없이 동일 값 반환(런 상태도
      재전이 안 됨)
- [x] `aggregateSessionResult`: 아직 만료 안 된 hold를 sweep 없이 호출해도 만료 hold가 있으면 sweep
      후 `SEAT_LOST`로 정확히 판정(레이스 시나리오 재현)
- [x] `POST /api/session` 재시작: 이전 세션의 `stageTimings`/`events`/`outcome`이 새 런 생성 후
      초기화됨(실제 DB 기준 전/후 상태 비교)
- [x] `GET /api/result`: 세션 없음/런 없음 각각의 에러 응답

### E2E 검증 (Playwright MCP, 실제 dev 서버 대화형 구동 — Task 006~010과 동일하게 커밋되는 스펙 파일 없음)

- [x] 정상 결제 성공 → 결과 페이지에서 성공 표시 + 단계별 타임라인 + 피드백(있다면) 확인
- [x] 결제 에러 → 새로고침/뒤로가기(hold 상실) → 자동으로 결과 페이지(실패, `PAYMENT_FAILED`) 도달
      확인 (기존엔 `/seats`로 갔던 경로가 `/result`로 바뀐 것 확인)
- [x] hold 5분 만료(타임워프 유틸로 가속) → 결과 페이지(`SEAT_LOST`) 자동 도달 확인
- [x] 결과 페이지 "다시 도전" → 홈 복귀 → 새 시뮬레이션 시작 → 이전 결과가 다음 시도에 섞이지 않는지
      확인(예: 이전 시도의 `contentionLosses`가 0으로 리셋됐는지)

## 변경 사항 요약

- **`hasBooking` 조회를 세션이 아니라 현재 런으로 스코프 (계획서 대비 구체화)**: 위 "설계 결정"의
  "구현 시 정정" 항목 참조 — `Booking`은 `simulationRunId`가 없고 "다시 도전"으로도 삭제되지 않아,
  `sessionId`만으로 조회하면 옛 런의 성공이 새 런에 그대로 이어져 잘못된 `SUCCESS` 판정을 낳는다.
  `Booking → Seat.simulationRunId`로 현재 런에 스코프해 조회하도록 구현했다.
- **`buildFeedback`의 "이벤트 없음" 대체 문구 제거 (계획서 대비 단순화)**: 마땅한 `eventType`이 없어
  억지로 채우는 대신 빈 배열을 반환하도록 변경 — `app/result/page.tsx`가 이미 `feedback.length > 0`
  조건으로 섹션을 감추므로 UI 쪽 추가 변경 없이 자연스럽게 처리됐다.
- **hold 상실 리다이렉트 정정 범위가 `HoldTimer onExpire`뿐 아니라 API 응답 분기까지 확장됨 (계획서
  대비 범위 확대)**: `BookingView`/`PaymentView`의 `POST /api/booking`·`POST /api/payment`가
  `hold_expired`를 응답으로 받는 분기(제출 시점에 서버가 이미 만료를 감지한 경우)도 같은 이유로
  `/result`로 보내야 한다는 걸 구현 중 확인해 함께 수정했다 — 계획서 "관련 파일"은 타이머 분기만
  명시했었다.
- **코드 리뷰 후속 조치 (1차 구현 완료 후 사용자 질문으로 발견·확정)**:
  - `lib/result.ts`의 `if (latestRun?.status === ACTIVE)` 가드 옆에, `latestRun.status === EXPIRED`이면서
    `outcome === null`인 상태가 왜 도달 불가능한지(D-8 리셋 트랜잭션이 "EXPIRED 전이"와 "더 최신 ACTIVE
    런 생성"과 "outcome 리셋"을 항상 한 트랜잭션으로 묶어, EXPIRED 런이 `latest`가 되는 경우 자체가
    없음) 설명하는 주석을 추가했다 — 코드 동작 변경은 없음.
  - **`no_recorded_activity` fallback 추가**: `ABANDONED`인데 `buildFeedback`/`evaluateBenchmarks` 양쪽
    다 아무 항목도 못 만든 세션(이벤트 0건 + 기준치 미달)은 결과 페이지에서 유일하게 코칭 문구가 하나도
    없는 outcome이 되는 문제를 사용자 질문으로 재검토했다. "가장 초반에 이탈해 배울 게 가장 궁금할
    사람이 정작 아무 피드백도 못 받는" 역설을 해소하기 위해, `lib/types.ts`의 `JudgmentEventType`에
    `"no_recorded_activity"` 리터럴을 추가하고 `aggregateSessionResult`가 `buildFeedback` 호출 결과가
    빈 배열이면서 `outcome === ABANDONED`일 때만 조건부로 대체 문구를 push하도록 구현했다(진짜 이벤트가
    하나라도 있으면 그게 우선이라 fallback은 안 붙음).
- **검증**: `npx tsc --noEmit`, `npm run lint` 모두 통과. `npx vitest run --fileParallelism=false`
  **178 tests / 19 files** 전부 통과(신규: `lib/result.test.ts` 23건 — `no_recorded_activity` fallback
  적용/미적용 2건 포함, `app/api/result/route.test.ts` 4건, `lib/session-result.test.ts`에
  `getSessionResultRow`/`resetSessionResult` 4건 추가, `app/api/session/route.test.ts`에 D-8 리셋 검증
  1건 추가).
- **Playwright(Chrome MCP)로 실제 dev 서버(이미 구동 중이던 로컬 인스턴스, `localhost:3000`)를 대화형으로
  검증**: (1) 정상 결제 성공 플로우 — 홈(Small 티어) → 대기열(`/api/dev/timewarp`로 순번 소진 가속) →
  좌석 A1 클레임 → 예매정보 → 결제(Bank Transfer) → 결과 페이지에서 `SUCCESS` 헤드라인·소요 시간·4단계
  타임라인·피드백("queue_reset" 1회, React StrictMode의 대기열 이중 join으로 자연 발생)까지 정확히
  렌더링됨을 확인. (2) **hold 5분 만료 → `/result`(D-9) 실경로 검증** — 이 검증들을 진행하며 DB 조작
  스크립트를 준비하는 동안 브라우저 탭이 실제로 5분간 `/booking`에 머물렀고, 클라이언트 `HoldTimer`가
  자연 만료되어 **의도대로 `/result`로 자동 이동**했다: 결과 페이지가 "Your hold expired" +
  `SEAT_LOST` 피드백을 정확히 표시했고, DB 조회로 `SimulationRun.status`가 `COMPLETED`로 전이된 것도
  확인 — 실제 프로덕션 경로(클라이언트 타이머 → `aggregateSessionResult`의 sweep-then-determine
  레이스 처리)가 조작 없이 그대로 검증된 셈이다. (3) 결제 실패 플로우 — `lib/payment.ts`의
  `attemptPayment`를 `roll:0`으로 직접 호출해 결정론적으로 에러를 주입한 뒤 `releaseHold` 호출(HTTP
  API의 `roll`은 클라이언트가 주입할 수 없어 라이브 확률로는 재현 비용이 컸음 — 이 경로는
  `lib/payment.test.ts`/`lib/result.test.ts`가 이미 결정론적으로 커버하므로, 여기서는 렌더링 확인에
  집중)로 `payment_abandoned`을 재현 → 결과 페이지가 "Payment didn't go through" +
  `PAYMENT_FAILED` 피드백을 정확히 표시함을 확인. (4) "Try again" → 홈 복귀 → 새 세션 시작이
  정상 동작함을 확인(D-8 리셋의 실제 API 값 비교는 `app/api/session/route.test.ts`가 담당).
- **다음 Task 인계 사항**: MVP 핵심 기능 작업(Phase 3, Task 006~011)이 이걸로 모두 완료됐다. 다음은
  `tasks/011-1`(핵심 기능 통합 테스트, ROADMAP)과 `QUEUE_TIMEOUT`(이번에 범위 제외한 outcome — 대기열
  좌석 소진 감지 로직이 선행돼야 함, ROADMAP에 후속 과제로 기록됨).
