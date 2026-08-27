# Ticket Trainer 개발 로드맵

실제 콘서트 예매의 좌석 경합·장애 상황을 안전하게 재현해, 티케팅을 실전처럼 연습하게 해주는 시뮬레이션 플랫폼.

## 개요

**Ticket Trainer**는 대형 아이돌 콘서트 티케팅을 앞둔 한국 팬덤 사용자를 위한 **안전한 티케팅 훈련 환경**으로 다음 기능을 제공합니다:

- **진짜 좌석 경합 (F006)**: DB 트랜잭션 락 기반 원자적 좌석 선점 — 동시 클릭 시 1명만 성공하는 실제 경합 재현
- **경쟁 봇 + 대기열 압박 (F003, F008)**: 티어별 강도로 좌석을 선점하는 봇과 순번이 줄어드는 대기열의 심리적 압박
- **실패 상황 훈련 (F009, F010)**: 결제 실패 주입 후 사용자의 행동(재결제/새로고침/이탈)에 따라 hold 유지·상실이 실제처럼 갈리는 판단 훈련
- **결과 리포트 (F011)**: 단계별 소요 시간, 경합 패배 횟수, 판단 피드백으로 완성되는 학습 루프

**핵심 기술 제약** (CLAUDE.md 참조):
- Serverless 환경이므로 봇/큐/hold 만료는 상시 프로세스(`setInterval`) 불가 → **tick-on-request deterministic simulation** 패턴으로 구현
- tick 엔진의 기준 시각 `lastTickAt`은 메모리에 유지 불가 → **반드시 DB에 영속화** (Task 002 스키마에 포함)
- `Seat.status` 변경과 `Hold`/`Booking` 쓰기는 **반드시 같은 트랜잭션**에 묶어 상태 분기 방지
- Next.js 16 브레이킹 체인지 주의 — 구현 전 `node_modules/next/dist/docs/` 우선 확인 (온라인 튜토리얼/학습 데이터 아님)
- **관측 데이터(타이밍·판단 이벤트)는 발생 시점의 Task(008~010)에서 기록**하고, Task 011은 집계·피드백 매핑만 담당 (재작업 방지)
- **구역(Block A~E) 개념은 UI 전용**: `Seat.number`(좌석 번호, 좌우 위치 기준)를 클라이언트에서 그룹핑해 표현하며 별도 스키마 필드/테이블 없음 (Task 005-1에서 헬퍼 정의, Task 005-4에서 적용)

---

## 사전 결정 사항 (Phase 1 착수 전 확정 필수)

> 스키마(Task 002)에 직접 영향을 주는 열린 설계 질문. 구현 시작 전 결정하고 아래에 결정 내용을 기록한다.

- [x] **D-1. 시뮬레이션 인스턴스 단위 결정**: 좌석맵·대기열을 (a) 전역 공유 1개로 운영할지, (b) 세션별 독립 인스턴스로 운영할지, (c) 라운드제로 주기 리셋할지 결정 → **결정: (b) 세션별 독립 인스턴스**
  - PRD는 "타 사용자와의 경합"(F006)을 언급하나, "다시 도전" 시 좌석이 이미 sold 상태인 문제의 해결 방식이 미정
  - 결정에 따라 `Seat`/`QueueEntry`가 `simulationRunId` 등의 스코프 키를 가질지, 리셋 API가 필요할지 갈림
  - **MVP 권장안**: 세션별 독립 인스턴스(b) — 경합 상대는 봇으로 충분하고, 리셋이 단순하며 tick 결정론 검증도 쉬움. 실사용자 간 경합은 v2 스트레치로 이동
- [x] **D-2. 티어 선택 값의 전달·저장 경로 결정**: 홈에서 선택한 티어(F001)를 세션에 저장할지, 대기열 진입 API 파라미터로 전달해 `QueueEntry`(또는 시뮬레이션 인스턴스)에 기록할지 결정 → **결정: 대기열 진입 API 파라미터로 전달**
  - **권장안**: 대기열 진입 시 파라미터로 받아 시뮬레이션 인스턴스/QueueEntry에 기록 — 세션 재사용 시 티어 변경이 자연스러움


---
## 개발 중 발견된 설계 변경 사항 (Post-hoc Design Decisions)
> Phase 1 착수 전이 아니라, 실제 구현·플레이 과정에서 발견되어 사후에 결정된 사항. 이미 완료·병합된 Task의 코드 수정을 동반하는 경우가 많으므로, 각 항목에 영향받는 Task를 명시하고 별도 수정 브랜치로 반영한다.

- [x] **D-3. `seat_selection` stageTiming의 의미** (Phase 1 착수 전이 아니라 Task 009 구현 중 발견·결정된 사항): `enteredAt`은 좌석맵 최초 조회(`GET`) 시점, `exitedAt`은 클레임 성공(`POST`) 시점으로 기록 — Task 009 구현 중 변경, 원래 작업 문서(`tasks/009-seat-map-hold-atomicity.md`)는 "성공 시에만 `enteredAt`"이었음. 따라서 이 구간에는 **경합 재시도 시간이 포함됨** — Task 011에서 "빠를수록 좋음" 식 평가 로직을 짤 때 이 점 감안할 것.
- [x] **D-4. 대기열 초기 순번 산정 모델 변경** (Phase 3 진행 중 발견·결정 — Task 007/008 완료 후 수정 필요): 초기 순번이 티어별 고정값(`virtualQueueSize`)이라 "오픈 정각에 얼마나 빨리 눌렀는지"가 전혀 반영되지 않는 문제 발견 → **결정: 오픈 시각 이후 가상 유저 도착률에 비례한 동적 산정으로 변경**
  - `SimulationConfig`에 `arrivalRatePerSec`(초당 가상 유저 유입 수) 필드 추가
  - 초기 순번 = `arrivalRatePerSec × (joinedAt - concert.openAt)`. 이후 감소는 기존 `admissionRatePerSec` 방식 유지
  - **부수 효과**: 대기열 경과시간이 봇 tick 계산과 같은 시간축을 공유하므로, 대기가 길수록 좌석 선택 진입 시 잔여 좌석이 자연히 줄어듦 (별도 로직 불필요)
  - **영향 범위**: Task 007(tick 계산 로직), Task 008(대기열 진입 API), `lib/types.ts`(`SimulationConfig` 타입) — 이미 완료·병합된 코드 수정 필요
  - **구현 시 정정**: 실제로는 `lib/queue.ts`의 `joinQueue` 한 곳만 수정하면 됐다 — `lib/simulation.ts`/`lib/tick.ts`는 `initialPosition`을 불투명한 숫자로만 다뤄 전혀 손대지 않았고, `lib/types.ts`에는 애초에 `SimulationConfig`를 나타내는 손으로 작성한 타입이 없어 수정 대상이 아니었다(Prisma 생성 타입을 그대로 사용). `virtualQueueSize` 필드는 이 변경 후 앱 코드에서 완전히 죽은 필드가 되어 스키마에서 함께 제거했다. See: `tasks/011-queue-arrival-rate-position.md`
- [x] **D-5. Hold 만료 시 좌석 상태 복원 제거** (Phase 3 진행 중 발견·결정 — Task 007/009/010 완료 후 수정 필요): 5분 hold 만료 시 좌석을 `available`로 되돌리는 현재 동작이 비현실적(실제 취켓팅은 그렇게 빨리 안 풀림) → **결정: 세션 내 좌석 상태는 available → held → sold 단방향 전이만 허용, hold 만료로 인한 좌석 복원 로직 제거**
  - 유저 본인의 hold 타이머(5분 압박, F007)는 그대로 유지 — 결제 유도 긴장감 장치로 기능, 만료 시 좌석 복원 대신 F010 실패 결과로 종결
  - **영향 범위**: Task 007(hold 만료 판정 — "내 hold 유효성"만 체크로 축소), Task 009(hold 만료 lazy 처리), Task 010("새로고침/뒤로가기 → hold 상실 + 좌석 방출" 분기 — "좌석 방출" 제거하고 hold 상실만 기록) — 이미 완료·병합된 코드 수정 필요
  - **구현 시 정정**: 실제로 "이미 완료·병합된 코드" 수정이 필요했던 곳은 Task 009뿐이었다 — `lib/seats.ts`의 `releaseExpiredHolds`(만료 hold 발견 시 `Hold.releasedAt` 기록과 **같은 트랜잭션에서 `Seat.status → AVAILABLE`도 실행**하던 함수)에서 좌석 상태 되돌리기 라인만 제거하고 `expireStaleHolds`로 개명 — 더 이상 좌석을 "해제"하지 않으므로. `Hold.releasedAt`은 스키마·부분 유니크 제약 변경 없이 계속 "내 hold 유효성" 표시 용도로 재사용(booking/payment 단계 체크, 결과 리포트 `hold_expired` 이벤트 기록). Task 007(`lib/simulation.ts`의 `findExpiredHolds`)은 원래도 범용 순수 필터(`expiresAt < now`)라 로직 변경이 불필요했고, "caller가 Seat.status도 되돌린다"고 잘못 적힌 문서 주석만 정정했다. **Task 010은 애초에 미착수 상태**(`app/api/booking`·`app/api/payment` 모두 `not_implemented` 501 스텁, 새로고침/뒤로가기 hold 처리·`sendBeacon` 로직 전무)라 "이미 완료·병합된 코드"라는 전제 자체가 틀렸다 — 되돌릴 기존 코드가 없으므로 이번 수정 범위에서 제외했고, 추후 Task 010을 실제 구현할 때 "좌석 방출 없이 hold 상실만 기록"으로 처음부터 만들면 된다. 부수적으로 `prisma/schema.prisma` Hold 모델 주석, `lib/types.ts`의 `payment_abandoned` 이벤트 주석, `app/result/page.tsx`의 `SEAT_LOST`/`PAYMENT_FAILED` 더미 카피("seat went back on sale" 등)도 옛 동작을 전제로 하고 있어 함께 정정했다.
