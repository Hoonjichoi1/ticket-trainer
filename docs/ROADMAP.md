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
- [x] **D-15. MEGA `botIntensity` 실측 중 200석 고정 풀의 구조적 한계 발견 → 좌석 수를 티어별로 차등 확장하기로 결정** (`scripts/tune-bot-intensity.ts`로 MEGA `botIntensity`를 `TIER_BENCHMARKS.maxContentionLosses=6`에 맞춰 역산하는 과정에서 발견): 좌석 수가 티어 무관 200석 고정이다 보니, 평균 `contentionLosses`가 유의미해지려면 봇이 **첫 tick 안에 풀의 상당 비율(MEGA는 ~85%)**을 소진해야 하는 좁고 분산이 큰 구간에서만 목표에 도달함(음의 초기하분포 특성상 목표 근처 구간이 "거의 매진" 구간과 바로 인접) — SMALL/MEDIUM도 같은 방식으로 벤치마크(1/3)에 맞추려면 `botIntensity`가 MEGA와 비슷한 범위까지 올라가야 해서, 좌석 수 대신 `botIntensity` 하나로만 티어 간 난이도를 차등화하는 데 구조적 한계가 있음이 확인됨(SMALL/MEDIUM은 미조정 유지, 2026-08-26 결정) → **결정: 좌석 수 자체를 실제 콘서트장 규모로, 티어별로 차등 확장**(실제 콘서트도 소극장 vs 대형돔은 좌석 수가 다르다는 점 + PRD F001 "난이도 조절이 훈련 서비스의 기본 가치" 근거)
  - **목표 좌석 수** (2026-08-27 결정, KSPO돔 콘서트 세팅 기준 실제 좌석 수 약 14,594~14,730석 참고 — 실제 레퍼런스는 F005/Task 005-4의 "원형 다층 아레나 구조감" 참고일 뿐 좌석 수 자체는 문서에 없었으므로 이번에 별도로 확정):

    | Tier | 좌석 수 | rows × seatsPerRow | Zone 수 | 좌석/zone |
    |---|---|---|---|---|
    | SMALL | 2,500 | 25 × 100 | 8 | 313 |
    | MEDIUM | 7,000 | 70 × 100 | 15 | 467 |
    | MEGA | 15,000 | 150 × 100 | 25 | 600 |

  - **현재 아키텍처 용량 분석**: `GET /api/seats`(`app/api/seats/route.ts`)/`listSeatMap()`(`lib/seats.ts:201-208`)가 zone 무관 전체 좌석 목록을 2초마다 반환하는 구조라, API 응답 크기·DB 쿼리 비용은 zone 분할과 무관하게 총 좌석 수에 비례 — MEGA 15,000석이면 poll당 ~1MB. **zone-scoped fetch(`GET /api/seats?zone=X`) 전환 필수**로 확인됨. 반면 DOM 렌더링(`app/seats/SeatsView.tsx`)은 활성 zone만 마운트하므로 zone당 좌석 수에만 비례 — 위 표의 zone 배분(313~600석/zone)은 모두 `React.memo` 정도로 대응 가능한 범위라 가상 스크롤 불필요
  - **스키마 변경 방향**: `SimulationConfig`에 `seatRows Int`/`seatsPerRow Int`/`zoneCount Int` 필드 추가(마이그레이션 필요, `Seat` 모델은 `row`/`number`만 가지면 되므로 변경 없음), `app/api/session/route.ts`의 하드코딩된 `SEAT_ROWS`/`SEATS_PER_ROW`를 티어 파라미터화
  - **행(row) 라벨링 재검토 필요**: 현재 대문자 알파벳 1글자(A~J, 최대 26행)라 MEDIUM 70행/MEGA 150행을 못 담음 — 숫자 기반(1, 2, 3...) 라벨 전환 권장("행 번호=무대 거리감" 의미 보존, 무한 확장 가능, 실제 대형 경기장·한국 티케팅 관행과 부합). 최종 결정은 Task 012 착수 시
  - **영향 범위**: MEGA `botIntensity`도 15,000석 풀 기준으로 재실측·재튜닝 필요(200석 기준이던 기존 값 80은 무효, `scripts/tune-bot-intensity.ts` 재사용)
  - See: 사용자 요청 (2026-08-26~27) — **Task 012(신설, Phase 4)로 승격**
- [x] **D-16. Task 012에서 재튜닝한 MEGA `botIntensity`(6000)가, 실제 브라우저로 대기열을 통과해 좌석 화면에 도달한 시점 기준으로는 매 세션 100% 매진 — `scripts/tune-bot-intensity.ts`의 "elapsed 고정 2초" 측정 방법론 자체의 결함** (Task 012 Step 10 Playwright E2E 검증 중 발견: MEGA로 실제 홈→대기열→좌석 전체 플로우를 진행하니, 좌석 화면에 도달한 순간 조회한 zone의 좌석 600석이 전부 이미 `HELD`였고 `Confirm Seat Selection`도 처음부터 비활성): `runSeatMapTick`의 `claimCount = floor(botIntensity × elapsedSeconds)`는 `elapsedSeconds`(세션 생성 후 첫 `GET /api/seats` 호출까지의 실제 경과 시간)에 선형 비례하는데, `tune-bot-intensity.ts`의 `runTrial()`은 항상 첫 tick을 `elapsed=TICK_MS(2초)` 고정값 하나로만 측정하고 있었음 — 실제 세션은 페이지 이동·React 렌더·2초 폴링 주기 때문에 첫 `GET /api/seats`까지 15~20초(이번 dev 환경 실측치, Turbopack 컴파일 오버헤드 포함) 이상 걸릴 수 있고, 이 경우 `floor(6000×15)=90,000 ≫ 15,000`(전체 풀)이라 첫 tick에서 풀이 통째로 소진됨. 동일 계산을 구버전(200석 풀 / `botIntensity=80`)에 대입하면 saturation elapsed(`pool/botIntensity`)가 2.5초에 불과해, **이 결함은 이번 Task에서 새로 생긴 게 아니라 이전부터 존재했고, MEGA 전체 플로우를 timewarp 없이 실제로 끝까지 타본 적이 없어 지금까지 드러나지 않았을 가능성이 높음** → **결정: 튜닝 스크립트를 "고정된 한 시점"이 아니라 "실사용에서 나올 수 있는 elapsed 범위 전체"에서 안정적으로 동작하는지 검증하도록 수정하고, 그 방법론으로 MEGA를 재튜닝. SMALL/MEDIUM도 같은 방법론 + timewarp 없는 실제 Playwright E2E로 별도 재검증(코드 변경 없이 안전함을 확인)**
  - **수정한 튜닝 방법론**: `scripts/tune-bot-intensity.ts`에 `--elapsedSeconds=2,5,15,30,60`(콤마 구분 스윕) 인자 추가 — 트라이얼의 **첫 tick만** 이 값을 elapsed로 쓰고(세션 생성부터 첫 poll까지의 실제 대기 시간), 이후 tick은 기존대로 2초 간격 유지(좌석 화면 진입 후의 정상 폴링을 반영). `TrialResult`에 `soldOut`(풀이 완전히 소진돼 끝난 트라이얼인지, `MAX_TICKS` 초과와 구분) 필드 추가, elapsed 값별로 평균 `contentionLosses`·매진율을 따로 리포트
  - **MEGA 재확정값**: `botIntensity=200`(6000 아님). `claimCount=botIntensity×elapsed`가 무한정 선형이라 "낮은 elapsed에서 목표(6) 근처 유지"와 "높은 elapsed에서 매진 방지"를 동시에 만족하는 값은 존재하지 않음(saturation elapsed=`pool/botIntensity` 지점에서 항상 100% 매진으로 절벽처럼 꺾임 — 실측: `elapsedSeconds=75`에서 5/5 트라이얼 전부 15,000석 매진) → saturation elapsed가 현실적 최대 elapsed보다 충분히 위(200 → 75초)에 오도록 낮춤. `elapsedSeconds=[2,5,15,30,45,60]`에서 평균 `contentionLosses` 0~3(60초에서 단일 트라이얼 최대 11), 매진율 0%. 60→75초 사이가 안전 마진
  - **SMALL/MEDIUM 재확정값**: 변경 없음(`0.1`/`0.4` 유지). 같은 스윕(`elapsedSeconds=2,5,15,30,60`)에서 두 티어 모두 평균 `contentionLosses=0`, 매진율 0% — saturation elapsed가 각각 25,000초/17,500초라 현실적 elapsed 범위와 자릿수 차이로 안전. D-15에서 "미조정 유지, 실측으로 크게 벗어나면 이 Task 안에서 재검토"로 남겨둔 조건을 이 재측정으로 충족
  - **timewarp 없는 실제 E2E 재검증**: Task 011-1의 기존 E2E는 `/api/dev/timewarp`로 대기열을 스킵했을 가능성이 있어 이 elapsed 관련 결함을 검증한 적이 없었을 수 있음 — Playwright로 SMALL/MEDIUM/MEGA 각각 홈→(카운트다운 대기)→대기열→좌석까지 timewarp 없이 실제 시간 경과로 진행: SMALL(zone 3, 325석 전부 `AVAILABLE`)/MEDIUM(zone 8, 490석 전부 `AVAILABLE`) 매진 없음, 좌석 선택→확정→`/booking` 진입까지 정상. MEGA(botIntensity=200 적용 후, zone 5)는 `AVAILABLE`/`HELD`가 섞인 정상적 경합 상태로 확인, 좌석 선택→확정→`/booking` 진입 정상(재튜닝 전 6000에서는 zone 5 600석 전부 `HELD`, 선택 불가였던 것과 대조)
  - **영향 범위**: `scripts/tune-bot-intensity.ts`(elapsed 스윕 방식으로 재작성), `prisma/seed.ts`(MEGA `botIntensity` 6000→200), 로컬 dev DB의 `SimulationConfig` MEGA row
  - See: `tasks/014-seat-scale-expansion.md` (Task 012 Step 10 진행 중 발견)
