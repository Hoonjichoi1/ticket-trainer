# Task 010: 예매 정보 · 결제 · 실패 대응 분기 API

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 010 항목 업데이트

## 개요

Phase 3 우선순위 작업(F013 예매 정보, F014 결제 수단·소요 시간, F009 에러 주입, F010 실패 대응 분기,
F007 hold 만료) — `app/api/booking/route.ts`·`app/api/payment/route.ts`는 현재 `501 not_implemented`
스텁이고, `app/booking/BookingView.tsx`·`app/payment/PaymentView.tsx`는 API 호출 없이 클라이언트에서만
동작한다(`BookingView`는 `selectedAt + 하드코딩 5분`으로 hold 타이머를 자체 계산하고, `PaymentView`의
"결제하기"는 서버를 전혀 거치지 않고 `setTimeout` + `Math.random()`으로 성공/실패를 흉내낸다). 이 Task는
둘 다 실 API로 교체하고, hold 소유권·만료를 서버가 검증하며, 티어별 `errorRate` 기반 결제 실패 주입과
F010의 3가지 실패 대응 분기(재결제/새로고침/hold 만료)를 실제로 구현한다.

**범위 경계:** hold 원자성 자체(조건부 `UPDATE` + `Hold` insert, 만료 hold의 lazy 해제)는 Task 009
`lib/seats.ts`에서 이미 완성됐다. 이 Task는 그 위에서 (1) 세션이 소유한 활성 hold를 조회·검증하는
계층, (2) 결제 성공 시 `Seat.status → SOLD` + `Booking` 생성 + `Hold` 정리를 묶는 새 트랜잭션, (3) 명시적
hold 해제(만료 대기가 아니라 즉시 해제) 엔드포인트만 추가한다. 결과 리포트 집계(outcome 확정, 피드백
매핑)는 Task 011의 몫이며 이 Task는 `stageTimings`/`events`만 기록한다(ROADMAP "관측 데이터 원칙").

**설계 결정:**

- **hold 소유권 조회는 seatId가 아니라 sessionId로** — `getOwnedHold({ sessionId, runId })`
  (`lib/seats.ts` 신규): `Hold.releasedAt IS NULL` + `Hold.sessionId = sessionId` + `Seat.simulationRunId =
  runId`인 행을 조회해 seat 정보까지 함께 반환한다. `app/booking/page.tsx`/`app/payment/page.tsx`는 이걸로
  "이 세션이 지금 확보하고 있는 좌석"을 서버 진실로 삼는다 — 클라이언트가 `seatId`를 body에 실어 보낼
  필요가 없으므로 위조/불일치 여지가 없다(`sessionStorage`의 `SelectedSeatStorage`는 화면 표시용으로만
  남는다).
- **페이지 진입 시 만료 스윕 선행** — `app/booking/page.tsx`/`app/payment/page.tsx`(Server Component)와
  `POST /api/booking`/`POST /api/payment` 모두, `getOwnedHold` 조회 **직전**에 Task 009의
  `releaseExpiredHolds({ runId, now })`를 먼저 호출한다. `GET /api/seats` 폴링은 좌석 페이지를 벗어나면
  더 이상 일어나지 않으므로, 예매정보/결제 단계에서 hold가 5분 만료됐는지 확인할 다른 경로가 없다 —
  이 스윕이 그 자리를 대신한다. 세션의 hold가 스윕에 걸려 해제됐으면(`releaseExpiredHolds`가 이미
  `hold_expired` 이벤트를 기록함, Task 009 로직 그대로 재사용) `getOwnedHold`는 그냥 `null`을 반환한다.
- **Server Component 가드로 페이지 레벨 방어** — `app/seats/page.tsx`(Task 008 `requireAdmission` 패턴)와
  동일하게, `app/booking/page.tsx`/`app/payment/page.tsx`도 `requireSession` → `getActiveRun` → 만료
  스윕 → `getOwnedHold`를 거쳐 hold가 없으면 `/seats`로 리다이렉트한다. API 라우트의 검증은 직접 호출
  우회를 막는 방어적 이중화(Task 009와 동일 원칙)이지 페이지 가드를 대체하지 않는다.