- [x] **D-6. 좌석 hold 트랜잭션 발생 시점 변경** (Phase 3 진행 중 발견·결정 — Task 009 완료 후 수정 필요): 원래 스펙(F006, Task 009)은 "좌석 클릭 시 즉시 원자적 hold 시도"였으나, 실제 플레이 결과 봇에게 이미 선점된 좌석을 클릭했을 때 재선택이 막히는 문제 발견 → **결정: hold 트랜잭션은 클릭이 아닌 "좌석 선택 완료(confirm)" 시점에 실행**
  - **좌석 클릭**: 순수 로컬 동작. 마지막 폴링 기준 `available`로 보이는 좌석만 `selected`로 표시. 이미 `held`/`sold`로 보이는 좌석 클릭 시 아무 반응 없음 (선택 자체가 안 됨)
  - **confirm(좌석 선택 완료) 클릭**: 이 시점에 실제 원자적 `UPDATE seats SET status='held' WHERE id=$1 AND status='available' RETURNING id` 시도
    - 성공 → 같은 트랜잭션에서 `Hold` 생성 → 예매정보 페이지로 이동
    - 실패(그 사이 봇/타 세션이 선점) → "이미 선택된 좌석입니다" 안내 + 로컬 `selected` 초기화 → 새 좌석 재선택 필요 (좌석 선택 페이지에 남음)
  - **영향 범위**: F006 문구("좌석 클릭 시" → "선택 완료 시"로 정정), Task 009 구현(hold 트랜잭션 호출 위치를 클릭 핸들러에서 confirm 핸들러로 이동), 관련 테스트 체크리스트(클릭 시 검증 → confirm 시 검증으로 케이스 재작성)
  - **D-3 연관 메모**: `seat_selection` stageTiming의 `exitedAt`(클레임 성공 시점)이 이제 confirm 클릭 시점과 일치하게 되어, D-3에서 우려했던 "경합 재시도 시간이 애매하게 섞이는" 문제가 오히려 명확해짐 — `enteredAt`(좌석맵 최초 조회)부터 `exitedAt`(confirm 성공)까지가 곧 "구역 훑어보기 + 좌석 고르기 + 재시도 전체" 구간이 되므로, D-3의 "빠를수록 좋음 평가 시 이 점 감안" 방향은 유지
  - See: `tasks/009-seat-map-hold-atomicity.md`의 "후속 변경 — ROADMAP D-6" 절
- [x] **D-7. 개발/테스트 전용 시간 가속 유틸 도입** (Phase 3 진행 중 발견): D-4/D-6 등 tick-on-request 기반 변경 사항을 검증하려면 매번 실제 오픈 시각 + 실제 대기열 감소 시간을 기다려야 해 개발 사이클이 느려지는 문제 발견 → **결정: dev 환경 전용으로 시뮬레이션 시각 필드(`Concert.openAt`, `QueueEntry.joinedAt`, `SimulationRun.lastTickAt` 등)를 인위적으로 과거로 밀어넣는 유틸 추가**
  - tick-on-request 패턴은 "경과 시간"이 전부 DB에 저장된 시각과 `now()`의 차이로 계산되므로, 저장된 시각 자체를 과거로 세팅하면 실제 대기 없이 "이미 오픈함"/"이미 순번 도달함" 상태를 즉시 재현 가능
  - 실제 tick 계산 로직(`lib/simulation.ts`)은 전혀 건드리지 않음 — 오직 검증용 입력값 세팅 수단만 추가
  - **프로덕션 격리 필수**: `NODE_ENV === 'production'`에서는 라우트/스크립트 자체가 존재하지 않거나 항상 404 응답. 실제 유저 세션은 이 경로를 절대 타지 않음
  - **영향 범위**: 신규 dev 전용 API 또는 CLI 스크립트 추가, Task 006(세션/인스턴스 생성)·007(tick 엔진) 관련 시각 필드를 대상으로 함. 기존 프로덕션 로직 변경 없음
  - **활용 목적**: D-4(대기열 도착 모델), D-6(hold 시점 변경) 등 향후 모든 tick 관련 변경의 수동 검증 시간을 단축
  - **구현**: API 엔드포인트(`POST /api/dev/timewarp`)만 채택, CLI 스크립트는 도입하지 않음 — 브라우저 세션 쿠키를 그대로 재사용할 수 있고 이 저장소가 100% Route Handler 기반이라는 점을 근거로 판단. `openInMs`(부호로 양방향 표현)/`queueRewindMs`·`queueConsumedPct`(배타적)/`lastTickRewindMs` 세 필드를 한 요청에 조합 가능. See: `tasks/010-dev-timewarp-utility.md`
- [x] **D-8. `SessionResult` 세션당 1개 + "다시 도전" 시 리셋** (Phase 3 진행 중 발견 — Task 011 설계 중 발견·결정): `SessionResult.sessionId`가 `@unique`라 세션 단위로만 유일한데, "다시 도전"으로 새 `SimulationRun`을 만들어도 이전 시도의 `stageTimings`/`contentionLosses`/`events`/`outcome`이 같은 row에 그대로 남아 다음 시도의 기록과 섞이는 문제 발견 → **결정: 스키마 변경(런 단위 스코프 키 추가) 대신, `POST /api/session`이 새 런을 생성하는 트랜잭션 안에서 해당 세션의 `SessionResult`를 초기화**(`stageTimings: {}`, `contentionLosses: 0`, `events: []`, `outcome: null`; row가 없으면 스킵)
  - "최신 시도 결과만 남는다"는 처리는 현재 PRD 범위(기록 비교/랭킹은 v2 제외 항목)와 일치하므로, `SessionResult.simulationRunId` 추가 같은 스키마 확장은 채택하지 않음
  - **영향 범위**: Task 006(`app/api/session/route.ts`) — 이미 완료·병합된 코드 수정 필요. Task 008~010의 `lib/session-result.ts` 쓰기 헬퍼 호출부는 변경 없음(신규 필드가 아니라 기존 필드 초기화 시점만 추가)
  - **구현 시 정정**: 원안대로 `app/api/session/route.ts`의 새 런 생성 트랜잭션에 `resetSessionResult(tx, sessionId)` 호출만 추가하는 선에서 끝났다. 다만 구현 중 별개로, `aggregateSessionResult`(Task 011)의 `hasBooking` 판정이 `SessionResult`가 아니라 `Booking` 테이블을 직접 봐야 한다는 점에서 추가 함정을 발견했다 — `Booking`은 `simulationRunId`가 없고 D-8 리셋 대상도 아니어서(리셋은 `SessionResult`만), 옛 런에서 성공한 세션이 재도전하면 옛 `Booking`이 그대로 남는다. `sessionId`만으로 `hasBooking`을 조회하면 새 런이 아직 아무 것도 안 했는데 옛 성공 때문에 `SUCCESS`로 잘못 판정된다 — `Booking → Seat.simulationRunId`로 현재 런에 스코프해 조회하도록 구현해 회피했다(`lib/result.ts`).
  - See: `tasks/012-result-report-feedback.md`
- [x] **D-9. hold 상실 리다이렉트 목적지 `/seats` → `/result` 정정** (Phase 3 진행 중 발견 — Task 011 설계 중 발견·결정): PRD 예매정보/결제/결과 리포트 페이지 절("다음 이동: hold 만료 → 결과 리포트(실패)", "진입 경로: 결제 성공, hold 상실/만료, 세션 실패 확정 시 자동 이동")과 D-5("만료 시 좌석 복원 대신 F010 실패 결과로 **종결**")가 명시하는 hold 상실 시 목적지는 결과 리포트 페이지(`/result`, 실패)인데, Task 010 구현은 `/seats`로 되돌리고 있었음(재선택 기회를 주는 형태로 구현됨) → **결정: 서버 가드와 클라이언트 hold 타이머 만료 모두 `/result`로 정정**. 단, hold를 애초에 가진 적 없는 세션(직접 URL 접근 등)은 기존대로 `/seats`로 보냄 — `stageTimings.seat_selection.exitedAt` 존재 여부(한때 hold를 실제로 보유했는지)로 두 경우를 구분
  - **영향 범위**: Task 010(`app/booking/page.tsx`, `app/payment/page.tsx`의 서버 가드, `app/booking/BookingView.tsx`, `app/payment/PaymentView.tsx`의 `HoldTimer onExpire`) — 이미 완료·병합된 코드 수정 필요
  - **구현 시 정정**: 실제로는 `HoldTimer onExpire`뿐 아니라 `POST /api/booking`·`POST /api/payment`가 `hold_expired`를 응답으로 돌려주는 분기(제출 시점에 서버가 이미 만료를 감지한 경우)도 같은 이유로 `/result`로 보내야 했다 — 원안 영향 범위는 타이머 분기만 명시했으나 구현 중 두 응답 분기를 모두 정정했다. 서버 가드 쪽은 원안대로 `getOwnedHold`가 `null`일 때 `stageTimings.seat_selection.exitedAt` 존재 여부로 `/seats`(애초에 hold 없었음)와 `/result`(hold를 보유했다가 상실)를 구분했다. 실제 로컬 dev 서버에서 hold가 5분 자연 만료되는 것을 Playwright로 대화형 검증하는 과정에 우연히 재현되어(클라이언트 타이머 만료 → `/result` 자동 이동 → `SEAT_LOST` 정확히 표시, `SimulationRun.status` `COMPLETED` 전이 확인) 실 경로가 그대로 검증됐다.
  - See: `tasks/012-result-report-feedback.md`