- [x] **D-17. Zone 분할이 number(좌우 위치) 1차원 기준이라, MEGA에서 zone당 4열×150행짜리 세로로 아주 긴 스트립이 됨** (사용자의 실사용 피드백 — 좌석 화면에서 스크롤을 한참 내려야 하는 문제로 발견): `lib/seat-zones.ts`(당시 `getZoneForSeatNumber`/`groupSeatsByZone`)가 `Seat.number`(좌우 위치)만으로 zone을 나누고 `Seat.row`(무대 거리)는 zone 멤버십에 전혀 관여하지 않아, zone 하나가 항상 "전체 행 × (100÷zoneCount)열" 모양이 됨 — 실제 공연장의 "구역 = 거리대 × 각도" 2차원 구조와 무관 → **결정: row도 zone 계산에 포함해 2차원 밴딩(거리대 band × 좌우 split)으로 전환. zoneCount를 bands×splits로 인수분해하되, 결과 zone 모양(`seatRows/bands` 행 × `seatsPerRow/splits` 열)이 정사각형에 가장 가까운 조합을 선택(bands=1 또는 splits=1은 옛 1차원 방식으로 퇴화하므로 명시적으로 제외)**
  - **선택된 조합**: SMALL(25×100, 8존) → 2 bands × 4 splits, MEDIUM(70×100, 15존) → 3 bands × 5 splits, MEGA(150×100, 25존) → 5 bands × 5 splits(완전 정사각). 셋 다 zoneCount의 소인수 특성상 깔끔히 나뉨 — `computeZoneGrid`가 임의의 zoneCount에 대해 bands≥2·splits≥2 약수쌍이 없으면(소수 등) 명시적으로 예외를 던지도록 구현(조용히 1차원으로 폴백하지 않음)
  - **구현**: `lib/seat-zones.ts`를 `getZoneForSeatNumber`/`getZoneNumberRange`(1차원, number 전용) → `getZoneForSeat`/`getZoneSeatRange`/`computeZoneGrid`(2차원, row+number)로 재작성. `lib/seats.ts`의 `listSeatMap`은 SQL `WHERE`에 `CAST(row AS INTEGER) BETWEEN … AND number BETWEEN …` 두 축 조건을 함께 적용(스키마/마이그레이션 변경 없음 — 계산 로직만 변경). `app/api/seats/route.ts`의 zone-scope 가드는 `seatRows`/`seatsPerRow`까지 함께 전달하도록 확장. zone-picker UI(zone id는 여전히 flat `"1".."zoneCount"`, `getZoneOrder`/`getZoneLabel`)는 변경 없음
  - **검증**: 유닛 테스트로 세 티어 전체 좌석(SMALL 2,500 / MEDIUM 7,000 / MEGA 15,000)을 전수 순회하며 zone round-trip(`getZoneForSeat` ↔ `getZoneSeatRange`) 일치 확인. 실제 브라우저(Playwright, MEGA zone 1) bounding box 실측: 좌석 그리드 컨테이너 `704×1312px`(가로:세로 ≈ 1:1.86) — 기존 1차원 방식이었다면 150행이 그대로 쌓여 세로 `6600px+`(비율 1:35+)가 됐을 것과 대비. 여러 zone(1, 13, 20)에서 응답의 row/number 범위가 계산값과 정확히 일치함을 확인(예: zone 13 → rows 61-90, numbers 41-60)
  - **영향 범위**: `lib/seat-zones.ts`(재작성), `lib/seats.ts`(`listSeatMap` SQL 조건 추가), `app/api/seats/route.ts`(가드 확장) — API 응답 shape(`SeatMapResponse`)은 변경 없음
  - See: 사용자 실사용 피드백 (오늘 날짜)
- [x] **D-18. D-16에서 확정한 MEGA `botIntensity=200`이 "매진 안 됨"만 검증됐을 뿐, 저·중간 elapsed 구간의 평균 `contentionLosses`가 목표(6)에 비해 지나치게 낮음** (사용자의 실사용 피드백 — "대기열 순번 119번으로 좌석 화면에 들어가도 좌석이 거의 안 사라지는 느낌"): D-16 재튜닝 당시 elapsed 스윕에서 확인한 것은 "매진 0%"뿐이었고, 평균 `contentionLosses`가 벤치마크(6)에 근접하는지는 별도로 검증하지 않고 넘어갔음 → 재측정 결과, `contentionLosses` 평균이 6에 도달하려면 좌석의 약 85.7%가 이미 소진돼야 함이 확인됨(negative-hypergeometric 충돌 확률상 `p/(1-p)=6 → p≈0.857`) — 이는 매진(`p=1`) 바로 직전 구간이라, **"0~60초 전 구간에서 평균 6 근접"과 "매진 비율 0%"는 이 선형·무한 증가(`claimCount=botIntensity×elapsed`, 상한 없음) 모델 하에서 동시에 만족될 수 없음**이 수학적으로 확인됨 → **결정: 이 제약을 인정한 위에서 "목표에 최대한 가깝되 매진 절벽은 확실히 피하는" 값을 재탐색**
  - **실측 (N=30, `botIntensity=220`, elapsedSeconds=[0,10,20,30,40,50,60])**: 평균 `contentionLosses` 0.00 → 0.13 → 0.47 → 0.80 → 1.73 → 2.93 → 4.87(60초 지점, 단일 최대 16), 매진 비율 전 구간 0%. 비교: `botIntensity=250`(saturation elapsed 정확히 60초)은 elapsedSeconds=60에서 30/30 트라이얼 전부 매진 — 기각
  - **MEGA 재확정값**: `botIntensity=220`(200 아님). saturation elapsed(`pool/botIntensity`)≈68초로, 200(75초)보다는 짧지만 250(60초, 절벽에 걸림)보다는 안전 마진이 있는 지점
  - **영향(리스크로 기록)**: `botIntensity` 상향으로 elapsed가 큰 세션에서 봇이 순차적으로 처리해야 할 `claimSeat` 트랜잭션 수가 늘어남 — 검증 중 실제로 `GET /api/seats` 응답이 23.6초 걸린 사례를 관측(elapsed 누적 시 claimCount 수천 건이 `runSeatMapTick` 안에서 seat-by-seat 순차 트랜잭션으로 처리되기 때문). 이는 Task 012 최초 완료 보고에서 이미 "구조적 리스크"로 기록해 둔 지점이 실측으로 재확인된 것 — 아직 별도 Task로 承격하지 않았으므로 후속 우선순위 검토 필요
  - **영향 범위**: `prisma/seed.ts`(MEGA `botIntensity` 200→220), 로컬 dev DB의 `SimulationConfig` MEGA row
  - See: 사용자 실사용 피드백 (오늘 날짜)