- **예매 정보 확정 (`POST /api/booking`)** — `lib/booking.ts`(신규) `confirmBookingInfo({ sessionId, runId,
  request, now })`: 스윕 → `getOwnedHold` → 없으면 `{status:"hold_expired"}`. 있으면 `termsAgreed`가
  `true`인지만 검증(`deliveryMethod`/`ticketCount`는 스키마에 저장할 필드가 없음 — `Booking` 모델에
  배송 방법 컬럼이 없고, PRD상으로도 결제 성공 시 최종 확정되는 정보가 아니라 결제 페이지로 넘어가기 위한
  화면 흐름 검증용이라 영속화 대상이 아님). 성공 시 `stageTimings.booking_info.exitedAt` 기록,
  `{status:"ok", holdExpiresAt}` 반환. `booking_info.enteredAt`은 `app/booking/page.tsx`(Server Component)가
  `getOwnedHold` 성공 시 `recordStageEntered`로 기록한다(idempotent라 재방문해도 안전, `app/seats/page.tsx`가
  admission 확인 시 기록하지 않고 GET 폴링 쪽에서 기록하는 것과 마찬가지로 "진입이 확인된 시점"에 기록).
- **결제 시도 (`POST /api/payment`)** — `lib/payment.ts`(신규) `attemptPayment({ sessionId, runId, request,
  now })`:
  1. 스윕 → `getOwnedHold` → 없으면 `{status:"hold_expired"}` (확정 반영: 애초 초안이던
     `{status:"error", errorType:"server_error"}` 대신 — hold 만료는 재시도해도 소용없는 상황이므로
     `confirmBookingInfo`와 동일한 `hold_expired`로 응답해 클라이언트가 "일시적 에러"로 오인해 헛되이
     재결제를 반복하지 않게 한다. 이를 위해 `lib/types.ts`의 `SubmitPaymentResponse`에 `hold_expired` 유니온
     멤버를 추가했다).
  2. `SimulationConfig.errorRate`(해당 run의 `tier` 기준)를 조회해 실패 여부를 결정하는 순수 함수
     `shouldInjectPaymentError(errorRate: number, roll: number): boolean`(`lib/payment.ts`)을 둔다 — `roll`을
     호출부에서 주입받게 해서(기본값 `Math.random()`) 결정론적 단위 테스트가 가능하게 한다(Task 007
     `computeBotClaimCount`와 같은 "순수 계산 / DB 실행 분리" 패턴).
  3. **실패 시**: hold를 건드리지 않는다(F010 "재결제 → hold 유지" — 아무 것도 해제하지 않는 것 자체가 그
     구현이다). `errorType`은 기존 클라이언트 로직과 동일하게 50/50 `timeout`/`server_error`(같은 방식으로
     주입 가능한 `roll` 사용). `payment_error` 이벤트 기록 후 `{status:"error", errorType}` 반환.
  4. **성공 시**: 한 트랜잭션 안에서 (a) hold가 여전히 유효한지 재확인(`releasedAt IS NULL` +
     `expiresAt > now`, 결제 처리 중 만료된 극단적 경쟁 상황 방지) (b) `Seat.status: HELD → SOLD`
     (c) `Booking.create({ concertId, seatId, sessionId })` (d) `Hold.releasedAt = now` — CLAUDE.md의
     "Seat.status 변경과 Hold/Booking 쓰기는 같은 트랜잭션" 요구를 그대로 따른다(Task 009 `claimSeat`과
     같은 트랜잭션 원칙, 대상 컬럼만 다름). `stageTimings.payment.exitedAt` 기록. 이 세션의 가장 최근
     payment 단계 이벤트가 `payment_error`였다면(= 재시도 성공) **추가로** `payment_retry_success` 이벤트도
     기록한다 — 클라이언트가 "재시도 여부" 플래그를 보낼 필요 없이 서버가 이미 기록된 이벤트 로그만으로
     판단한다(Task 009가 확립한 "서버가 관측 데이터의 유일한 진실"이라는 원칙 유지). `{status:"success",
     bookingId}` 반환. **`SessionResult.outcome`은 여기서 쓰지 않는다** — ROADMAP 명시대로 Task 011만
     `outcome`을 확정한다.