- [x] **D-10. `releaseHold`가 `getOwnedHold` 호출 전 만료 hold 스윕 누락** (Phase 3 진행 중 발견 — Task 011 설계·구현 중 발견·수정): `attemptPayment`(`lib/payment.ts`)와 `confirmBookingInfo`(`lib/booking.ts`)는 `getOwnedHold` 호출 전에 항상 `expireStaleHolds`로 만료된 hold를 먼저 스윕하는데, `releaseHold`(`lib/seats.ts`, `POST /api/holds/release`의 `sendBeacon` 경로)만 이 스윕 없이 `getOwnedHold`를 호출하고 있었음 — `getOwnedHold`는 `releasedAt`만 보고 `expiresAt`을 독립적으로 검사하지 않는 계약이라, 이미 시간상 만료됐지만 아직 스윕되지 않은 hold를 이 경로로 release하면 "세션이 스스로 놓아버린 hold"로 오인됨 → **결정: `releaseHold` 시작부에 `expireStaleHolds` 호출을 추가해 다른 두 호출자와 계약 통일**
  - **실제 영향**: 결제 에러(`payment_error`) 직후 사용자가 탭을 닫아 `sendBeacon`이 만료된 hold를 release하면, 원래 `hold_expired`(→ 결과 `SEAT_LOST`)여야 할 것이 `payment_abandoned`(→ 결과 `PAYMENT_FAILED`)로 잘못 기록되는 outcome 오분류 버그였음
  - **영향 범위**: `lib/seats.ts`의 `releaseHold` — Task 009(hold 로직 최초 구현) 코드 수정
  - **구현**: `releaseHold`에 `await expireStaleHolds({ runId, now })` 추가, `app/api/holds/release/route.test.ts`에 회귀 테스트 2건 추가(이미 만료-미스윕 → `hold_expired`, 아직 유효 → 기존대로 `payment_abandoned`)
  - See: 커밋 `d280ff6` (별도 task 파일 없이 커밋에만 기록됨 — 이번엔 ROADMAP 본문 항목만 사후 보완)
- [x] **D-11. 홈페이지가 더미 콘서트 데이터(`getDummyConcert()`)를 계속 표시 — 실제 Concert row로 교체 안 됨** (Task 011-1 통합 회귀 테스트(`tasks/013-integration-regression-testing.md`) 진행 중 발견): `app/page.tsx`는 Task 005(UI 더미 데이터)에서 만들어진 뒤, 백엔드(Task 006~011)가 실제 `Concert` 테이블과 `prisma/seed.ts` 시딩을 갖춘 이후에도 여전히 `lib/dummy-data.ts`의 `getDummyConcert()`(호출 시점 기준 "+60초"를 `openAt`으로 매번 새로 생성하는 로컬 픽스처)를 그대로 쓰고 있었음 — `POST /api/queue`(`lib/queue.ts`)는 실제 시딩된 `Concert.openAt`으로 `SALE_NOT_OPEN`을 판정하는데, 홈 화면의 카운트다운·타이틀·장소는 이 값과 무관한 가짜 데이터였음 → **결정: `app/page.tsx`를 Server Component로 전환해 `prisma.concert.findFirst()`(`POST /api/session`과 동일한 "단일 시딩 콘서트" 해석 규칙)로 실제 row를 읽고, 상호작용 상태(티어 선택·카운트다운)만 client component로 분리**
  - **실제 영향**: 홈 화면의 카운트다운이 가리키는 "오픈 시각"과 `/api/queue`가 실제로 판정하는 오픈 시각이 서로 무관하게 따로 놀았음 — 화면이 "Sale is open"으로 바뀌어 Book Now가 활성화돼도 실제 오픈 전이면 대기열 진입이 `SALE_NOT_OPEN`으로 거부될 수 있고, 반대로 화면은 아직 카운트다운 중인데 실제로는 이미 오픈된 상태를 사용자가 볼 수도 있었음. 콘서트 제목·장소도 항상 "NEBULA LIVE 2026" / "Olympic Hall, Seoul"로 고정 표시되어 시딩 데이터와 무관했음
  - **영향 범위**: `app/page.tsx`(Task 005-2에서 최초 작성, Task 006 이후 백엔드 연동이 반영되지 않은 채 방치) — 이미 완료·병합된 코드 수정 필요
  - **구현**: `app/page.tsx`를 async Server Component로 전환(`prisma.concert.findFirst()`, 콘서트가 없으면 더미 데이터로 폴백하지 않고 안내 메시지 렌더링). Next.js 16 레거시 캐싱 모델(이 프로젝트는 `cacheComponents` 미사용)에서 순수 Prisma 호출은 Request-time API로 감지되지 않아 빌드 타임에 정적 캐시될 위험이 있어 `export const dynamic = "force-dynamic"`을 명시. 기존 UI/상호작용 로직은 `app/HomeView.tsx`(client component)로 옮기고, `app/booking/BookingViewLoader.tsx`와 동일한 이유로 `app/HomeViewLoader.tsx`(`next/dynamic({ ssr: false })`)를 경유해 렌더링. `lib/dummy-data.ts`의 `getDummyConcert`/`DummyConcert`는 더 이상 어디서도 쓰이지 않아 제거(`TIER_LABELS`는 유지). 회귀 테스트: `app/page.test.tsx` 신규 — `prisma.concert.findFirst`를 모킹해 (1) 실제 row의 title/venue/openAt이 그대로 `HomeViewLoader`에 전달되는지, (2) row가 없을 때 더미 데이터로 폴백하지 않고 안내 메시지를 렌더하는지 검증
  - **후속 보강(사용자 요청)**: `getDummyConcert()`가 갖고 있던 "방문할 때마다 `openAt`이 호출 시점
    +60초로 리셋되어 항상 데모 가능한 카운트다운을 보여주는" 특성이 D-11 수정으로 함께 사라진 걸
    사용자가 지적 — `Concert.openAt`을 매번 `UPDATE`하는 방식(여러 사용자가 동시 접속하면 서로 값을
    덮어씀)은 배제하고, `app/page.tsx`에 순수 함수 `resolveDisplayOpenAt(openAt, now)`를 추가해
    **표시 전용**으로 처리: 실제 `openAt`이 이미 과거면 "이번 요청의 `now` + 60초"로 보여주고, 아직
    미래면 그대로 통과시킴. DB row는 전혀 쓰지 않고 요청마다 새로 계산하므로 동시 접속자끼리 값이
    꼬일 여지가 없고, 표시가 백엔드보다 "더 보수적"(잠깐 더 기다리게 함)일 수는 있어도 그 반대(표시는
    열렸다는데 백엔드가 거부하는 D-11의 원래 증상)는 구조적으로 재현 불가능. **이 +60초 로직은 D-14에서
    백엔드용 `resolveQueueOpenAt`과 이름이 비슷해 한때 "같은 로직을 공유"하도록 합쳐졌다가, 그게 실제로는
    별도 버그를 냈다는 게 수동 검증 중 드러나 다시 분리됨 — 자세한 내용은 D-14 참고. 이 함수 자체(표시
    전용, +60초 폴백)는 그대로 유지**. 회귀 테스트: `app/page.test.tsx`에 `resolveDisplayOpenAt`
    단위 테스트(미래 통과/과거 보정) + `HomePage()` 통합 테스트(가짜 시스템 시각으로 두 분기 모두
    확인) 추가. **단, 이 보강은 표시 레이어에만 적용되고 `lib/queue.ts`의 실제 순번 계산은 여전히
    stale한 `Concert.openAt`을 읽고 있어 화면-백엔드가 다시 어긋나 있었음 — D-14에서 근본 수정**
  - See: `tasks/013-integration-regression-testing.md`