- [x] **D-19. 좌석 라벨이 `${row}${number}` 구분자 없는 concat이라, D-15의 숫자 행 라벨링 이후 서로 다른 좌석이 같은 문자열로 표시됨** (사용자가 스크린샷으로 확인·보고 — Zone 3에서 "19","29","39"... 계열과 "110","210","310"... 계열이 화면에 함께 표시되는 것을 지적): Task 012 Step 4(D-15)에서 행 라벨을 알파벳(A~J, 항상 1글자)에서 숫자 문자열("1".."150")로 바꿨는데, `app/components/SeatCell.tsx`의 표시 라벨과 `app/booking/BookingView.tsx`/`app/payment/PaymentView.tsx`의 "선택한 좌석" 표시가 여전히 구분자 없는 `${row}${number}` 콘캐트를 쓰고 있어, 자리수 경계에서 서로 다른 (row, number) 조합이 같은 문자열을 만들어냄 — Task 012 수락 기준에 이미 명시돼 있던 "좌석 표기가 자연스럽게 이어짐(예: '13행 5번')" 요건을 실제로는 충족하지 못했던 것 → **결정: 구분자 도입. 좁은 원형 배지(`SeatCell`)는 `row-number`(예: `1-9`), 여유 있는 카드(`BookingView`/`PaymentView`)는 `Row {row}, Seat {number}`(CLAUDE.md의 UI 영어 표기 규칙 준수 — 한국어 "행/번" 표기는 쓰지 않음)**
  - **구현**: `app/components/SeatCell.tsx`의 visible label(`${row}-${number}`) 및 `aria-label`(`Seat row ${row}, number ${number}, ${status}`) 수정, `app/booking/BookingView.tsx`/`app/payment/PaymentView.tsx`의 "Selected seat" 표시를 `Row {row}, Seat {number}`로 수정
  - **회귀 테스트**: `app/components/SeatCell.test.tsx` 신규 — row=1/number=9 vs row=1/number=10처럼 과거 충돌 가능했던 조합이 서로 다른 문자열("1-9" vs "1-10")로 렌더링되는지, accessible name에 row/number가 별도 단어로 분리되는지 직접 검증. `app/seats/SeatsView.test.tsx`의 기존 aria-label 단언(`Seat A1, available` 등)을 새 포맷(`Seat row A, number 1, available`)으로 갱신
  - **검증**: 실제 브라우저(Playwright, MEGA zone 1/20)에서 "1-1"~"30-20", "91-81"~"91-100" 등 다양한 두 자리 행에 대해 라벨이 모두 명확히 구분됨을 확인
  - **영향 범위**: `app/components/SeatCell.tsx`, `app/booking/BookingView.tsx`, `app/payment/PaymentView.tsx` — API 응답/데이터 모델 변경 없음(순수 표시 레이어)
  - See: 사용자 실사용 피드백 + 스크린샷 (오늘 날짜)
- [x] **D-20. `GET /api/seats`가 봇 클레임을 seat-by-seat 순차 DB 트랜잭션으로 처리해, 고-elapsed·고-`botIntensity` 조건에서 응답이 수십 초까지 걸림** (D-18 검증 중 실측 재현: elapsed=60초, MEGA `botIntensity=220` 조건에서 `GET /api/seats` 응답이 23.6초 소요 — Task 012 최초 완료 보고에서 이미 "구조적 리스크"로 기록해 둔 지점): `lib/seats.ts`의 `runSeatMapTick`이 `claimCount`(최대 elapsed×botIntensity, MEGA 60초 기준 최대 13,200)만큼 `claimSeat()`를 하나씩 순차 호출 — 각 호출이 독립된 DB 트랜잭션(왕복)이라 claimCount에 선형 비례해 느려짐 → **결정: 봇 클레임 전용 배치 함수(`claimSeatsBatch`)를 신설해 `SELECT ... FOR UPDATE SKIP LOCKED` + 단일 `UPDATE ... RETURNING`으로 DB 왕복을 claimCount번에서 1번으로 축소. 사용자 개별 좌석 클릭 경로(`claimSeat`, F006)는 전혀 건드리지 않음 — 별도 함수, 별도 쿼리**
  - **동시성 안전성**: `FOR UPDATE SKIP LOCKED`는 이미 다른 트랜잭션(사용자의 개별 `claimSeat` 포함)이 잠근 행을 블로킹 없이 건너뛰므로, 배치 클레임과 사용자 클릭이 같은 좌석을 동시에 노려도 안전 — 사용자가 먼저 잠갔으면 배치가 그 행을 건너뛰고 다른 좌석을 대신 채가고, 배치가 먼저 잠갔으면 사용자의 `UPDATE ... WHERE status='AVAILABLE'`이 0건 매치해 기존 `SEAT_ALREADY_TAKEN` 경로로 빠짐(변경 없음). 기존 회귀 테스트(`lib/seats.test.ts`의 "bot-vs-user contention" — `runSeatMapTick`과 사용자 `claimSeat`를 `Promise.all`로 동시 실행)가 이 불변식을 그대로 검증
  - **F007 결정론과의 관계**: `computeBotClaimCount`/`advanceTick`(같은 elapsed+botIntensity → 같은 claimCount)은 이번 변경과 무관 — 배치 함수는 claimCount 계산 이후 단계만 담당. 어떤 좌석이 뽑히는지는 기존에도 `shuffledCopy`(JS `Math.random()`)로 무작위였고, 이제는 SQL `ORDER BY random()`으로 무작위인 것만 다름 — 결정론 요구사항이 걸리는 지점이 아님
  - **캡 처리**: `LIMIT claimCount`가 `WHERE status='AVAILABLE'` 조건과 결합돼, 실제 available 좌석이 claimCount보다 적으면 자연히 그만큼만 반환됨(기존 "후보 소진 시 조기 종료" 동작과 동일 결과, 별도 캡 로직 불필요)
  - **실측 (동일 시나리오 재측정)**: elapsed=60초·MEGA(`botIntensity=220`, claimCount=13,200) 조건에서 `runSeatMapTick` 직접 호출 4회 반복 1.7~3.2초(평균 ~2.3초), 실제 `GET /api/seats` 엔드포인트(Playwright, 브라우저→서버 왕복) 2.4초 — **기존 23.6초 대비 약 10배 개선**, 목표(5초 트랜잭션 타임아웃 이내) 충분히 달성
  - **`POST /api/session`(D-16/D-18에서 관찰된 P2028 타임아웃)은 별개 원인으로 확인**: 유휴 상태에서 MEGA 세션 생성(15,000석 `createMany` 포함 트랜잭션)만 10회 반복 실측한 결과 1.1~2.3초(평균 1.4초)로 5초 타임아웃 대비 여유가 충분 — "`createMany` 자체가 원래 느림" 가설은 기각. 이전에 관측된 6.9~7.8초 타임아웃은 진짜 동시 DB 부하(dev 서버 + 다른 테스트/스크립트가 로컬 Postgres 커넥션을 동시에 점유) 상황에서만 발생하는 것으로 재확인 — `lib/prisma-adapter.ts`가 풀 크기를 명시하지 않아 `pg.Pool` 기본값(10)을 그대로 쓰는 점이 원인일 가능성이 있으나, 이번 수정 범위 밖이라 손대지 않음
  - **`pg.Pool` 기본 커넥션 풀 크기(10)가 원인 후보로 남아있음** — 지금은 로컬 동시 부하(dev 서버+테스트+스크립트가 같은 DB 커넥션을 동시 점유)에서만 재현됐지만, 프로덕션 Vercel serverless 환경에서도 짧은 시간에 여러 요청이 같은 풀을 공유하는 유사 패턴이 발생할 수 있음. **Task 013(Vercel 배포, Neon pooled connection 프로덕션 부하 검증)에서 반드시 재검토 필요**
  - **영향 범위**: `lib/seats.ts`(`claimSeatsBatch` 신설, `runSeatMapTick`이 이를 사용하도록 변경, 기존 `shuffledCopy` 헬퍼 제거) — `claimSeat`(사용자 클릭 경로)·`GET /api/seats`/`POST /api/seats` API shape 변경 없음
  - See: 사용자 요청 (오늘 날짜)