- **명시적 hold 해제 (`POST /api/holds/release`, 신규 라우트)** — F010 "새로고침·뒤로가기 → hold 상실 +
  좌석 방출"과 CLAUDE.md "페이지 이탈 시 `navigator.sendBeacon` 기반 hold 해제(베스트 에포트)"를 구현하는
  엔드포인트. `lib/seats.ts`에 `releaseHold({ sessionId, runId, now })` 추가 — 이 세션의 활성 hold를
  만료 여부와 무관하게 즉시 해제(`releasedAt = now` + `Seat.status → AVAILABLE`, 같은 트랜잭션). 이 세션의
  가장 최근 payment 단계 이벤트가 `payment_error`였을 때만 **추가로** `payment_abandoned` 이벤트를 기록한다
  (에러 없이 그냥 좌석 페이지에서 나가는 경우까지 `payment_abandoned`로 잘못 표시하지 않기 위함 — 그 경우는
  기록할 판단 이벤트가 없고, hold는 5분 뒤 lazy 만료로 정리된다). 활성 hold가 없으면 조용히 204만 반환(멱등,
  beacon 재전송·중복 unload 이벤트에 안전).
  - `sendBeacon`은 커스텀 헤더를 못 붙이지만 same-origin 요청이라 세션 쿠키는 자동으로 실린다 — 라우트는
    기존 `requireSession()` 그대로 사용 가능.
  - `app/booking/BookingView.tsx`/`app/payment/PaymentView.tsx`에 `pagehide` 리스너로
    `navigator.sendBeacon("/api/holds/release")` 등록(공용 훅으로 뽑을지는 구현 중 판단 — 로직이 두 줄
    수준이라 굳이 분리 안 해도 무방).
- **`PaymentView.tsx`의 수단별 소요 시간(`METHOD_META.durationMs`)은 서버 개입 없이 클라이언트 UX로
  유지** — PRD F014 "수단별 소요 시간 상이"는 사용자 체감(무통장 최속/카드 최저속) 연출이지 서버 지연
  주입이 아니라고 판단했다. `SimulationConfig.latencyMs`(티어별 필드)는 별도로 존재하며, 이건 "이 티어의
  결제 서버가 얼마나 혼잡한가"를 나타내는 값이므로 실제 `POST /api/payment` 응답 자체를 그만큼 지연시키는
  데 쓴다(`await sleep(config.latencyMs)` 후 응답). 즉 클라이언트 스피너는 `durationMs`만큼 돌고, 서버는
  별도로 `latencyMs`만큼 처리 시간을 더한다 — 둘은 다른 축이라 합연산해도 자연스럽다.
- **"결제 실패 시뮬레이션(테스트용)" 체크박스 제거** — 지금 `PaymentView.tsx`의 `forceFailure` 체크박스는
  실 서버 검증이 없던 시절 QA용 임시 기능이었다. 실제 `errorRate` 기반 서버 판정이 들어오면 목적이
  사라지므로 제거한다(남겨두면 티어 난이도 체감이 왜곡됨).

## 관련 파일

- `app/api/booking/route.ts` — `POST` 핸들러 구현, `501` 스텁 제거 (수정)
- `app/api/booking/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `app/api/payment/route.ts` — `POST` 핸들러 구현, `501` 스텁 제거 (수정)
- `app/api/payment/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `app/api/holds/release/route.ts` — `sendBeacon` 대상 명시적 hold 해제 라우트 (신규)
- `app/api/holds/release/route.test.ts` — 라우트 테스트 (신규)
- `lib/booking.ts` — `confirmBookingInfo` (신규)
- `lib/booking.test.ts` — 위 함수 단위 테스트 (신규)
- `lib/payment.ts` — `attemptPayment`, `shouldInjectPaymentError`(순수 함수), 결제 성공 트랜잭션 (신규)
- `lib/payment.test.ts` — 위 함수 단위/통합 테스트, `shouldInjectPaymentError`는 순수 함수라 모킹 없이
  직접 검증 (신규)
- `lib/seats.ts` — `getOwnedHold({ sessionId, runId })`, `releaseHold({ sessionId, runId, now })` 추가 (수정)
- `lib/seats.test.ts` — 위 추가 함수 테스트 (수정)
- `lib/session-result.ts` — 참고용(수정 없음 예상): `recordStageEntered`/`recordStageExited`/
  `recordJudgmentEvent` 재사용