- [x] **D-12. `QueuePoller`가 `POST /api/queue` 실패(`SALE_NOT_OPEN`)도 "합류 성공"으로 취급 — 다음 poll이 `GET`으로 바뀌어 잘못된 에러 메시지로 덮어씀** (D-11 재검증(오픈 전 대기열 진입 시나리오, Playwright + `/api/dev/timewarp`) 중 발견): `app/queue/QueuePoller.tsx`는 첫 요청의 `res.ok` 여부와 무관하게 `hasJoinedRef.current = true`를 먼저 세팅한 뒤에야 실패 분기를 확인하고 있었음 — 그 결과 오픈 전이라 첫 `POST /api/queue`가 403 `SALE_NOT_OPEN`으로 거부돼도 다음 poll은 (실제로는 큐에 합류한 적이 없는데도) `GET`으로 바뀌고, `GET`은 큐 엔트리가 없어 404를 반환해 화면 메시지가 올바른 "Ticket sale has not opened yet."에서 잘못된 "Not currently in the queue. Call POST /api/queue first."로 덮어써짐 → **결정: `hasJoinedRef.current = true`를 `res.ok`인 성공 분기 안으로 옮겨, 실제로 합류에 성공했을 때만 다음 poll이 `GET`을 쓰도록 정정**
  - **실제 영향**: 오픈 전에 대기열에 진입하려 한 사용자가 처음엔 맞는 이유("아직 오픈 안 함")를 보다가 2초 뒤 자동 재시도에서 원인을 알 수 없는 엉뚱한 메시지("대기열에 없음")로 바뀌는 걸 보게 됨 — 실제 오류 원인(오픈 전)을 사용자가 다시 알 수 없게 됨
  - **영향 범위**: `app/queue/QueuePoller.tsx` — Task 008(대기열 폴링 최초 구현) 코드 수정
  - **구현**: `hasJoinedRef.current = true`를 `!res.ok` 분기 이후, 성공 분기(`await res.json()` 앞)로 이동. 회귀 테스트: `app/queue/QueuePoller.test.tsx` 신규(첫 테스트 파일) — (1) 403 응답이 반복돼도 재시도가 계속 `POST`를 쓰고 원래 에러 메시지가 유지되는지, (2) 실제 합류 성공(200) 이후에는 다음 poll이 `GET`으로 바뀌는지 검증. 테스트 작성 중 별도로, `next/navigation`의 `useRouter` 목이 매 렌더마다 새 객체를 반환하면 `QueuePoller`의 poll effect(`useEffect(..., [router])`, 실제 Next.js `useRouter()`는 안정된 참조라 프로덕션에는 없는 문제)가 무한 재실행되는 테스트 전용 함정을 발견해, 목을 모듈 스코프의 단일 객체로 고정해 회피함
  - See: `tasks/013-integration-regression-testing.md`
- [x] **D-13. `joinQueue`가 "이전 WAITING entry 조회 → 만료 → 신규 생성"을 원자적으로 처리하지 않아, 동시 요청 시 세션당 `QueueEntry`가 중복 생성됨** (Task 011-1 "전체 플로우 × 3티어" E2E 검증 중 발견): `/queue` 진입 직후 `POST /api/queue`가 거의 동시에 두 번 발생하는 걸 Playwright로 관찰(dev의 React Strict Mode가 `QueuePoller`의 poll effect를 이중 실행시켜 재현됐지만, 근본 원인은 클라이언트가 아니라 서버였음) — `joinQueue`(`lib/queue.ts`)의 "이전 `WAITING` entry가 있는지 조회 → 있으면 만료 처리 → 새로 생성" 로직이 `pollQueue`의 `FOR UPDATE`와 달리 잠금 없이 수행되어, 두 트랜잭션이 READ COMMITTED 하에서 서로의 커밋 전 insert를 못 보고 각자 "이전 entry 없음"으로 판단해 세션 하나에 `QueueEntry` 2개(둘 다 `WAITING`)를 만들었음 → **결정: hold 로직(Task 009, `claimSeat`의 원자적 conditional UPDATE + `Hold`의 부분 유니크 백스톱)과 동일한 이중 방어 패턴 채택 — (1) `joinQueue` 트랜잭션 시작 시 `SELECT ... FROM "SimulationRun" WHERE id = $1 FOR UPDATE`로 잠가 동시 호출을 진짜로 직렬화, (2) `QueueEntry`에 `@@unique([simulationRunId], where: raw("status != 'EXPIRED'"))` 부분 유니크 인덱스를 백스톱으로 추가**
  - **실제 영향**: dev 전용 현상이 아님 — React Strict Mode의 effect 이중 실행은 프로덕션 빌드엔 없지만, 근본 원인(`joinQueue`의 non-atomic 체크)은 프로덕션에도 그대로 남아 있어 **같은 세션으로 두 탭을 열어 거의 동시에 `/queue`에 진입**하면 동일하게 재현됨. 고아 `WAITING` row가 영구히 남고(`pollQueue`는 `joinedAt DESC LIMIT 1`이라 최신 것만 보므로 사용자 경험상 티는 안 나지만 데이터 정합성이 깨짐), `QueueEntry`에 "세션+런당 활성 entry 1개" 제약이 스키마 레벨에 전혀 없었음
  - **영향 범위**: `lib/queue.ts`의 `joinQueue`, `prisma/schema.prisma`의 `QueueEntry` 모델 — Task 008(대기열 조인 최초 구현) 코드/스키마 수정
  - **구현**: `joinQueue` 트랜잭션 맨 앞에 `SimulationRun` row `FOR UPDATE` 잠금 추가(런은 `sessionId` 1개에 귀속되므로 이 잠금이 세션 스코프 직렬화와 동일한 효과). `prisma/migrations/20260824034819_queue_entry_active_unique`로 `queue_entry_active_unique` 부분 유니크 인덱스 추가(기존 DB에 이미 있던 동일 버그로 인한 중복 row 6건은 마이그레이션 적용 전 최신 것만 남기고 정리). 회귀 테스트: `lib/queue.test.ts`에 "serializes two concurrent joins..." 케이스 추가 — 동일 세션+런으로 `joinQueue`를 `Promise.all`로 동시 호출해 활성 entry가 정확히 1개(+ `queue_reset` 이벤트 1건)만 남는지 검증. 잠금 코드를 임시로 비활성화해 이 테스트가 실제로 실패하는 것(부분 유니크 제약 위반으로 트랜잭션이 에러)을 확인한 뒤 복원함
  - See: `tasks/013-integration-regression-testing.md`