- [x] **D-21. 봇 클레임 모델을 선형에서 프론트로딩형(지수 접근) 곡선으로 전면 재설계 — "zone이 매진되면 안 된다"는 기존 전제를 뒤집는 결정** (사용자 요청, 리서치 근거 포함: 실제 한국 콘서트 티케팅은 인기 공연 기준 오픈 후 수 초~9분 안에 완전 매진되는 게 정상 — 슈퍼주니어 Super Show 6 서울 9분, Jannabi 콘서트 즉시 매진. 실제 사용 시나리오는 "한 zone이 매진이면 바로 뒤로가기 눌러 다른 zone으로 이동해 빈자리를 찾는" 방식이며, zone 매진 표시 뱃지가 의도적으로 없는 것도 "여러 zone을 사냥하며 도는" 경험이 핵심이기 때문): 기존 선형 모델(`claimCount = botIntensity × elapsedSeconds`, D-15~D-20)은 elapsed가 작을 때(사용자가 일찍 도착했을 때) 항상 느슨하고 elapsed가 커질수록 급격히 매진에 가까워지는 구조라, 순번이 좋아 일찍 도착한 사용자가 오히려 "봇이 아직 워밍업도 안 된 텅 빈 zone"을 만나는 부자연스러운 경험을 만듦 — 실제 티케팅은 정반대로 오픈 직후 몇 초가 가장 치열하고 이후 완만해짐(이미 잘 팔리는 자리부터 빠지고 남은 자리 소진 속도는 자연히 느려지므로) → **결정: `lib/simulation.ts`의 `computeBotClaimCount`를 `targetClaimed(t) = floor(poolSize × (1 - e^(-botCurveK × t)))`(t = elapsedSinceOpen, 즉 `SimulationRun.queueOpenAt` 기준 경과초) 절대 목표 곡선으로 전면 교체. 이번 tick의 claimCount는 그 목표와 "이미 소진된 수"(poolSize - availableSeatCount)의 차이(gap)일 뿐. `SimulationConfig.botIntensity`(선형, seats/sec)를 `botCurveK`(지수 곡선 기울기, 1/sec)로 rename — 단위/스케일이 완전히 달라 같은 컬럼을 재해석하지 않고 마이그레이션으로 rename**
  - **결정론(F007)이 절대-목표 모델을 요구한 이유**: "elapsed since last tick" 델타를 비선형 곡선에 그대로 대입하면, 같은 델타라도 tick 이력(몇 번 쪼개 호출됐는지, 폴링 간격이 얼마였는지)에 따라 곡선의 다른 지점에 해당해 실질적으로 결정론이 깨짐 — 절대 목표(고정된 `queueOpenAt` 앵커 + 총 경과시간)라야 "같은 t → 항상 같은 목표"가 tick 이력과 무관하게 성립. 이 요구사항 때문에 `lib/tick.ts`가 기존에 쓰던 `SimulationRun.lastTickAt`(매 tick마다 "소진된 좌석 수/botIntensity초"만큼만 전진시키는 carry-forward 메커니즘, 선형 모델에서 폴링 빈도가 높을 때 소수점 진행분이 유실되는 걸 막기 위한 장치)이 통째로 불필요해짐 — 절대 목표 모델은 애초에 유실될 소수점 진행분이 없음. `lastTickAt`은 스키마에서 제거하지 않고 그대로 두되(범위를 "클레임 공식"으로 한정하기 위해 스키마 정리는 별도 과제로 미룸) `advanceTick`은 더 이상 이를 읽거나 쓰지 않고 `queueOpenAt`만 읽음
  - **어떤 좌석이 뽑히는지는 결정론 대상이 아님 확인**: 사용자 요청대로, F007의 결정론은 claimCount 계산에만 해당하고 좌석 선택(D-20의 `claimSeatsBatch`, `ORDER BY random()`)은 원래도 무작위였으므로 이번 변경과 무관 — `claimSeatsBatch` 자체는 전혀 손대지 않음(D-20 그대로 재사용)
  - **poolSize 캡/정수 요구사항**: `1 - e^(-kt)`는 t→∞에서 1에 점근하므로 `targetClaimed`는 수학적으로 항상 `poolSize` 이하 — `Math.floor` + `Math.min(..., availableSeatCount)`로 정수·상한 보장을 코드 레벨에서도 명시적으로 유지
  - **티어별 `botCurveK` 차등**: F001("난이도=티어") 원칙 유지 — poolSize 차이만으로는 체감 난이도가 차별화되지 않아 곡선 기울기 자체도 티어별로 별도 튜닝. SMALL은 매우 완만(60초 시점 15% 소진), MEDIUM은 중간(60초 40%), MEGA는 오픈 초반부터 급격(15초 근방 이미 30~50%대) — 아래 실측표 참고
  - **실측 (scripts/tune-bot-intensity.ts 전면 재작성 — 이제 결정론적이라 N회 평균이 아니라 "재현되는지" 확인용, stddev 전 구간 0.000으로 결정론 확인됨)**:

    | elapsed(초) | SMALL 소진% (k=0.0027) | MEDIUM 소진% (k=0.0085) | MEGA 소진% (k=0.034) |
    |---|---|---|---|
    | 0 | 0.0 | 0.0 | 0.0 |
    | 5 | 1.3 | 4.2 | 15.6 |
    | 10 | 2.6 | 8.1 | 28.8 |
    | 20 | 5.2 | 15.6 | 49.3 |
    | 30 | 7.8 | 22.5 | 63.9 |
    | 45 | 11.4 | 31.8 | 78.3 |
    | 60 | 14.9 | 39.9 | 87.0 |
    | 90 | 21.6 | 53.5 | 95.3 |
    | 120 | 27.6 | 63.9 | 98.3 |

    세 티어 모두 스윕 전 구간에서 매진 비율 0%(전체 풀 기준 — 개별 zone은 이 수준의 소진율에서도 무작위 편차로 이미 매진에 가깝거나 매진일 수 있고, 이게 D-21의 의도된 경험). `--botCurveK` 오버라이드로 후보값을 더 탐색할 수 있음 — 위 값은 사용자가 제시한 목표(MEGA는 15~20초 구간에 30~50% 소진, SMALL/MEDIUM은 그보다 훨씬 완만) 방향에 맞춘 1차 제안값이며 최종 확정은 아님(사용자 확인 필요)
  - **테스트 재작성**: `lib/simulation.test.ts`의 `computeBotClaimCount` 테스트 전면 교체(새 파라미터: `elapsedSinceOpen`/`botCurveK`/`poolSize`/`availableSeatCount`) — determinism·elapsed=0·매우 큰 elapsed 테스트는 형태를 유지하되 새 공식에 맞게 갱신, "front-loads"(초반이 선형보다 가파름) 테스트 신규 추가. `lib/tick.test.ts` 전면 재작성 — 기존 "carries fractional bot progress forward"(carry-forward 메커니즘 자체 검증) 테스트는 그 메커니즘이 사라져 폐기, "serializes concurrent ticks... 정확히 split"(정밀 직렬화 보장) 테스트도 아래 이유로 폐기하고 "tick 이력과 무관하게 같은 t는 같은 누적 목표로 수렴" 테스트로 대체. `lib/seats.test.ts`의 `runSeatMapTick` 통합 테스트 3건은 `computeBotClaimCount`가 이제 `SimulationConfig`의 실제 `seatRows×seatsPerRow`(예: MEGA 15,000)를 poolSize로 쓰는데 테스트가 만드는 좌석은 소수(1~10개)라 "이미 소진된 것으로 간주되는 수"(poolSize - availableSeatCount)가 실제보다 훨씬 커지는 불일치가 생겨, 기존처럼 "적당히 큰 elapsed"로는 부분 클레임을 재현할 수 없음(목표가 이미 "소진 간주분"보다 낮아 claimCount가 0으로 클램프됨) → 곡선이 사실상 완전 포화되는 매우 큰 elapsed(~3.2년)를 써서 "가용한 만큼 전부 클레임"으로 테스트 의도를 재구성. `app/api/dev/timewarp/route.test.ts`도 `lastTickRewindMs`가 더 이상 봇 클레임에 영향을 주지 않음을 확인하는 테스트로 교체하고, `openInMs`(← `queueOpenAt` 되감기)가 새로운 봇-클레임 타임워프 레버임을 검증하는 테스트 추가
  - **동시성 보장 약화(알려진 트레이드오프, 범위 밖) — ⚠️ 이 판단은 D-22에서 실측 후 정정됨**: 기존 선형 모델은 `lastTickAt` FOR UPDATE 락 + carry-forward로 "동시 tick이 elapsed 구간을 정확히 나눠 갖고 절대 이중 카운트하지 않음"을 보장했음. 새 모델은 `availableSeatCount`를 트랜잭션 밖(호출자)에서 읽으므로, 진짜 동시 tick 2개가 약간 스테일한 `availableSeatCount`를 각자 기준으로 목표를 계산해 합쳐서 목표를 초과 클레임할 여지가 이론상 남음 — 사용자 지시("D-20의 배치 UPDATE 트랜잭션 메커니즘은 그대로, 계산식만 변경")에 따라 `advanceTick`/`runSeatMapTick`의 호출 경계는 손대지 않았기 때문. ~~실사용 패턴(세션당 폴링 1개, 동시 tick은 React Strict Mode 이중 호출이나 탭 2개 열기 정도의 좁은 경우)에서 영향은 제한적으로 판단~~ → **이 "영향 제한적" 판단은 실측 없이 내린 것으로 확인됨(D-22)**. 실제로는 dev의 React Strict Mode 이중 invoke만으로도 zone 진입마다 재현되는 흔한 경로였고, 실측 결과 최대 2배 초과 클레임까지 발생함 — D-22에서 수정
  - **E2E 검증 (timewarp 없는 실제 플로우, Playwright)**: MEGA — 실제 대기열 통과(elapsed ~20초) 후 Zone 1 진입 시 84~90% 소진(600석 중 available 98→57로 계속 감소, 폴링마다 tick 진행), "Back to zone selection" → Zone 12로 이동해 빈자리(row 63, number 39) 발견 후 확정 → `/booking`에 "Row 63, Seat 39"로 정상 진입 — "한 zone 매진에 가까우면 다른 zone으로 이동해 빈자리를 찾는" 의도된 경험이 실제로 재현됨. SMALL/MEDIUM도 같은 시점(elapsed ~15~20초)에 각각 3%/6% 소진으로, MEGA와 명확히 구분되는 난이도 체감 확인 — SMALL/MEDIUM은 세션 생성 API를 직접 호출해 홈 화면의 연출용 카운트다운만 건너뛰었을 뿐(대기열 통과·tick·클레임 로직은 모두 실제 경로), MEGA는 카운트다운 대기부터 100% 실제 UI 클릭 플로우로 진행
  - **다루지 않은 것**: `lib/result.ts`의 `TIER_BENCHMARKS.maxContentionLosses`(Task 011 결과 리포트 피드백 임계값)는 원래 D-16/D-18이 선형 모델 튜닝 목표로 삼았던 지표이나, 이번 요청은 그 목표 자체("평균 contentionLosses 6 근처")를 폐기했을 뿐 리포트 피드백 문구/임계값 자체를 재검토하라는 요청은 아니었으므로 손대지 않음 — Task 011 리포트가 "평균보다 많이 졌다"는 피드백을 줄 때 그 "평균"의 근거가 이제 낡았을 수 있어 후속 검토 후보
  - **영향 범위**: `prisma/schema.prisma`+마이그레이션(`botIntensity`→`botCurveK` rename), `lib/simulation.ts`(`computeBotClaimCount` 전면 교체), `lib/tick.ts`(`queueOpenAt` 앵커로 전환, carry-forward 제거), `lib/dev-timewarp.ts`(주석으로 `lastTickRewindMs` 무력화 명시), `lib/result.ts`(주석의 필드명만 갱신), `prisma/seed.ts`(세 티어 `botCurveK` 초기값), `scripts/tune-bot-intensity.ts`(전면 재작성), `lib/simulation.test.ts`/`lib/tick.test.ts`/`lib/seats.test.ts`/`app/api/seats/route.test.ts`/`app/api/dev/timewarp/route.test.ts`(재작성/갱신) — `claimSeatsBatch`(D-20)·zone 밴딩(D-17)·좌석 라벨(D-19)·`GET/POST /api/seats` API shape 전부 변경 없음
  - See: 사용자 요청 (오늘 날짜)