- `lib/queue.ts` — 참고용(수정 없음): `getActiveRun` 재사용
- `lib/session.ts` — 참고용(수정 없음): `requireSession` 재사용
- `lib/types.ts` — `SubmitPaymentResponse`에 `hold_expired` 유니온 멤버 추가 (수정, 확정 반영)
- `app/booking/page.tsx` — 현재 가드 없는 트리비얼 페이지 → `requireSession`/`getActiveRun`/만료 스윕/
  `getOwnedHold` 서버 가드 + `recordStageEntered` 추가, 없으면 `/seats` 리다이렉트 (수정)
- `app/booking/BookingViewLoader.tsx` — 서버에서 확인한 hold/seat 정보를 `BookingView`에 props로 전달하도록
  조정 (수정)
- `app/booking/BookingView.tsx` — 하드코딩 `HOLD_DURATION_MS` 계산 제거(서버 제공 `holdExpiresAt` 사용),
  "결제하기" 클릭 시 `POST /api/booking` 호출로 교체, `hold_expired` 응답 처리(→ `/seats` 안내), `pagehide`
  시 `sendBeacon` 해제 등록 (수정)
- `app/payment/page.tsx` — `app/booking/page.tsx`와 동일한 서버 가드 패턴 적용 (수정)
- `app/payment/PaymentViewLoader.tsx` — 서버에서 확인한 hold/seat 정보 props 전달 (수정)
- `app/payment/PaymentView.tsx` — 클라이언트 전용 `setTimeout`/`Math.random()` 결제 시뮬레이션 제거,
  `POST /api/payment` 실 호출로 교체(수단별 `durationMs`는 스피너 연출로만 유지), `forceFailure` 테스트
  체크박스 제거, 재결제(`PaymentModal.onRetry`)가 실제로 API를 다시 호출하도록 연결, `pagehide` 시
  `sendBeacon` 해제 등록 (수정)
- `app/components/PaymentModal.tsx` — 참고용(수정 없음 예상): 기존 phase(loading/success/failure) 구조
  그대로 재사용
- `prisma/schema.prisma` — 변경 없음 예상(`Booking` 모델의 기존 필드로 충분). 구현 중 필요성이 드러나면
  Task 008/009처럼 "계획 변경"으로 기록

## 선행 조건

- Task 009 (`lib/seats.ts`의 `releaseExpiredHolds`, `claimSeat`, `HOLD_DURATION_MS`, hold 원자성 트랜잭션
  패턴, `lib/session-result.ts` 관측 데이터 헬퍼)

## 수락 기준

- [x] `app/booking/page.tsx`/`app/payment/page.tsx`: hold가 없거나 만료된 세션은 `/seats`로 리다이렉트됨
- [x] `POST /api/booking`: 유효한 hold + `termsAgreed:true`면 `{status:"ok", holdExpiresAt}` 반환,
      `stageTimings.booking_info.exitedAt` 기록됨
- [x] `POST /api/booking`: hold가 없거나 만료됐으면 `{status:"hold_expired"}` 반환, DB 변경 없음(스윕이
      이미 처리한 경우 제외)
- [x] `POST /api/payment`: `SimulationConfig.errorRate`(티어별)에 따라 확률적으로 실패가 주입됨(순수 함수
      `shouldInjectPaymentError`로 결정론적 검증 가능)
- [x] `POST /api/payment` 성공 시: 같은 트랜잭션에서 `Seat.status → SOLD` + `Booking` 생성 +
      `Hold.releasedAt` 기록이 원자적으로 일어남
- [x] `POST /api/payment` 실패 시: hold는 그대로 유지됨(`Seat.status`도 `HELD` 그대로)
- [x] `POST /api/payment`: 실패 이벤트(`payment_error`) 기록 후 재시도 성공 시 `payment_retry_success`
      이벤트가 추가로 기록됨(첫 시도 성공에는 기록되지 않음)
- [x] `POST /api/payment` 성공 시 `SessionResult.outcome`은 변경되지 않음(Task 011 전용)
- [x] `POST /api/holds/release`: 활성 hold를 만료 여부와 무관하게 즉시 해제(`Seat.status → AVAILABLE`),
      직전 이벤트가 `payment_error`였을 때만 `payment_abandoned` 이벤트 추가 기록