- [x] **D-14. 대기열 초기 순번이 여전히 stale한 `Concert.openAt` 기준으로 계산돼, D-11 후속 보강(표시 전용 `resolveDisplayOpenAt`)과 실제 백엔드 계산이 다시 어긋남** (사용자가 SMALL/MEGA 티어를 빠르게 클릭해도 대기열 순번이 비정상적으로 크고(1,205,391 / 12,043,764) 티어 차이가 체감이 안 된다고 보고 — DB 직접 조회로 재현: `Concert.openAt`이 시딩 시점(`2026-08-24T03:30:07Z`)에 고정된 채 갱신되지 않아, 테스트 시점까지의 실제 경과 시간(~2.8일)이 `arrivalRatePerSec × 경과초` 공식(D-4)을 지배해버림 — 티어별 배율(5 vs 50) 자체는 정확히 10배로 정상 작동 중이었음): D-11 후속 보강은 홈 화면 카운트다운만 "이미 지난 `openAt`이면 이번 요청의 `now`+60초로 표시"하도록 고쳤을 뿐 DB에는 전혀 쓰지 않는 표시 전용 수정이었는데, `lib/queue.ts`의 `joinQueue`(`SALE_NOT_OPEN` 판정 + D-4 초기 순번 계산)는 여전히 진짜 stale한 `Concert.openAt`을 그대로 읽고 있어 화면이 보여주는 "오픈 시각"과 백엔드가 실제로 계산에 쓰는 "오픈 시각"이 다시 따로 놀았음 → **결정: `SimulationRun`에 이 런 전용 `queueOpenAt` 필드를 추가하고, `POST /api/session`이 런 생성 시점에 새 순수 함수 `resolveQueueOpenAt(concert.openAt, now)`(`lib/simulation.ts`)로 한 번 스냅샷해 저장. `lib/queue.ts`는 `Concert.openAt` 대신 이 값을 읽도록 변경**
  - **왜 매 요청마다 재계산하지 않고 세션 생성 시점에 한 번만 스냅샷하는지**: D-4가 이미 `QueueEntry.position`을 join 시점에 한 번 확정한 뒤 `pollQueue`에서는 `joinedAt` 기준으로 감소만 시키고 `openAt`을 다시 읽지 않는 원칙을 갖고 있음 — `queueOpenAt`은 그 D-4 계산에 직접 들어가는 입력이므로 같은 이유로 한 번만 고정돼야 함. 만약 `joinQueue` 안에서 매번 `resolveQueueOpenAt`을 다시 호출한다면, `POST /api/session` 이후 실제로 대기열에 진입하기까지 시간이 걸린 세션은 "실질 오픈 시각"이 계속 뒤로 밀려, D-4가 지키려던 "오픈 시각에 가깝게 들어올수록 좋은 순번" 신호가 무력화됨
  - **왜 `Concert.openAt`을 직접 고치지 않는지**: D-11 후속 보강이 이미 확인한 것과 동일한 이유 — `Concert`는 모든 세션이 공유하는 단일 row(`SimulationRun`/`QueueEntry`가 `simulationRunId`로 세션별로 스코프되는 D-1과 대조적)라, 세션 시작마다 `Concert.openAt`을 갱신하면 동시 접속 중인 다른 세션의 `SALE_NOT_OPEN` 판정과 대기열 순번이 예고 없이 바뀌어버림. `queueOpenAt`을 `SimulationRun`(D-1이 이미 세션별 독립 스코프로 정한 테이블)에 두면 이 문제가 애초에 발생하지 않음
  - **구현 중 수동 E2E 검증으로 드러난 2차 버그(및 정정)**: 최초 구현은 `resolveQueueOpenAt`을 `app/page.tsx`의 `resolveDisplayOpenAt`과 "동일 로직"으로 만들어 `lib/simulation.ts`로 합치고 `app/page.tsx`에서 재수출하는 방식이었음(과거 `openAt`이면 `now + 60초`) — 그런데 브라우저로 SMALL 티어를 선택해 카운트다운이 끝나자마자 Book Now를 눌러보니 `/queue`가 "Ticket sale has not opened yet."을 반환함을 발견. 원인: 홈 화면의 +60초는 "이미 지난 stale한 openAt에 카운트다운 애니메이션을 붙이기 위한 표시 전용 눈속임"인데, 이걸 `POST /api/session`에도 그대로 적용하면 세션 생성 시각 기준으로 또 다른 +60초가 새로 발생함 — 즉 stale한 `Concert.openAt`에 대해서는 **세션을 시작할 때마다 매번 실제로 60초를 더 기다려야만 대기열에 들어갈 수 있는** 회귀가 생김(D-14 적용 전에는 이 지연이 아예 없었음 — 순번 숫자만 컸을 뿐 즉시 입장은 됐음) → **정정: 두 함수를 다시 분리**. `lib/simulation.ts`의 `resolveQueueOpenAt`은 과거 `openAt`을 `now + 60초`가 아니라 **`now` 그 자체**로 클램프(대기열 게이트/순번 계산용, 인위적 지연 없음). `app/page.tsx`의 `resolveDisplayOpenAt`(+60초 폴백, 표시 전용)은 원래 위치에 그대로 유지 — 두 함수는 이름만 비슷할 뿐 의도적으로 서로 다른 폴백을 가짐
  - **영향 범위**: `prisma/schema.prisma`(`SimulationRun.queueOpenAt` 추가), `lib/simulation.ts`(`resolveQueueOpenAt` 신설), `app/api/session/route.ts`(런 생성 시 스냅샷), `lib/queue.ts`(`joinQueue`의 게이트/초기 순번 계산 대상 변경), `lib/dev-timewarp.ts` + `lib/types.ts`(D-7의 `openInMs`가 이제 `SimulationRun.queueOpenAt`을 직접 갱신 — 더 이상 공유 row를 건드리지 않으므로 기존 `SHARED_CONCERT_WARNING` 경고 제거)
  - **구현**: `prisma/migrations/20260826224632_simulation_run_queue_open_at`로 `queueOpenAt DateTime @default(now())` 추가(기존 테스트 픽스처 다수가 `POST /api/session`을 거치지 않고 직접 `SimulationRun`을 만들기 때문에 기본값 필요). 회귀 테스트: `lib/queue.test.ts`/`app/api/queue/route.test.ts`의 런 생성 헬퍼가 `openAt` 파라미터와 동일한 값을 `queueOpenAt`에도 반영하도록 수정, `app/api/dev/timewarp/route.test.ts`의 `json.concert` 계열 단언을 `json.queueOpen`으로 갱신, `app/api/session/route.test.ts`에 생성된 런의 `queueOpenAt`이 `resolveQueueOpenAt(concert.openAt, now)`와 일치하는지 확인하는 케이스 추가. 자동 테스트(187개) 통과 후에도 Chrome으로 실제 홈→Book Now→대기열 플로우를 SMALL로 직접 재현해 위 2차 버그를 잡아냈고, 수정 후 재검증에서 즉시 정상적인 소수 순번으로 입장되는 것을 확인함
  - See: 사용자 보고 (2026-08-26)
---

## 개발 워크플로우

1. **작업 계획**
   - 기존 코드베이스를 학습하고 현재 상태를 파악
   - 새로운 작업을 포함하도록 `ROADMAP.md` 업데이트
   - 우선순위 작업은 마지막 완료된 작업 다음에 삽입

2. **작업 생성**
   - `/tasks` 디렉토리에 새 작업 파일 생성 (명명 형식: `XXX-description.md`, 예: `001-project-skeleton.md`)
   - 고수준 명세서, 관련 파일, 수락 기준, 구현 단계 포함
   - **API/비즈니스 로직 작업 시 "## 테스트 체크리스트" 섹션 필수 포함** (Playwright MCP E2E 시나리오 작성)
   - 마지막 완료 작업을 예시로 참조 (현재가 `007`이면 `006`, `005` 참조). 초기 상태 샘플은 `000-sample.md` 참조 — 새 작업 문서는 빈 체크박스 + 변경 사항 요약 없음 상태로 시작

3. **작업 구현 (구현 → 테스트 → 검증 순서)**
   - **Step 1: 기능 구현** — 명세서 세부 사항 완성
   - **Step 2: 단위 테스트 (Vitest)** — API 엔드포인트별(정상/에러), 비즈니스 로직 입출력, DB 상호작용(특히 트랜잭션 락) 검증. 락 테스트는 실제 테스트 DB 사용 (모킹 금지)
   - **Step 3: E2E 테스트 (Playwright MCP 필수)** — 전체 사용자 플로우, API 통합, 에러/엣지 케이스, 브라우저 상호작용 검증
   - **Step 4: 검증 및 버그 수정** — 모든 테스트 통과 확인 → 실패 원인 파악·수정 → 재테스트
   - **테스트 통과 후에만 완료 인정** (테스트 없는 구현은 미완료 상태)

4. **로드맵 업데이트**
   - 완료된 작업을 ✅로 표시하고 `See: /tasks/XXX-xxx.md` 참조 추가

---

## 개발 단계

### Phase 1: 애플리케이션 골격 구축 (Before First Commit) ✅

> **관련 기능:** 전 기능의 선행 인프라 | **목표:** 코드베이스 골격 + 스키마 + 시뮬레이션 스켈레톤 확립
>
> **착수 조건:** 사전 결정 사항 D-1, D-2 확정

- **Task 001: 프로젝트 구조 · 라우팅 · 테스트 환경 설정** ✅ - 완료 (See: `/tasks/001-project-skeleton.md`)
  - Next.js 16 App Router 기반 전체 라우트 구조 생성 (`app/page.tsx` 홈, `queue/`, `seats/`, `booking/`, `payment/`, `result/`)
  - 모든 주요 페이지의 빈 껍데기 파일 생성 (선형 진행 플로우: 홈 → 대기열 → 좌석 → 예매정보 → 결제 → 결과)
  - API 라우트 구조 빈 핸들러 생성 (`api/session/`, `api/queue/`, `api/seats/`, `api/booking/`, `api/payment/`)
  - 공통 레이아웃 컴포넌트 골격 구현 (`app/layout.tsx` 메타데이터 포함)
  - **Vitest 셋업** (CLAUDE.md 권장 사항 반영): 설정 파일, 테스트 DB 연결 헬퍼, `npm run test` 스크립트 — Task 006부터 단위 테스트가 필요하므로 골격 단계에서 준비
  - Next.js 16 route handler 시그니처를 `node_modules/next/dist/docs/`에서 확인 후 적용

- **Task 002: DB 스키마 · Prisma · 환경 설정** ✅ - 완료 (See: `/tasks/002-db-schema-prisma.md` — 실제 Neon 연결은 미검증, 로컬 Postgres 드라이런으로 마이그레이션/제약 검증)
  - **관련 데이터 모델:** Concert, Seat, Hold, Booking, QueueEntry, SimulationConfig, SessionResult (+ 시뮬레이션 인스턴스 상태)
  - `schema.prisma` 작성 (PostgreSQL + `@prisma/adapter-neon` serverless 어댑터)
  - **크리티컬 스키마 제약 반영 (CLAUDE.md 검증 항목):**
    - `Hold`: `UNIQUE(seatId) WHERE expiresAt > now()` 부분 유니크 제약으로 이중 hold 방지
    - `QueueEntry.joinedAt` (DateTime, 순번 감소 계산 기준), `SimulationConfig.admissionRatePerSec` (Float) 필드 포함
    - 인덱스: `Seat.concertId`, `Hold.expiresAt`, `Hold(seatId, expiresAt)` 부분 유니크, `QueueEntry(concertId, sessionId)`
  - **tick 엔진 상태 영속화 (PRD 데이터 모델의 누락 보완):**
    - tick-on-request 패턴의 기준 시각 `lastTickAt` (DateTime) 필드를 시뮬레이션 인스턴스 단위에 추가 — D-1 결정에 따라 `SimulationRun.lastTickAt`(인스턴스제) 또는 `Concert.lastTickAt`(전역제)
    - 봇 선점 진행 상태의 결정론 유지에 필요한 값(예: 봇 누적 처리 카운터 또는 시드)도 함께 영속화
  - **시뮬레이션 인스턴스/리셋 반영 (D-1 결정 사항):** 인스턴스제 채택 시 `SimulationRun` 모델(`id`, `sessionId`, `tier`, `lastTickAt`, `status`) 추가 및 `Seat`/`QueueEntry`에 스코프 키 연결, "다시 도전" 시 새 run 생성 방식 정의
  - **티어 저장 위치 반영 (D-2 결정 사항):** 선택 티어를 기록할 필드 확정 (`SimulationRun.tier` 또는 `QueueEntry.tier`)
  - `.env.local` (Neon **pooled** connection — `-pooler` 접미사 필수) + `.env.example` 작성
  - Prisma client 싱글톤 (`lib/db.ts`) 구현
  - 초기 마이그레이션 실행 + seed 스크립트 (가상 콘서트 1개 + 200석 배치 템플릿 + 소/중/메가 `SimulationConfig` 3티어)