- [x] **D-22. D-21의 "동시성 보장 약화... 영향 제한적" 판단을 실측 없이 내렸다는 지적 → 실측 후 정정, 락 패턴 적용해 수정** (사용자 요청 — 커밋 전 검증: "실제 트리거 조건을 설명해줘... 실측했는지, 추정인지", "실제로 겹칠 수 있는 경로가 있다면 D-13과 같은 잠금 패턴을 적용할 필요가 있는지 판단해줘")
  - **트리거 조건 실측**: `app/seats/SeatsView.tsx`의 2초 폴링 `useEffect`(77~112행)를 코드 추적한 결과, `cancelled` 플래그를 `await fetch()` 완료 **이후에만** 체크하고 있어 React Strict Mode의 dev 전용 "마운트→클린업→재마운트" 이중 호출이 첫 번째 `poll()`의 이미 발사된 `fetch()`를 막지 못함 — 즉 **zone에 진입할 때마다 dev 환경에서 100% 재현되는 흔한 경로**였고, 동일한 메커니즘이 프로덕션에서도 탭 2개로 같은 세션을 열면 그대로 발생함. "실사용 패턴에서 영향은 제한적"이라던 D-21의 판단은 이 경로를 실제로 확인하거나 실측하지 않고 내린 추정이었음(사용자 지적이 정확했음)
  - **실측(`scripts/_concurrency-probe-tmp.ts`, MEGA 실제 15,000석 규모, 수정 전)**: 동시 tick 2개를 `Promise.all`로 경합시켜 단일 tick 대비 초과분을 측정 — elapsed=5s: 목표 2,345 vs 2-동시 4,690(2배, 초과 2,345) / elapsed=10s: 목표 4,323 vs 8,646(초과 4,323) / elapsed=20s: 목표 7,400 vs 14,800(초과 7,400, 거의 정확히 2배) / elapsed=40s: 목표 11,150 vs 15,000(전체 매진, 초과 3,850 — availableSeatCount 상한에 걸림) / elapsed=60s: 목표 13,049 vs 15,000(초과 1,951). 초반~중반 elapsed에서 정확히 2배에 가까운 초과 클레임 확인 — "영향 제한적"이 아니라 **가장 흔한 경로(zone 최초 진입)에서 가장 크게 나타나는 버그**였음
  - **원인(코드 레벨)**: D-21 이후 `advanceTick`의 `SELECT ... FOR UPDATE` 락은 이름만 남아있었을 뿐 실질적 보호 효과가 없었음 — 락이 지키는 트랜잭션 안에서 아무것도 쓰지 않게 됐기 때문(구 선형 모델은 이 트랜잭션 안에서 `lastTickAt`을 갱신했지만, D-21이 그 carry-forward 메커니즘을 통째로 제거하면서 락의 보호 대상이 사라짐). 정작 레이스가 발생하는 지점(`availableSeatCount` 읽기, D-20의 `claimSeatsBatch` 클레임 실행)은 둘 다 그 락의 트랜잭션 **밖**, `lib/seats.ts`의 `runSeatMapTick`에서 별개 트랜잭션으로 실행되고 있었음
  - **결정: D-13(joinQueue 레이스)과 같은 패턴 적용 — 락이 "읽기+계산+쓰기" 전 구간을 커밋까지 물고 있도록 트랜잭션 경계를 재구성**. `advanceTick`(`lib/tick.ts`)이 더 이상 자체 트랜잭션을 열지 않고 호출자가 넘긴 `tx`를 받도록 변경, `availableSeatCount`도 파라미터로 받는 대신 그 `tx` 안에서(락 획득 **다음 줄**에) 직접 읽도록 변경 — 두 번째 tick은 락에 블록됐다가 첫 번째 tick의 커밋(클레임 완료) 이후에야 락을 얻어 갱신된 `availableSeatCount`를 보게 됨. `claimSeatsBatch`(`lib/seats.ts`)에 선택적 `tx` 파라미터 추가(생략 시 기존처럼 자체 트랜잭션, D-20 동작 그대로 유지). `runSeatMapTick`이 `advanceTick` + `claimSeatsBatch` 호출을 **하나의 `prisma.$transaction`**으로 합침(D-20이 만든 배치 UPDATE 메커니즘 자체는 완전히 그대로 재사용 — "how many"만 바뀐 것과 동일하게 "어떻게 잠그는가"만 바뀜)
  - **circular import 회피**: `lib/seats.ts`가 `lib/tick.ts`의 `advanceTick`을 import하는 기존 방향은 유지 — `advanceTick`이 `claimSeatsBatch`/`botSessionId`를 되받아 import하지 않고, 트랜잭션 자체는 호출자(`runSeatMapTick`)가 열어서 `tx`로 양쪽에 전달하는 구조로 순환 참조 없이 해결
  - **수정 후 재실측(동일 스크립트, MEGA 15,000석)**: elapsed 5/10/20/40/60s 전 구간에서 동시 tick 2개의 합산 클레임이 단일 tick과 정확히 일치(초과 0) — 레이스 완전히 닫힘 확인
  - **테스트**: 회귀 테스트를 먼저 실패시킨 뒤(RED) 수정 → `lib/seats.test.ts`에 "두 개의 동시 `runSeatMapTick`이 목표를 초과 클레임하지 않는다" 통합 테스트 신규 추가(SMALL 실제 2,500석 풀, 목표의 25% 지점에서 경합 — 수정 전 1,248 클레임(목표 625의 2배) 확인 후 수정으로 정확히 625로 통과). `lib/tick.test.ts` 전면 재작성 — `advanceTick`이 `availableSeatCount`를 파라미터로 안 받고 `tx`만 받도록 시그니처가 바뀌어 기존 5개 테스트 모두 실제 Seat row 픽스처를 쓰도록 갱신(단, poolSize/픽스처 크기 불일치를 피하려 saturating elapsed(~3.2년) + 소규모 픽스처 패턴을 재사용해 DB 부하 최소화), 락이 커밋 시점까지 직렬화함을 직접 증명하는 동시성 테스트 신규 추가. `app/api/dev/timewarp/route.test.ts`의 `advanceTick` 직접 호출 2건도 `tx` 시그니처에 맞춰 갱신(하나는 saturating rewind로 전환 — 1석짜리 소규모 픽스처가 MEGA 실제 poolSize와 불일치해 60초 rewind만으로는 claimCount가 0으로 클램프되는 동일 함정 발견 후 수정)
  - **후속 질문 2 (`TIER_BENCHMARKS.maxContentionLosses` 실측, `lib/result.ts`)**: 실제 `contention_loss`는 사용자 본인의 `POST /api/seats` 클레임 시도가 `SEAT_ALREADY_TAKEN`으로 지는 경우에만 기록됨(봇 소진율 자체가 아님) — `scripts/_contention-losses-probe-tmp.ts`로 "폴링 시점에 본 좌석 하나를 클릭 → 그 사이 봇 tick 1회(2초 폴링 간격) 진행 → 뺏겼으면 재시도"를 실제로 재현해 elapsed 0~500초 전 구간(3개 티어 × 최대 8개 elapsed 구간 × 6~15회)을 실측한 결과 **contentionLosses는 거의 항상 0, 드물게 1(SMALL은 전 구간 0회, MEDIUM/MEGA는 15회 중 0~2회만 1)이었고 현재 임계값(SMALL=1/MEDIUM=3/MEGA=6)을 초과한 사례는 단 한 번도 없었음** → 임계값이 실제보다 낮아서(=쉽게 넘어서) 사용자에게 잘못된 숫자를 보여주는 방식의 "오도"는 아님(발동될 때 보여주는 숫자 자체는 항상 정확함)으로 확인. 다만 이 결과는 "폴링당 한 좌석만 시도"라는 현실적 사용자 모델 기준 임계값이 거의 발동되지 않는다는 뜻이라, `high_contention_losses` 피드백이 실제로는 매우 드물게만 노출된다는 점은 참고 사항으로 남김 — 오도가 아니므로 후속 작업으로 등록하지 않고 확인 완료로 종료
  - **정리 안 한 것**: `scripts/_concurrency-probe-tmp.ts`, `scripts/_contention-losses-probe-tmp.ts` — 검증용 임시 스크립트, 이전 `_perf-probe-tmp.ts`와 동일하게 사용자가 직접 정리 예정
  - **영향 범위**: `lib/tick.ts`(`advanceTick` 시그니처를 `availableSeatCount` 파라미터 → `tx: Prisma.TransactionClient`로 변경, 내부에서 락 다음 줄에 직접 count), `lib/seats.ts`(`claimSeatsBatch`에 선택적 `tx` 추가, `runSeatMapTick`이 둘을 하나의 트랜잭션으로 합침) — `claimSeat`(사용자 클릭 경로, F006)·`GET/POST /api/seats` API shape 변경 없음. `lib/tick.test.ts`/`lib/seats.test.ts`/`app/api/dev/timewarp/route.test.ts` 갱신
  - See: 사용자 요청 (오늘 날짜)