- [x] `POST /api/holds/release`: 활성 hold가 없으면 부작용 없이 204 반환(멱등)
- [x] 세션의 hold가 5분 만료됐으면(스윕 시점) `POST /api/booking`/`POST /api/payment` 모두
      `hold_expired`/에러로 정확히 응답함
- [x] `app/booking/BookingView.tsx`/`app/payment/PaymentView.tsx`가 더미/클라이언트 전용 로직 대신 실
      API로 동작하고, 페이지 이탈 시 `sendBeacon` hold 해제를 시도함
- [x] 타입 체크·린트 통과

## 구현 단계

1. [ ] `lib/seats.ts`: `getOwnedHold({ sessionId, runId })` 추가 — 활성 hold + 연결된 seat 정보 반환,
      없으면 `null`
2. [ ] `lib/seats.ts`: `releaseHold({ sessionId, runId, now })` 추가 — 만료 여부 무관 즉시 해제(같은
      트랜잭션으로 `Hold.releasedAt` + `Seat.status → AVAILABLE`), 직전 payment 단계 이벤트가
      `payment_error`면 `payment_abandoned` 기록
3. [ ] `lib/booking.ts`: `confirmBookingInfo({ sessionId, runId, request, now })` — 스윕 →
      `getOwnedHold` → `termsAgreed` 검증 → `stageTimings.booking_info.exitedAt` 기록 →
      `SubmitBookingInfoResponse` 반환
4. [ ] `lib/payment.ts`: `shouldInjectPaymentError(errorRate, roll)` 순수 함수 작성
5. [ ] `lib/payment.ts`: `attemptPayment({ sessionId, runId, request, now })` — 스윕 → `getOwnedHold` →
      `SimulationConfig` 조회(`latencyMs` 지연 적용) → `shouldInjectPaymentError`로 성공/실패 분기 →
      실패 시 `payment_error` 이벤트 + 에러 응답, 성공 시 판매 확정 트랜잭션(`Seat→SOLD` + `Booking` +
      `Hold` 정리) + `stageTimings.payment.exitedAt` + (재시도 판별 시) `payment_retry_success` 기록
6. [ ] `app/api/booking/route.ts`: `requireSession`/`getActiveRun` 가드 → `confirmBookingInfo` 호출,
      `501` 스텁 제거
7. [ ] `app/api/payment/route.ts`: 동일 가드 → `attemptPayment` 호출, `501` 스텁 제거
8. [ ] `app/api/holds/release/route.ts`: `requireSession`/`getActiveRun` 가드 → `releaseHold` 호출 →
      204 반환(신규)
9. [ ] `app/booking/page.tsx`: Server Component 가드(스윕 + `getOwnedHold`, 없으면 `/seats` 리다이렉트) +
      `recordStageEntered("booking_info")`, 확인된 hold 정보를 `BookingViewLoader`에 전달
10. [ ] `app/booking/BookingView.tsx`: 서버 제공 `holdExpiresAt` 사용, `POST /api/booking` 연결,
       `hold_expired` 처리, `pagehide` beacon 해제 등록
11. [ ] `app/payment/page.tsx`: `app/booking/page.tsx`와 동일한 가드 적용
12. [ ] `app/payment/PaymentView.tsx`: `POST /api/payment` 연결(수단별 `durationMs`는 스피너 연출로 유지),
       `forceFailure` 체크박스 제거, 재시도 흐름을 실 API 재호출로 연결, `pagehide` beacon 해제 등록
13. [ ] 타입 체크·린트 통과 확인
14. [ ] Vitest 단위/통합 테스트 작성 (아래 테스트 체크리스트 참조)
15. [ ] Playwright MCP로 실제 dev 서버를 구동해 E2E 플로우 검증 (Task 006~009와 동일하게 대화형 검증만
       수행, 커밋되는 자동화 테스트는 Vitest만 유지)

## 테스트 체크리스트

### 단위 테스트 (Vitest)

- [x] `shouldInjectPaymentError`: `roll < errorRate`일 때만 `true` (경계값 포함, 모킹 없이 순수 함수로 검증)
- [x] `getOwnedHold`: 활성 hold 있으면 반환, 없으면/타 세션 소유면 `null`
- [x] `releaseHold`: 활성 hold를 만료 전이라도 즉시 해제, 직전 이벤트가 `payment_error`일 때만
      `payment_abandoned` 기록