- **Task 003: 타입 정의 및 시뮬레이션 엔진 스켈레톤** ✅ - 완료 (See: `/tasks/003-types-simulation-skeleton.md`)
  - `lib/types.ts`에 공유 타입 정의 (Tier enum, SeatStatus, QueueStatus, API 요청/응답 타입, 결과 outcome/event 타입, 판단 이벤트 타입 — Task 008~010 기록용 이벤트 스키마 사전 확정)
  - `lib/simulation.ts` **tick-on-request 패턴 스켈레톤** stub 구현:
    - 매 요청마다 `now - lastTickAt` 경과 시간만큼 시뮬레이션 전진 (`lastTickAt`은 DB에서 읽고 갱신)
    - 봇 강도 × 경과 시간 = 봇이 선점할 좌석 **수 계산** (F008 준비 — 실제 선점 실행은 Task 009의 hold 트랜잭션에 위임)
    - 순번 = `joinedAt` 기준 `admissionRatePerSec × 경과 시간`만큼 감소 (F003 준비)
    - hold 만료 = `expiresAt < now` lazy 체크 (F007 준비)
    - **결정론적 보장**: 같은 입력 = 같은 출력 (serverless 적합)
  - 실제 로직은 Phase 3에서 채우고, 여기서는 함수 시그니처와 인터페이스만 확정

---

### Phase 2: UI/UX 완성 (더미 데이터 활용) ✅

> **관련 기능:** 전 페이지 UI (F001, F002, F005 시각, F013, F014 폼, F011 리포트) | **목표:** 백엔드 없이 전체 플로우를 체험 가능한 화면 완성

- **Task 004: 공통 컴포넌트 · 디자인 시스템 · 더미 데이터** ✅ - 완료 (See: `/tasks/004-design-system-common-components.md`)
  - TailwindCSS 4 기반 디자인 시스템 및 스타일 가이드 확립 (자체 브랜드 정체성 — 특정 플랫폼 UI 복제 금지)
  - 공통 컴포넌트 구현: 단계 진행 인디케이터, 카운트다운 타이머, hold 잔여 타이머, 좌석 셀, 모달/결제창, 경고 배너
  - **좌석 상태 3색 규칙**: available 보라("포도알") / held 구분색 / sold 회색 (F005 시각 문법)
  - 더미 데이터 생성 유틸리티 작성 (더미 콘서트, 200석 배치, 대기열 순번, 결과 리포트 샘플)

- **Task 005: 모든 페이지 UI 완성 (하드코딩 더미 데이터)** ✅ - 완료 (See: `/tasks/005-all-pages-ui-dummy-data.md`) — 작업량이 많아 아래 8개 서브태스크로 분할
  - **Task 005-1: 공통 기반** ✅ - 완료 (See: `/tasks/005-1-shared-state-zone-helper.md`) — 페이지 간 상태 전달 방식 확정(티어는 `?tier=` 쿼리, 선택 좌석은 `sessionStorage`), `Seat.number` 기준 5구역(Block A~E) 그룹핑 헬퍼
  - **Task 005-2: 홈 페이지** (F001, F002) ✅ - 완료 (See: `/tasks/005-2-home-page.md`) — 소/중/메가 3티어 선택 카드 + 티어별 난이도 설명, 가상 콘서트 정보, 오픈 카운트다운, 정각 전 비활성 → 정각 후 활성 "예매하기" 버튼
  - **Task 005-3: 대기열 페이지** (F003, F004) ✅ - 완료 (See: `/tasks/005-3-queue-page.md`) — 순번/앞 대기 인원/예상 시간 표시, "새로고침 시 순번 초기화" 상시 경고 배너
  - **Task 005-4: 좌석 선택 페이지** (F005) ✅ - 완료 (See: `/tasks/005-4-seat-selection-page.md`) — 구역 선택(5개 블록, 무대 거리 기준 명명) 미리보기 → 구역 클릭 시 해당 구역 좌석맵 3색 렌더링, 좌석 클릭 피드백 UI, hold 타이머, "좌석 선택 완료" 버튼. 실제 대형 아이돌 콘서트장(KSPO돔류 원형 다층 아레나)의 구조감을 참고하되 특정 공연장 도면은 복제하지 않음. 스키마/백엔드 변경 없음
  - **Task 005-5: 예매 정보 페이지** (F013) ✅ - 완료 (See: `/tasks/005-5-booking-info-page.md`) — 선택 좌석 + hold 잔여 시간, 매수 1매 고정, 수령 방법 선택, 약관 동의 체크박스, "결제하기" 버튼(전체 동의 시 활성)
  - **Task 005-6: 결제 페이지** (F014) ✅ - 완료 (See: `/tasks/005-6-payment-page.md`) — 결제 수단 선택(간편결제/카드 더미 폼/무통장입금), 모의 결제창 모달, 에러 화면 UI
  - **Task 005-7: 결과 리포트 페이지** (F011) ✅ - 완료 (See: `/tasks/005-7-result-page.md`) — 성공/실패 표시, 단계별 소요 시간 타임라인, 경합 패배 횟수, 판단 피드백, "다시 도전" 버튼
  - **Task 005-8: 전체 플로우 통합 검증** ✅ - 완료 (See: `/tasks/005-8-e2e-verification.md`) — 더미 상태로 홈→결과 전체 선형 플로우 이동 검증(성공/실패 각 1회), 타입 체크·린트, ROADMAP 갱신

---

### Phase 3: 핵심 기능 구현 (더미 → 실제 API 교체)

> **관련 기능:** F012, F001~F011, F013, F014 | **목표:** tick 엔진과 트랜잭션 락을 실제 구현하고 더미 데이터를 실 API로 교체
>
> **의존 순서 (반드시 준수):** 익명 세션(006) → 시뮬레이션 엔진(007) → 대기열·토큰(008) → 좌석맵·hold 원자성(009) → 예매정보·결제(010) → 결과 리포트(011) → 통합 테스트(011-1)
>
> **관측 데이터 원칙:** `stageTimings`·`contentionLosses`·판단 이벤트는 **발생하는 Task(008~010)에서 즉시 기록**한다. Task 011은 기록된 데이터의 집계와 피드백 매핑만 수행한다.

- **Task 006: 익명 세션 시스템 · 시뮬레이션 시작 API 구현 (F012, F001 백엔드)** ✅ - 완료 (See: `/tasks/006-anonymous-session-simulation-start.md`)
  - **선행 조건 근거:** 대기열 순번·hold 소유자·예매 전체의 사용자 식별 기반 → 최우선
  - HTTP-only, 서명 쿠키로 UUID 세션 발급 (`api/session/`) — 회원가입/로그인 없음
  - 모든 API 요청에서 세션 검증 미들웨어 구현
  - **티어 선택 수신·기록 (F001 백엔드, D-2 결정 반영):** 시뮬레이션 시작 요청에서 티어 값을 받아 시뮬레이션 인스턴스(`SimulationRun`)/`QueueEntry`에 기록 — 이후 tick 엔진·에러 주입이 이 값을 참조
  - **시뮬레이션 인스턴스 생성·리셋 (D-1 결정 반영):** 시작 시 새 run 생성(200석 seed 복제 또는 상태 초기화), "다시 도전" 시 기존 run 종료 + 새 run 생성
  - **테스트 체크리스트:**
    - 단위: 신규 세션 발급, 기존 쿠키 재사용, 서명 위변조 쿠키 거부, 티어 값 기록·조회, run 생성/리셋 시 좌석 상태 초기화
    - E2E (Playwright MCP): 최초 접속 시 쿠키 자동 발급 확인, 쿠키 삭제 후 새 세션 발급, 세션 지속성, 티어 선택 → 시작 → 인스턴스 생성 확인