- [x] **D-23. 대기열 초기 순번 모델에 "오픈 정각 동시 접속 서지" 반영 — D-4의 "오픈 순간엔 대기열이 비어있다"는 전제를 뒤집는 결정** (사용자 요청, 실제 사례 리서치 포함: 지디 콘서트(2025) 실제 후기 — 정각 클릭 → 접속 튕김 → 재접속 → 순번 25,000번대(본인이 "느린 편"이라 인정) → 좌석 화면 도달까지 오픈 후 약 25분 → 도착 시점에 VIP/2층 이미 매진, 3층도 매진; NCT DREAM 콘서트 선예매(나무위키) — 150만 명 동시 접속으로 YES24 지연 사과문): D-4의 초기 순번 공식(`arrivalRatePerSec × (joinedAt - openAt)`)은 정확히 `openAt`에 클릭해도 순번이 0에 가깝게 나오는데, 실제 티케팅은 정반대로 정각 클릭도 만~수십만 단위 순번이 정상이고 좌석 화면 도달까지 체감 대기가 수십 초가 아니라 수십 분(약 20~25분) 단위 → ~~**결정: 초기 순번 공식에 `surgeBaseline(tier)` 고정항을 추가 — `초기 순번 = surgeBaseline + arrivalRatePerSec × max(0, joinedAt - queueOpenAt)`. `admissionRatePerSec`도 `surgeBaseline`과 함께 재계산해 "정각 클릭 → 좌석 화면 도달"까지 MEGA 기준 약 20~25분(30분 이내)이 되도록 함**~~ → **2차 개정(같은 날짜, 아래 "D-23 2차 개정" 참고)에서 이 고정항(flat floor) 방식 자체가 폐기됨 — 서지 구간(surge window) 방식으로 재설계**
  - ~~**왜 둘을 함께 계산해야 하는지**: `surgeBaseline`만 올리고 `admissionRatePerSec`을 그대로 두면 대기 시간이 30분을 훌쩍 넘거나(비현실적으로 길어짐), 반대로 순번은 큰데 즉시 소진되는 상황이 됨 — 대기 시간 = `surgeBaseline / admissionRatePerSec`이므로 목표 대기 시간을 먼저 정하고 두 값을 역산~~ (이 계산 원칙 자체는 2차 개정에서도 그대로 유지됨 — 아래 참고)
  - **스키마 변경**: `SimulationConfig.surgeBaseline Float @default(0)` 추가(`prisma/migrations/20260829023151_simulation_config_surge_baseline`). `lib/simulation.ts`의 `computeQueuePosition`은 이미 `initialPosition`을 불투명한 값으로만 다뤄 변경 불필요(D-4 구현 시 정정과 동일한 이유) — `lib/queue.ts`의 `joinQueue` 한 곳만 수정
  - ~~**티어별 결정값** (SMALL/MEDIUM은 F001 난이도 원칙에 따라 MEGA보다 훨씬 작은 규모로, 대기 시간도 티어 규모에 맞게 짧게 — SMALL은 몇 분 이내, MEDIUM은 그 사이):

    | Tier | surgeBaseline | admissionRatePerSec | arrivalRatePerSec | 대기 시간 (surgeBaseline/admissionRatePerSec) |
    |---|---|---|---|---|
    | SMALL | 400 | 2 | 2 | 200s (~3m20s) |
    | MEDIUM | 4,000 | 8 | 8 | 500s (~8m20s) |
    | MEGA | 40,000 | 30 | 30 | ~1,333s (~22m13s) |

    MEGA의 `surgeBaseline=40,000`은 리서치 근거(지디 콘서트 순번 25,000번대, "느린 편"이라는 본인 인정을 감안해 2만~5만대 규모로 목표 설정)의 중간값. 대기 시간 22.2분은 목표 범위(20~25분) 안쪽, 30분 한도에서 충분히 여유. `arrivalRatePerSec`은 `admissionRatePerSec`과 동일값으로 유지(D-4가 이미 채택한 "깔끔한 숫자를 위한 미러링" 원칙 — 실측 근거 아님 — 그대로 계승)~~ → **2차 개정에서 `40,000`이 실측 근거 없이 부풀려진 값이었음이 확인돼 폐기·재산정됨 (아래 "D-23 2차 개정" 참고). 대기 시간 목표(200s/500s/~1,333s) 자체는 2차 개정에서도 그대로 유지됨**
  - **botCurveK 재역산 (D-21 값은 이번 변경으로 사실상 무효화됨)**: D-21의 `botCurveK`는 elapsed 0~120초 구간에서 튜닝됐는데, `surgeBaseline` 도입으로 사용자가 실제 좌석 화면에 도달하는 elapsed가 이제 훨씬 뒤(SMALL 200s, MEDIUM 500s, MEGA ~1,333s)로 밀림 — D-21이 원래 의도했던 "도착 시점의 적정 소진율"(인기 zone 매진에 가까움, 전체 70~90%대)이 새 elapsed 지점에서 나오도록 `k = -ln(1 - target) / t`로 역산. 목표: SMALL 25%@200s, MEDIUM 60%@500s, MEGA 95%@1,333s(인기 zone 완전 매진에 가까운 체감 유지 — D-21보다 살짝 상향, MEGA는 "완전 매진" 표현에 부합하도록)
  - **실측 (`scripts/tune-bot-intensity.ts`, 새 elapsed 스케일로 재작성 — 기존 0~120s 기본 스윕을 0~1,800s로 확장, 여전히 결정론적이라 stddev 0.000)**:

    | elapsed(초) | SMALL 소진% (k=0.00144) | MEDIUM 소진% (k=0.00183) | MEGA 소진% (k=0.00225) |
    |---|---|---|---|
    | 0 | 0.0 | 0.0 | 0.0 |
    | 60 | 6.9 | 9.8 | 12.7 |
    | 100/200/250 | 13.4(100s) / 25.0(200s) | 16.7(100s) / 36.7(250s) | 36.2(200s) |
    | 300/400/500 | 35.0(300s) | 51.9(400s) / **59.9(500s)** | — |
    | 600/700/900 | — | 72.2(700s) | 74.1(600s) / 86.8(900s) |
    | 1,200/1,333/1,500/1,800 | — | — | 93.3(1,200s) / **95.0(1,333s)** / 96.6(1,500s) / 98.3(1,800s) |

    굵게 표시한 지점(SMALL 200s, MEDIUM 500s, MEGA 1,333s)이 각 티어의 설계된 도착 elapsed이며, 목표(25%/60%/95%)와 정확히 일치. 세 티어 모두 스윕 전 구간 매진 0% — 개별 zone 무작위 편차로 매진에 가깝거나 매진일 수 있다는 D-21의 원래 해석은 그대로 유지(전체 풀 기준 소진율이 더 높아진 만큼 이번엔 그 확률도 더 높아짐)
  - **실측 검증 (timewarp 없이 실제 wall-clock, `scripts/_d23-queue-realtime-probe-tmp.ts` — D-22와 동일하게 실제 production 함수(`lib/queue.ts`의 `joinQueue`/`pollQueue`)를 직접 호출)**: MEGA로 정각(`queueOpenAt` = 클릭 시각)에 `joinQueue` 호출 → 초기 순번 40,000(=surgeBaseline) 확인. 이후 실제 90초간 15초 간격으로 6회 `pollQueue`를 실제 시간 경과로 호출 — 매 지점에서 `실제 순번 = 초기 순번 − admissionRatePerSec × 실제 경과초`와 소수점까지 정확히 일치(drift 0.000, 전 지점 OK). 전체 소요 시간은 25분을 실제로 기다리는 대신 D-7 timewarp와 동일한 메커니즘(순수 함수에 미래 `now`를 직접 주입)으로 검증 — designed wait(1,333.33s) 5초 전엔 `WAITING`(순번 150.01), designed wait 시점엔 부동소수점 나눗셈 잔차로 순번 0.01이 남아 아직 `WAITING`, +1초 후(1,334.33s)엔 순번 0.00·`ADMITTED` 확인 — 설계한 22.2분 대기가 실제 tick 계산과 정확히 일치함을 확인 (이 검증은 1차 개정의 flat `surgeBaseline=40,000` 모델 기준이었음 — 2차 개정 이후의 서지 구간 검증은 아래 "D-23 2차 개정"의 브라우저 검증 항목 참고)
  - **`lib/result.ts`의 `TIER_BENCHMARKS.targetTotalMs` 재조정 (사용자 확인 후 이번 범위에 포함)**: `totalDurationMs`가 합산하는 `stageTimings`에는 `queue` 단계(`joinQueue` → `redeemAdmissionToken`, 곧 이번에 늘어난 대기 시간 그 자체)가 포함되는데, 기존 `targetTotalMs`(SMALL 90s/MEDIUM 150s/MEGA 240s)는 "정각 클릭 시 대기열 통과가 거의 즉시"라는 D-4/D-21 시절의 전제를 깔고 있었음 — 그대로 두면 이번 변경 후 거의 모든 세션이 `slow_total_time` 피드백을 받게 되는 회귀가 확인돼, 사용자에게 확인 후 이번 범위에 포함하기로 함(그 외 `maxContentionLosses` 등 다른 벤치마크는 D-21 때처럼 손대지 않음 — 사용자가 명시적으로 한정). 새 `targetTotalMs` = 기존값(대기열 이외 단계의 기존 예산으로 간주) + 이번에 새로 정한 대기열 통과 시간 → SMALL 90s+200s=290s, MEDIUM 150s+500s=650s, MEGA 240s+1,333s≈1,573s
  - **다루지 않은 것**: `lib/result.ts`의 `maxContentionLosses`(사용자가 명시적으로 이번 범위에서 제외) — D-21/D-22 시점의 실측이 여전히 유효하다고 간주. `scripts/_d23-queue-realtime-probe-tmp.ts` — 검증용 임시 스크립트, D-22의 `_concurrency-probe-tmp.ts`/`_contention-losses-probe-tmp.ts`와 동일하게 사용자가 직접 정리 예정
  - **영향 범위**: `prisma/schema.prisma`+마이그레이션(`SimulationConfig.surgeBaseline` 추가), `lib/queue.ts`(`joinQueue`의 초기 순번 공식), `prisma/seed.ts`(세 티어 `surgeBaseline`/`admissionRatePerSec`/`arrivalRatePerSec`/`botCurveK` 갱신 — 이 과정에서 `simulationConfig.createMany`가 재시딩 시 `tier` 유니크 제약으로 실패하는 기존 버그를 발견해 티어별 `upsert`로 전환, 부수 수정), `lib/result.ts`(`TIER_BENCHMARKS.targetTotalMs`), `scripts/tune-bot-intensity.ts`(기본 `elapsedSeconds` 스윕을 0~1,800s로 확장), `lib/queue.test.ts`/`app/api/queue/route.test.ts`/`app/api/dev/timewarp/route.test.ts`(새 공식/설정값에 맞춰 기대값 갱신), `lib/tick.test.ts`(`caps the bot claim at availableSeatCount` 테스트가 하드코딩된 `+1h`를 쓰고 있어 새 MEGA `botCurveK`에서 더 이상 포화되지 않는 문제 발견 — 파일 내 다른 테스트들과 동일한 `SATURATING_ELAPSED_MS` 상수로 통일) — `lib/simulation.ts`(D-4 구현 시 정정과 동일한 이유로 변경 불필요)·`claimSeatsBatch`/D-20/D-22의 락 패턴·zone 밴딩(D-17)·좌석 라벨(D-19) 전부 변경 없음. 전체 테스트(219개) + lint + `tsc --noEmit` 통과
  - See: 사용자 요청 (오늘 날짜)
  - **D-23 2차 개정 — surgeBaseline 재설계(서지 구간 도입) + 리서치 기반 배율 적용** (사용자 요청, 1차 개정의 두 가지 문제 지적: (1) `surgeBaseline`이 고정 상수라 정각 클릭 반응속도(0.1초 vs 0.9초)가 순번에 거의 영향을 못 줘 F002/F003의 "얼마나 빨리 눌렀는지가 유의미해야 한다"는 핵심 훈련 의도를 죽임, (2) `40,000`이라는 값 자체가 근거 없이 부풀려진 추정치였음):
    - **리서치 재검증 (여러 차례 검색)**: 지디 콘서트(고척스카이돔, 수용 16,784~최대 25,000명, MEGA 15,000석과 거의 동일 체급) — 정각 클릭했지만 "느린 편"이라 자책한 사용자가 순번 25,000번대 → **좌석 대비 약 1~1.5배**. 임영웅 잠실주경기장(6~7만석, MEGA보다 훨씬 큰 스타디움급) — 대기열 최고 44~45만 명 → 좌석 대비 약 6~7배(국민급 스타의 최상위 피크 수요, 참고용 상한 감각으로만 사용 — MEGA에 그대로 적용하지 않음). SMALL/MEDIUM 규모(2,500~7,000석)의 "평범한 인기 콘서트" 순번 실측 후기는 여러 차례 검색에도 발견하지 못함(화제성 있는 극단적 사례만 후기·기사화되는 경향으로 추정) — **이 규모의 배율은 실측 데이터 부재를 인정**하고, MEGA와 동일 배율을 채택해 일관성을 유지하기로 판단(대신 티어 간 체감 난이도 차이는 `admissionRatePerSec`/`botCurveK` 쪽에서 만듦 — 이미 D-23 1차 개정에서 그렇게 설계돼 있었음)
    - **결정: `surgeBaseline`을 "고정 상수"에서 "서지 구간(오픈 후 정확히 1초) 안에서 계산되는 상한"으로 재설계**. 서지 구간을 3초가 아닌 1초로 정한 이유: 실제 "예매하기" 버튼 클릭의 반응속도는 보통 1초 이내이고, 구간이 길수록 그 안에서의 반응속도 차이가 결과 순번에 흐릿하게 반영되므로(0.1초 vs 0.9초 차이가 3초 구간에서는 상대적으로 작아짐), 반응속도 훈련 효과를 극대화하려면 구간을 최대한 짧게 잡아야 함
    - **최종 수식** (`lib/simulation.ts`의 `computeInitialQueuePosition`, `SURGE_WINDOW_SECONDS = 1`):
      ```
      t = elapsedSinceOpen(초)
      position = t <= 1
        ? surgeBaseline × (t / 1)                          // 서지 구간: 0→surgeBaseline 선형 램프
        : surgeBaseline + arrivalRatePerSec × (t - 1)       // 서지 구간 이후: 기존처럼 완만하게 증가
      ```
      경계(t=1)에서 두 구간이 정확히 `surgeBaseline`으로 연속(불연속 없음). 서지 구간 안에서는 반응 시간이 순번에 정비례로 직결 — 0.1초 클릭은 `surgeBaseline`의 10%, 0.9초 클릭은 90%
    - **`surgeBaseline` 재산정** (좌석 수 × 5/3 — MEGA를 지디 실측치 25,000에 정확히 맞추는 배율을 구하면 25,000/15,000 = 5/3이 나오고, 이 배율을 세 티어에 동일 적용. 결과가 요청 범위(SMALL 3,750~5,000 / MEDIUM 10,500~14,000 / MEGA 22,500~30,000) 안에 모두 들어옴):

      | Tier | 좌석 수 | surgeBaseline (좌석수×5/3) |
      |---|---|---|
      | SMALL | 2,500 | 4,167 |
      | MEDIUM | 7,000 | 11,667 |
      | MEGA | 15,000 | 25,000 (지디 실측치와 정확히 일치) |

    - **`admissionRatePerSec` 재조정 (대기 시간 목표 유지)**: 대기 시간 = `surgeBaseline / admissionRatePerSec` 관계는 그대로이므로, 1차 개정에서 이미 확정한 대기 시간 목표(SMALL 200s/MEDIUM 500s/MEGA ~1,333s)를 그대로 유지하도록 `admissionRatePerSec = 새 surgeBaseline / 목표 대기 시간`으로 역산. `arrivalRatePerSec`도 기존 관례(D-4의 "깔끔한 숫자를 위한 미러링")대로 동일값 유지

      | Tier | surgeBaseline | admissionRatePerSec = arrivalRatePerSec | 대기 시간 |
      |---|---|---|---|
      | SMALL | 4,167 | 20.84 | 4167/20.84 ≈ 199.95s (~3m20s, 변화 없음) |
      | MEDIUM | 11,667 | 23.33 | 11667/23.33 ≈ 500.09s (~8m20s, 변화 없음) |
      | MEGA | 25,000 | 18.75 | 25000/18.75 = 1,333.33s (정확히 동일, 변화 없음) |

    - **`botCurveK`/`targetTotalMs` 영향 확인 (요청 항목 3, 4)**: 세 티어 모두 대기 시간이 (반올림 오차 0.1초 이내로) 그대로 유지돼, 좌석 화면 도달 elapsed(200s/500s/1,333.33s)도 그대로 — 1차 개정에서 이 elapsed 기준으로 역산한 `botCurveK`(0.00144/0.00183/0.00225)와 `lib/result.ts`의 `targetTotalMs`(290,000/650,000/1,573,000ms)는 **재계산 불필요, 변경 없음**. `scripts/tune-bot-intensity.ts`로 재실측해 동일 elapsed 지점에서 소진율이 여전히 정확히 25.0%/59.9%/95.0%임을 확인(결정론적, stddev 0.000) — 가설대로 영향 없음이 실측으로 확인됨
    - **스키마 변경 없음**: `SimulationConfig.surgeBaseline` 필드는 1차 개정에서 이미 추가돼 있어 값·해석 방식만 바뀜 — 마이그레이션 불필요, `prisma/seed.ts` 값 갱신 후 재시딩만 수행
    - **브라우저 검증 (Playwright, 실제 dev 서버, `POST /api/dev/timewarp`의 `openInMs`로 서지 구간 안팎의 도착 시각을 정밀 재현 — 실제 클릭 타이밍을 흉내내되 네트워크/서버 왕복 오버헤드까지 포함된 실측치)**:
      - **서지 구간 안 반응속도 민감도**: MEGA에서 `openInMs=-100/-500/-900`(각각 목표 0.1s/0.5s/0.9s 지연) 적용 후 즉시 join한 실측 순번 — 5,525(체감 elapsed≈0.22s) / 12,875(≈0.52s) / 22,850(≈0.91s). 가장 빠른 값과 가장 느린 값의 차이 17,325 — "수천 단위 이상" 목표를 크게 상회. SMALL(542 vs 3,792, 차이 3,250)·MEDIUM(1,283 vs 10,594, 차이 9,311)도 동일하게 확인 — **세 티어 모두 "빨리 누르면 확실히 유리하다"는 체감이 실측으로 확인됨**
      - **서지 구간을 넘긴 경우의 완만한 증가**: MEGA에서 `openInMs=-3000/-5000`(3초/5초 지연) → 순번 25,038 / 25,075 — `lib/simulation.test.ts`의 예측값과 정확히 일치, 서지 구간 안(수천 단위 차이)과 비교해 압도적으로 완만함(2초 사이 37 증가)
    - **회귀 테스트**: `lib/simulation.test.ts`에 `computeInitialQueuePosition` 신규 스위트(경계 t=0/t=1 연속성, 서지 구간 내 비례 램프, 서지 구간 밖 완만한 증가, 결정론) 추가. `lib/queue.test.ts`의 D-4/D-23 관련 케이스 전면 재작성(서지 구간 시작점=0, 서지 구간 종료점=surgeBaseline, 서지 구간 안 반응속도 차이 케이스 신규 추가, 서지 구간 밖 케이스는 새 수치로 갱신). `app/api/queue/route.test.ts`의 실측 허용 오차 범위를 새 수치·새 admissionRatePerSec 배율에 맞춰 조정. 전체 테스트(227개, 신규 8개 포함) + lint + `tsc --noEmit` 통과
    - **영향 범위**: `lib/simulation.ts`(`computeInitialQueuePosition`/`SURGE_WINDOW_SECONDS` 신규), `lib/queue.ts`(`joinQueue`가 새 함수 사용), `prisma/seed.ts`(세 티어 `surgeBaseline`/`admissionRatePerSec`/`arrivalRatePerSec` 갱신 — `botCurveK`/`errorRate`/`latencyMs`/좌석 스케일 변경 없음), `lib/simulation.test.ts`/`lib/queue.test.ts`/`app/api/queue/route.test.ts` — `lib/result.ts`(`targetTotalMs`)·`scripts/tune-bot-intensity.ts`·스키마·마이그레이션 전부 변경 없음(확인 완료, 위 참고)
    - See: 사용자 요청 (오늘 날짜)