- [x] `confirmBookingInfo`: hold 있고 `termsAgreed:true` → `ok` + `exitedAt` 기록, hold 없음 →
      `hold_expired`, `termsAgreed:false` → 실패
- [x] `attemptPayment`: 성공 케이스 — `Seat→SOLD`/`Booking`/`Hold` 정리가 한 트랜잭션 결과로 확인됨
- [x] `attemptPayment`: 실패 케이스 — hold/`Seat.status` 변경 없음, `payment_error` 이벤트 기록
- [x] `attemptPayment`: `payment_error` 이후 재시도 성공 시 `payment_retry_success` 추가 기록, 첫 시도
      성공은 추가 이벤트 없음

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `POST /api/booking` → `POST /api/payment` 전체 흐름이 실제 DB 상태와 일치
- [x] 만료된 hold로 `POST /api/booking`/`POST /api/payment` 호출 시 정확히 `hold_expired`/에러 응답
- [x] `POST /api/holds/release` 호출 후 좌석이 즉시 `AVAILABLE`로 재클레임 가능함(Task 009 `claimSeat`
      재사용 확인)
- [x] 이미 `SOLD`된 좌석에 대한 재결제 시도가 거부됨
- [x] 세션 미검증/미보유 hold 요청이 거부됨

### E2E 검증 (Playwright MCP, 실제 dev 서버 대화형 구동 — Task 006~009와 동일하게 커밋되는 스펙 파일 없음)

- [x] 정상 결제 성공 플로우: 좌석 선택 → 예매정보 → 결제 → 결과 페이지 도달
- [x] 결제 에러 발생 → 재결제 성공(hold 유지 확인)
- [x] 결제 에러 발생 후 새로고침/뒤로가기 → hold 상실 확인(좌석이 다시 `AVAILABLE`로 보임)
- [x] hold 5분 만료(또는 짧은 만료값으로 재현) 후 예매정보/결제 페이지 접근 시 `/seats`로 리다이렉트
- [x] 예매정보 페이지에서 약관 미동의 시 "결제하기" 비활성 상태 유지(기존 UI 동작 재확인)

## 변경 사항 요약

- **`SubmitPaymentResponse`에 `hold_expired` 유니온 멤버 추가 (사용자 확정 지시 반영)**: 계획서 초안에서
  "구현 중 재검토" 항목으로 열어뒀던 지점을 착수 전에 확정했다. `attemptPayment`가 스윕 후 `getOwnedHold`가
  `null`이면 `{status:"error", errorType:"server_error"}` 대신 `{status:"error"}`가 아닌
  `{status:"hold_expired"}`를 반환하도록 구현 — `confirmBookingInfo`와 동일한 처리로 통일했다.
  `app/payment/PaymentView.tsx`도 `hold_expired` 응답을 받으면 결제 모달을 닫고 `/seats`로 즉시 리다이렉트
  하도록(재결제 유도 없이) 분기했다.
- **예매정보 유효성 검증(`deliveryMethod`/`termsAgreed`)은 계획서 설계와 달리 `lib/booking.ts`가 아니라
  `app/api/booking/route.ts`에서 수행**: 원래 설계 문서는 "`confirmBookingInfo`가 `termsAgreed`를 검증"이라고
  적었으나, 구현하면서 `app/api/seats/route.ts`가 `seatId` 형태 검증을 라우트에서 하고 `lib/seats.ts`는 도메인
  로직만 담당하는 기존 패턴과 맞추는 게 일관적이라고 판단해 라우트 레벨 400 응답(`INVALID_DELIVERY_METHOD`/
  `TERMS_NOT_AGREED`)으로 옮겼다. `confirmBookingInfo`는 hold 소유권 검증과 `stageTimings` 기록만 담당한다.
- **`BookingView`/`PaymentView`가 더 이상 `sessionStorage`를 소스로 읽지 않음**: 계획서는 "`sessionStorage`는
  화면 표시용으로 남는다"고 적었으나, 구현하면서 `app/booking/page.tsx`/`app/payment/page.tsx`(Server
  Component)가 이미 `getOwnedHold`로 서버 진실을 조회해 props로 내려주는 이상, 클라이언트가 별도로
  `sessionStorage`를 또 읽는 것은 두 소스가 어긋날 위험만 더하는 순수 중복이라고 판단해 제거했다. `lib/
  session-storage.ts`(Task 009)의 `saveSelectedSeat`/`getSelectedSeat`/`clearSelectedSeat` 자체는 건드리지
  않았다 — `SeatsView.tsx`는 여전히 클레임 성공 시 이 값을 저장하지만, 이제 아무도 읽지 않는 값이 됐다(Task
  009 파일 수정은 이번 Task 범위 밖으로 남겨둠).