- **Task 007: tick-on-request 시뮬레이션 엔진 구현 (F007, F008 계산 코어)** ✅ - 완료 (See: `/tasks/007-simulation-tick-engine.md`)
  - **선행 조건 근거:** 대기열 순번(F003)·hold 만료(F007)·경쟁 봇(F008)·결제 실패 주입(F009)이 모두 이 엔진에 의존 → 대기열/좌석 기능보다 먼저 완성·검증
  - **범위 경계 (순환 의존 방지):** 본 Task는 **순수 계산 로직**까지만 담당 — "봇이 이번 tick에 몇 석을 선점해야 하는가", "순번이 얼마나 감소하는가", "어떤 hold가 만료 대상인가"를 결정론적으로 산출. **실제 좌석 선점 트랜잭션 실행은 Task 009에서 연결** (봇도 사용자와 동일한 hold 트랜잭션 로직을 사용하되, 그 트랜잭션 자체는 009의 산출물)
  - `lib/simulation.ts` tick 계산 로직 실제 구현:
    - DB의 `lastTickAt` 읽기 → 경과 시간(`now - lastTickAt`) 기반 봇 선점 좌석 수 산출 → `lastTickAt` 갱신 (같은 트랜잭션)
    - `admissionRatePerSec`·`joinedAt` 기반 대기열 순번 감소 계산
    - `expiresAt < now` hold lazy 만료 대상 판정
    - 티어별 `SimulationConfig` 계수(virtualQueueSize, botIntensity, errorRate, latencyMs) 반영 — 티어 값은 Task 006이 기록한 인스턴스에서 조회
  - **결정론 보장 검증** (같은 입력·타임스탬프 → 같은 출력)
  - **테스트 체크리스트:**
    - 단위: 경과 시간별 봇 선점 좌석 수 계산, 순번 감소 계산, hold 만료 판정, `lastTickAt` 갱신 원자성 (동시 tick 요청 시 이중 전진 방지)
    - 엣지: 경과 시간 0, 매우 긴 경과 시간, 봇 강도 0/최대, 남은 좌석 부족 시 봇 선점 수 상한 처리
    - 정상: 결정론 검증 — 동일 입력 반복 시 동일 출력 assert

- **Task 008: 대기열 순번 · 입장 토큰 API (F002 서버 검증, F003, F004)** ✅ - 완료 (See: `/tasks/008-queue-admission-token.md`)
  - **선행 조건:** Task 006(세션·티어), Task 007(tick 엔진)
  - **오픈 시각 서버 측 검증 (F002 백엔드):** `openAt` 이전의 대기열 진입 요청은 서버가 거부 — 버튼 비활성화(UI)만으로는 우회 가능하므로 API 레벨 차단 필수
  - `api/queue/` 구현: 대기열 진입(`QueueEntry` 생성, `joinedAt` 기록), 순번 폴링(2초 간격, tick 기반 감소), 이탈/새로고침 시 순번 리셋
  - 순번 도달 시 **입장 토큰 발급** — 랜덤·비추측 가능 토큰 + `sessionId` 바인딩 + **1회성 검증**(사용 시 무효화, 새치기 방지)
  - 좌석 선택 페이지 접근 시 토큰 검증 미들웨어 (무효 시 대기열로 리디렉션)
  - **관측 데이터 기록:** 대기열 진입·토큰 발급 시각을 `stageTimings`용으로 기록, 새로고침 리셋 발생을 판단 이벤트로 기록
  - 대기열/좌석 페이지 더미 데이터 → 실 API 교체
  - **테스트 체크리스트:**
    - 단위: 진입 시 순번 부여, 폴링 시 tick 반영 감소, 리셋 동작, 토큰 발급/검증/1회성 무효화, 오픈 전 진입 거부, 타이밍·이벤트 기록 검증
    - 에러: 토큰 없이 좌석 페이지 접근 차단, 위조 토큰 거부, 타 세션 토큰 재사용 거부
    - E2E (Playwright MCP): 대기열 진입 → 순번 감소 관찰 → 토큰 발급 → 좌석 자동 이동, 새로고침 시 순번 리셋, 토큰 없이 `/seats` 직접 접근 시 리디렉션

- **Task 009: 좌석맵 · 좌석 선점(hold) 원자성 API (F005, F006, F007, F008 실행)** ✅ - 완료 (See: `/tasks/009-seat-map-hold-atomicity.md`)
  - **선행 조건 근거:** 좌석 hold 트랜잭션 원자성이 예매·결제의 기반 → 예매정보/결제보다 먼저 검증
  - `api/seats/` 구현: 좌석맵 조회(200석 3색 상태, 2초 폴링 + tick 반영). 구역(Block A~E)은 Task 005-1(구역 그룹핑 헬퍼 정의) + Task 005-4(좌석 선택 페이지 적용)에서 확정된 대로 `Seat.number` 클라이언트 그룹핑을 그대로 사용 — API 응답 형태(200석 flat list) 변경 없음
  - **좌석 선점 원자성 (CLAUDE.md 크리티컬):**
    - 조건부 `UPDATE seats SET status='held' WHERE id=$1 AND status='available' RETURNING id`로 원자적 예약
    - 성공 시 **같은 트랜잭션 내** `INSERT INTO holds (seatId, sessionId, expiresAt=now+5min)`
    - 동시 클릭 시 1명만 성공, 나머지 "이미 선택된 좌석입니다"
  - **봇 선점 실행 연결 (Task 007 계산 결과 소비):** tick이 산출한 봇 선점 좌석 수만큼, 봇 세션 ID로 **사용자와 동일한 hold 트랜잭션**을 실행해 랜덤 available 좌석 선점 — 007/009의 계산·실행 분리 완성
  - hold 5분 만료 lazy 처리 (조회 시점 tick 엔진 연계)
  - **관측 데이터 기록:** 선점 실패(경합 패배) 발생 시 `contentionLosses` 카운트 증가, 선점 성공 시각 기록
  - **테스트 체크리스트:**
    - 단위: 정상 선점, 이미 held/sold 좌석 선점 실패, hold 만료 후 재선점 가능, 경합 패배 카운트 증가 검증
    - **동시성 (실제 테스트 DB, 모킹 금지):** 동일 좌석 병렬 선점 시 정확히 1건 성공 검증, 봇과 사용자 동시 경합
    - 엣지: 이중 hold 방지 유니크 제약 동작, 만료 경계 시점 처리
    - E2E (Playwright MCP): 좌석 클릭 성공/실패 피드백, 봇이 좌석 가져가는 실시간 갱신, hold 타이머 시작

- **Task 010: 예매 정보 · 결제 · 실패 대응 분기 API (F013, F014, F009, F010, F007)** ✅ - 완료 (See: `/tasks/010-booking-payment-failure-handling.md`)
  - **선행 조건:** Task 009(hold 원자성 검증 완료)
  - `api/booking/` 예매 정보 확정 (매수 1매, 수령 방법, 약관 동의) — hold 유효성 검증
  - `api/payment/` 모의 결제:
    - 수단별 소요 시간 상이 (무통장 최속, 카드 최저속) — F014
    - 티어별 `errorRate` 확률로 타임아웃/서버 에러 주입 — F009
    - **실패 대응 분기 (F010):** 결제창 닫고 재결제 → hold 유지 / 새로고침·뒤로가기 → hold 상실 + 좌석 방출 / hold 5분 만료 → 자동 해제
    - 성공 시 **같은 트랜잭션**에서 `Seat.status='sold'` + `Booking` 생성 + `Hold` 정리
  - 페이지 이탈 시 hold 해제: `navigator.sendBeacon` (베스트 에포트) + 5분 만료 안전망
  - **관측 데이터 기록:** 예매정보·결제 단계 소요 시간, 판단 이벤트(에러 발생, 에러 후 재결제, 에러 후 새로고침, hold 만료 등)를 발생 즉시 기록 — Task 011 피드백 매핑의 원천 데이터
  - 예매정보/결제 페이지 더미 → 실 API 교체
  - **테스트 체크리스트:**
    - 단위: 수단별 소요 시간, 에러 주입 확률(티어별), 결제 성공 시 sold 전환 원자성, 각 판단 이벤트 기록 검증
    - 분기 검증: 재결제(hold 유지) / 새로고침(hold 상실·좌석 방출) / 만료(자동 해제) 각 경로별 hold 상태 assert
    - 엣지: 만료된 hold로 결제 시도, 이미 sold된 좌석 결제, 결제 중 hold 만료
    - E2E (Playwright MCP): 정상 결제 성공 플로우, 에러 발생 후 재결제 성공, 새로고침 후 hold 상실 확인, hold 타이머 만료 시나리오

- **Task 011: 결과 리포트 집계·피드백 API (F011)** ✅ - 완료 (See: `tasks/012-result-report-feedback.md` — 파일명은 012지만 ROADMAP 기준 Task 011. `QUEUE_TIMEOUT`은 이번 범위에서 제외, ROADMAP D-8/D-9 참조)
  - **선행 조건:** Task 006~010 — 타이밍·이벤트는 이미 각 Task에서 기록 완료 상태. 본 Task는 **집계와 매핑만** 수행 (앞 단계 코드 재수정 없음)
  - `SessionResult` 확정: 기록된 데이터로 outcome, `stageTimings`(단계별 소요 시간 JSON), `contentionLosses`, `events`(판단 이벤트 로그 JSON) 집계
  - **규칙 기반 피드백**: 판단 이벤트(에러 후 새로고침, 재시도 성공, hold 만료 등)를 정해진 코칭 문구에 매핑, 소요 시간·패배 횟수를 티어별 기준치와 비교
  - "다시 도전" → Task 006의 리셋 API 호출로 새 시뮬레이션 인스턴스 시작
  - 결과 페이지 더미 → 실 데이터 교체
  - **테스트 체크리스트:**
    - 단위: 각 판단 이벤트 → 피드백 문구 매핑, 티어 기준치 대비 평가 로직, 집계 정확성 (기록 원천 데이터와 대조)
    - E2E (Playwright MCP): 성공 세션 → 성공 리포트, 실패(새로고침) 세션 → 올바른 대응 피드백, "다시 도전" → 홈 복귀 + 새 인스턴스 확인