- [x] **D-24 (후보, 미착수). D-23 브라우저 검증 중 zone간 소진율이 지나치게 균일하다는 관찰 — 무대 근접도 기반 공간적 가중치 도입 여지** (D-23 실측 검증 중 발견 — 사용자 요청으로 이번엔 착수하지 않고 후보로만 기록): MEGA 기준 elapsed ~22분 지점에서 여러 zone(1, 5, 10, 13, 20, 25)의 소진율을 실측하니 94~96%로 거의 균일했음 — `claimSeatsBatch`(D-20)가 zone 구분 없이 전체 풀(15,000석)에서 `ORDER BY random()`으로 균등 무작위 클레임하는 기존 설계(D-21에서 이미 명시적으로 채택) 때문에, 600석 표본 크기에서 zone간 편차가 크게 벌어지지 않음 — "인기 zone은 꽉 차고 다른 zone은 널널함" 대신 "거의 모든 zone이 고르게 빡빡함"에 가까운 체감. 기능 자체(여러 zone을 옮겨 다니며 빈자리 찾기)는 정상 동작하므로 버그는 아니며, D-23의 명시적 요청 범위(초기 순번·대기 시간·전체 소진율 곡선)를 벗어난 관찰이라 이번엔 손대지 않음
  - **후보 방향**: 무대 근접 zone(낮은 zone 번호, D-17의 band 기준 무대에 가까운 열)이 먼 zone보다 먼저·더 빠르게 소진되도록 `claimSeatsBatch`에 zone 기반 가중치(예: band별 확률 가중 또는 순차적 소진 우선순위)를 도입하는 방향 — 실제 티케팅도 앞자리부터 매진되는 경향이 있어 리서치 근거로 뒷받침 가능
  - **착수 조건**: 사용자가 별도로 요청할 때 Task로 승격, 실측(zone별 소진율 분산)부터 재확인 후 설계
  - See: 사용자 요청 (오늘 날짜)
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