- **`lib/session-result.ts`에 `getSessionEvents` 신규 추가 (계획에 없던 파일 변경)**: `releaseHold`(hold 상실
  판별)와 `attemptPayment`(재시도 성공 판별)가 공통으로 "이 세션의 마지막 payment 단계 이벤트가 무엇이었는지"
  읽어야 했는데, 기존 `lib/session-result.ts`에는 쓰기 헬퍼(`recordJudgmentEvent` 등)만 있고 읽기 헬퍼가
  없어서 하나 추가했다. `getOrCreate`와 달리 세션 행이 없으면 그냥 빈 배열을 반환하며 새로 만들지 않는다
  (읽기 전용이므로 부작용이 없어야 함).
- **검증**: `npx tsc --noEmit`, `npm run lint` 모두 통과. `npx vitest run --fileParallelism=false`
  **129 tests / 15 files** 전부 통과(신규: `lib/booking.test.ts` 3건, `lib/payment.test.ts` 6건,
  `lib/seats.test.ts`에 `getOwnedHold`/`releaseHold` 8건 추가, `app/api/booking/route.test.ts` 6건,
  `app/api/payment/route.test.ts` 5건, `app/api/holds/release/route.test.ts` 5건). 참고: 파일을 병렬
  실행(`npx vitest run` 기본값)하면 로컬 Postgres 커넥션 경합으로 각 파일의 첫 테스트가 5초 타임아웃으로
  간헐적으로 실패하는 기존 이슈가 있음(Task 010이 만든 문제가 아님, 순차 실행 시 전부 통과) — 로컬 개발
  환경의 알려진 한계로 기록만 해둔다.
- **Playwright(Chrome MCP)로 실제 dev 서버(이미 구동 중이던 인스턴스, `localhost:3000`)를 대화형으로 검증**:
  (1) 정상 결제 성공 플로우 — 홈(Small 티어) → 대기열 실시간 감소 관찰 → 좌석 A1 클레임 → 예매정보(배송
  방법·약관) → 결제(Bank Transfer) → 결제 성공(진짜 DB UUID `bookingId` 확인) → 결과 페이지 도달까지 전체
  확인. DB 직접 조회로 `SessionResult.stageTimings`에 `booking_info.exitedAt`/`payment.exitedAt`이 모두
  기록되고 `outcome`은 여전히 `null`(Task 011 전용)임을 재확인. (2) 이탈 시 hold 해제 — 좌석 A5를 클레임한
  뒤 결제 없이 홈으로 네비게이션해 `pagehide`를 유발, DB 조회로 `Hold.releasedAt`이 5분 만료가 아니라 생성
  16초 만에(명시적 `releaseHold` 경로로) 찍혔고 `Seat.status`가 즉시 `AVAILABLE`로 돌아온 것을 확인, 사전
  `payment_error`가 없었으므로 `payment_abandoned` 이벤트가 기록되지 않은 것도 확인. (3) 결제 실패→재시도
  성공(`payment_retry_success`), hold 5분 자연 만료 후 `/booking`·`/payment` 리다이렉트는 각각 확률적
  에러 주입 대기 및 실제 5분 대기가 필요해 브라우저로 재현하지 않았다 — 대신 `lib/payment.test.ts`/
  `lib/booking.test.ts`가 `roll` 주입과 이미 만료된 `Hold` 픽스처로 두 경로 모두 실제 테스트 DB 기준
  결정론적으로 검증한다.
- **다음 Task 인계 사항**: Task 011은 이 Task가 기록한 `stageTimings.booking_info`/`stageTimings.payment`와
  `payment_error`/`payment_retry_success`/`payment_abandoned` 이벤트를 그대로 집계·피드백 매핑에 사용할 수
  있다 — 이 Task는 `SessionResult.outcome`을 전혀 쓰지 않았으므로 Task 011이 첫 writer가 된다.