- **Task 011-1: 핵심 기능 통합 테스트** ✅ - 완료 (See: `tasks/013-integration-regression-testing.md` — 파일명은 013이지만 ROADMAP 기준 Task 011-1. 진행 중 D-11~D-13 발견·수정. Neon pooled connection 부하만 로컬 환경 한계로 보류)
  - **종합 E2E 테스트 (Playwright MCP):**
    - 전체 플로우 (홈 티어 선택 → 대기열 → 토큰 → 구역 선택 → 좌석 선점 → 예매정보 → 결제 → 결과 → 다시 도전) 티어별(소/중/메가) 검증
    - 봇·사용자 좌석 경합 실제 동작, tick 엔진 결정론 통합 검증 (`lastTickAt` 이중 전진 없음 포함)
    - 동시성/경쟁 조건 테스트 (다중 세션 동일 좌석 경합)
  - **에러 핸들링 · 엣지 케이스:**
    - 오픈 전 대기열 진입 시도, 토큰 없이 좌석 접근, 만료 hold로 결제, 결제 에러 주입 후 각 분기, 세션 만료
    - Neon pooled connection 부하 시 동작 (커넥션 풀 고갈 방지 확인)
  - **관측 데이터 정합성 검증:** 리포트의 타이밍·패배 횟수·이벤트가 실제 플로우 행동과 일치하는지 대조
  - **테스트 결과 보고 및 버그 리스트 작성** → 수정 → 재테스트

---

### Phase 4: 최적화 및 배포

> **목표:** 성능·안정성 확보 및 Vercel 배포 파이프라인 구축

- **Task 012: 성능 최적화 및 배포**
  - 좌석맵 200석 폴링/렌더링 최적화, tick 엔진 쿼리 최적화
  - Neon pooled connection 프로덕션 부하 검증 (로컬 성공·프로덕션 실패 pitfall 방지)
  - Vercel 배포 파이프라인 구축 (GitHub push 자동 배포, 환경 변수 설정)
  - 에러 모니터링·로깅 구성
  - **배포 후 프로덕션 E2E 스모크 테스트 (Playwright MCP)** — 실제 serverless 환경에서 tick 엔진·트랜잭션 락 동작 최종 확인

---

## 제외 범위 (v2 스코프 — 본 로드맵 미포함)

> PRD "MVP 이후 기능(제외)" 명시 항목. MVP 완료 전까지 착수하지 않으며, 로드맵 본문과 혼동하지 않도록 별도 관리.

- 회원가입/로그인 (MVP는 익명 세션 F012로 대체)
- 보안문자(캡차) 입력 (Sprint 여유 시 스트레치 골, 기본 v2)
- 플랫폼 스킨 모드 (멜론/예스24 스타일 전환)
- 다좌석 예매 (2매 이상 원자적 hold — v2 기술 스트레치)
- 가상 아이돌/공연 랜덤 생성, 여러 공연·좌석 등급, 날짜(회차) 선택
- 랭킹/기록 비교
- 모바일 최적화
- 실제 결제 연동
- Redis 대기열
- 실제 봇 트래픽 부하 (Real Load)
- 실사용자 간 좌석 경합 (D-1에서 세션별 인스턴스제 채택 시 — 경합 상대는 MVP에선 봇)

---

## 진행 상태 범례

- **Phase 제목 + ✅**: 완료된 Phase
- **Task ✅ - 완료**: 완료 작업 (`See: /tasks/XXX-xxx.md` 참조 추가)
- **Task - 우선순위**: 즉시 시작할 작업
- **Task (표시 없음)**: 대기 중
- **구현 사항 ✅**: 완료된 세부 항목 / **-**: 미완료 세부 항목

> **완료 인정 기준:** API·비즈니스 로직 Task는 단위 테스트(Vitest) + Playwright MCP E2E 테스트를 **모두 통과한 후에만** ✅ 처리. 테스트 없는 구현은 미완료 상태로 간주.

---

## v2 확장 방향 메모 (Backend 역량 강화 목적, MVP 완료 후 논의)

> MVP(Task 006~011-1) 완료 후 착수 여부를 재논의. 목적은 신규 기능 추가가 아니라 지금 프로젝트가
> 다루지 못한 백엔드 영역(인증/인가, 캐싱, 실부하 검증)을 기존 아키텍처 위에 자연스럽게 확장하며 채우는 것.

- **1순위 — 실사용자 간 좌석 경합 (로그인 도입)**
  - 익명 세션 → 실제 유저 계정 전환, 회원가입/로그인/인가 추가
  - 현재 비어있는 "인증/인가" 경험 보완
  - PRD "제외 범위"에 이미 v2 스트레치로 명시된 방향과 일치

- **2순위 — Redis 도입 (대기열/캐싱)**
  - DB tick 기반 대기열에 Redis 캐싱 계층 추가
  - 캐시-DB 동기화(cache invalidation) 문제까지 다루면 난이도 상승
  - "언제 DB, 언제 캐시" 판단력 확보 목적

- **3순위 — 실 부하 테스트 (Real Load)**
  - k6/Artillery 등으로 동시 요청 부하 실측
  - Neon pooled connection 한계·커넥션 풀 고갈 지점 직접 검증
  - "동시성 제어를 만들었다" → "부하 상황에서 검증까지 했다"로 격상

- **4순위(선택) — 다좌석 예매 (원자적 다중 hold)**
  - 여러 좌석을 all-or-nothing으로 묶는 트랜잭션 (부분 실패 롤백, 데드락 가능성)
  - 동시성 심화 버전 — 앞 3개보다 우선순위 낮음

- **5순위 — MEGA 좌석 수를 15,000석 규모로 확장 (KSPO돔급), zone-scoped API 전환**
  - `scripts/tune-bot-intensity.ts`로 MEGA `botIntensity`를 `TIER_BENCHMARKS.maxContentionLosses`에 맞춰 역산하는 과정에서 발견: 좌석 수가 티어 무관 200석 고정이라, 평균 contentionLosses가 유의미해지려면 봇이 **첫 tick 안에 풀의 상당 비율(MEGA는 ~85%)** 을 소진해야 하는 좁고 분산이 큰 구간에서만 목표에 도달함(음의 초기하분포 특성상 목표 근처 구간이 "거의 매진" 구간과 바로 인접)
  - 이 때문에 SMALL/MEDIUM도 같은 방식으로 벤치마크에 맞추려면 botIntensity가 MEGA와 비슷한 범위까지 올라가야 해서, 좌석 수 대신 botIntensity 하나로만 티어 간 난이도를 차등화하는 데 한계가 있음이 확인됨(현재는 SMALL/MEDIUM 미조정 상태로 유지 — 2026-08-26 결정)
  - **목표 좌석 수: 15,000석** (KSPO돔 콘서트 세팅 기준 실제 좌석 수 약 14,594~14,730석 참고, 2026-08-27 결정 — 이전에 적었던 "SMALL 100석/MEGA 300~500석" 예시는 근거 없는 숫자였으므로 폐기)
  - **현재 아키텍처 용량 분석 결과** (`GET /api/seats`가 zone 무관 전체 목록을 2초마다 반환하는 구조, `app/seats/SeatsView.tsx`가 활성 zone만 DOM 마운트하는 구조 기준): API 응답 크기·DB 쿼리 비용은 zone 분할과 무관하게 총 좌석 수에 비례해 15,000석이면 poll당 ~1MB로 부담이 큼 — **zone-scoped fetch(`GET /api/seats?zone=X`)로의 전환이 필수**로 확인됨
  - **Zone 수 확대(20~30개)로 가상 스크롤 회피** — 현재 5zone 구조를 그대로 두면 zone당 3,000석이 되어 가상 스크롤(`react-window` 등)이 필요하지만, 실제 대형 경기장처럼 zone을 20~30개로 세분화하면 zone당 500~750석 수준이 되어 `React.memo` 정도의 가벼운 최적화만으로 대응 가능. Zone은 스키마 필드가 아니라 `lib/dummy-data.ts::getZoneForSeatNumber()`의 순수 계산이라 구간 상수만 바꾸면 되는 가벼운 변경 — 채택
  - Task 012 착수 시 스코프: (1) `getZoneForSeatNumber` zone 수 20~30개로 확장, (2) `GET /api/seats`를 zone-scoped 응답으로 전환, (3) `SeatCell`에 `React.memo` 적용, (4) 착수 전 15,000석 더미 데이터로 실제 프레임/응답시간 실측 스파이크 권장(위 수치는 rule-of-thumb 추정이지 벤치마크 아님)

> 순서 원칙: 매번 기존 아키텍처를 갈아엎지 않고 그 위에 얹는 확장만 선택 (MVP → 프로덕션급으로 키워가는
> 스토리가 포트폴리오 설명에서 이어지도록).

---