### Phase 4: 규모 확장 및 배포

> **목표:** 좌석 규모를 실제 콘서트장 수준으로 확장하고, 성능·안정성 확보 및 Vercel 배포 파이프라인 구축

- **Task 012: 좌석 규모 확장** ✅ - 완료 (See: D-15, D-16, `tasks/014-seat-scale-expansion.md`)
  - `SimulationConfig`에 `seatRows`/`seatsPerRow`/`zoneCount` 필드 추가 + 마이그레이션
  - 행 라벨링을 숫자 기반으로 전환 (현재 알파벳 1글자 A~J로는 MEDIUM 70행/MEGA 150행을 못 담음)
  - `app/api/session/route.ts`의 seat-generation을 티어 파라미터화
  - `getZoneForSeatNumber`(`lib/seat-zones.ts` — 구현 중 `lib/dummy-data.ts`에서 분리, D-16 이전 별도
    사유)를 티어별 zone 수 참조하도록 변경
  - `GET /api/seats`를 zone-scoped 응답으로 전환 (`app/api/seats/route.ts`, `lib/seats.ts::listSeatMap`)
  - `SeatCell`(`app/components/SeatCell.tsx`)에 `React.memo` 적용
  - MEGA `botIntensity` 재실측·재튜닝 (200석 기준이던 기존 값 80은 15,000석 풀에서 무효 —
    `scripts/tune-bot-intensity.ts` 재사용, 최종 200 — 1차 재튜닝값 6000이 실제 elapsed 조건에서
    매진되는 결함을 D-16에서 발견해 방법론 수정 후 재확정)
  - 구현 중 `Seat.row` 정렬 버그(숫자 라벨 + 문자열 정렬 충돌) 발견·수정 — 상세는
    `tasks/014-seat-scale-expansion.md` 변경 사항 요약

- **Task 013: 성능 최적화 및 배포**
  - tick 엔진 쿼리 최적화
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

> 순서 원칙: 매번 기존 아키텍처를 갈아엎지 않고 그 위에 얹는 확장만 선택 (MVP → 프로덕션급으로 키워가는
> 스토리가 포트폴리오 설명에서 이어지도록).

---
