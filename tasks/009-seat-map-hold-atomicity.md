# Task 009: 좌석맵 · 좌석 선점(hold) 원자성 API

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 009 항목 업데이트

## 개요

Phase 3 우선순위 작업(F005 좌석맵, F006 좌석 선점, F007 hold 만료, F008 경쟁 봇) — `app/api/seats/route.ts`는
현재 `501 not_implemented` 스텁이고, `app/seats/SeatsView.tsx`는 `getDummySeatMap()`(클라이언트 `Math.random()`) 더미
좌석맵을 렌더링한다. 이 Task는 이 둘을 실제 좌석맵 조회/폴링 API와 연결하고, CLAUDE.md가 명시한 원자적 좌석 선점
트랜잭션을 실제로 실행하며, 그 위에 만료 hold 해제와 경쟁 봇 선점까지 얹는다.

**범위 경계 (ROADMAP 명시):** 봇 선점 수 계산(`computeBotClaimCount`)·경과 시간 계산(`computeElapsedTime`)·만료 hold
판정(`findExpiredHolds`)은 Task 007에서 이미 순수 함수로 구현 완료됐고, `lastTickAt` 갱신 오케스트레이션(`lib/tick.ts`의
`advanceTick`)도 Task 007에서 끝났다. 이 Task는 그 산출물을 소비해 **실제 DB 트랜잭션을 실행**하는 실행 계층만
담당한다 — 좌석 선점 원자성(조건부 `UPDATE` + `Hold` insert), 봇 선점의 실제 클레임 실행, 만료 hold의 실제 해제
(`releasedAt` 기록 + `Seat.status` 되돌리기)가 여기 속한다. 예매정보·결제(F009/F010)는 Task 010의 몫이며 이
Task는 hold 확보까지만 다룬다.

**설계 결정:**

- **좌석 선점 원자성** — `lib/seats.ts`(신규) `claimSeat({ seatId, sessionId, now })`: 조건부
  `UPDATE seats SET status='held' WHERE id=$1 AND status='available' RETURNING id` → 성공 시 같은 트랜잭션에서
  `INSERT holds (seatId, sessionId, expiresAt=now+5min)` (CLAUDE.md 크리티컬 사항 그대로). 사용자 클레임(`POST /api/seats`)과
  봇 클레임이 **동일한 함수**를 호출한다 — PRD F008 "서버가 사용자와 동일한 hold 로직으로 랜덤 좌석을 선점"을 문자
  그대로 구현.
- **봇 세션 식별자** — 봇은 실제 세션이 아니므로 `sessionId = `bot:${runId}`` 같은 합성 식별자를 쓴다. `Hold.sessionId`에
  유니크 제약이 없으므로 봇이 한 run 안에서 여러 좌석을 동시에 hold해도 문제 없다. 봇 sessionId에는 `SessionResult`가
  생성되지 않도록 관측 데이터 기록 경로(아래)에서 명시적으로 제외한다.
- **만료 hold 해제** — `lib/seats.ts` `releaseExpiredHolds({ runId, now })`: 해당 run의 활성 hold(`releasedAt IS NULL`)를
  조회해 Task 007 `findExpiredHolds`에 넘기고, 만료 대상 각각에 대해 같은 트랜잭션에서 `Hold.releasedAt = now` +
  `Seat.status = AVAILABLE`을 기록한다(CLAUDE.md: 상태 변경과 hold 정리는 반드시 같은 트랜잭션). **폴링(`GET /api/seats`)마다
  봇 클레임 계산보다 먼저 실행** — 방금 풀린 좌석이 그 tick의 `availableSeatCount`(캡 계산)와 봇 클레임 대상 풀에
  포함되도록 순서를 고정한다.
- **폴링 시 tick 순서** — `GET /api/seats` 한 번의 요청 안에서: (1) `releaseExpiredHolds` → (2) 남은 available 좌석 수로
  `advanceTick`(Task 007, `lib/tick.ts`) 호출해 `claimCount` 산출 → (3) 그 수만큼 무작위 available 좌석에 대해
  `claimSeat(botSessionId, ...)`를 반복 실행(개별 클레임은 원자적이므로 동시 사용자 클레임과 경합해도 안전) → (4) 최신
  좌석 상태 전체를 조회해 응답. 이 네 단계가 이번 Task가 새로 실행하는 "tick 반영" 그 자체다.
- **클릭 즉시 클레임** (PRD F005/F006: "좌석 클릭 → 선점 성공/실패 즉시 피드백") — `SeatsView`의 좌석 클릭 핸들러가
  그 자리에서 `POST /api/seats`를 호출한다. 성공하면 선택 상태 표시 + hold 타이머 시작, 충돌(`SEAT_ALREADY_TAKEN`)이면
  "이미 선택된 좌석입니다" 배너를 띄우고 좌석맵을 즉시 재조회한다. **"좌석 선택 완료" 버튼은 이미 확보된 hold를 갖고
  `/booking`으로 이동만** 한다(재요청 없음) — 클레임은 클릭 시점에 이미 끝나 있어야 한다는 뜻.
  > **[ROADMAP D-6로 이 문단 전체가 뒤집힘]** 실제 플레이 중 봇에게 이미 선점된 좌석을 클릭했을 때 재선택이
  > 매끄럽지 않은 문제가 발견되어, 클레임 시점을 클릭에서 confirm으로 이동했다: **좌석 클릭은 순수 로컬 선택
  > 표시만** 하고(서버 요청 없음), **`POST /api/seats` 호출은 "좌석 선택 완료" 버튼(confirm)을 눌렀을 때**
  > 실행한다. confirm이 conflict를 받으면 배너 표시 + 로컬 선택 초기화 + 좌석맵 재조회로 사용자가 페이지에
  > 남아 바로 다른 좌석을 재선택할 수 있게 한다. `POST /api/seats`의 원자적 클레임 트랜잭션 자체(`lib/seats.ts`
  > `claimSeat`)는 호출 시점과 무관하게 그대로 재사용된다. 상세: `docs/ROADMAP.md`의 D-6, 구현은
  > `app/seats/SeatsView.tsx`.
- **관측 데이터 기록** — Task 008이 만든 `lib/session-result.ts` 헬퍼를 재사용하되, `contentionLosses` 증가 헬퍼가 아직
  없어 `incrementContentionLosses(db, sessionId)`를 신규 추가한다. `POST /api/seats` 충돌 시 `contention_loss` 이벤트
  기록 + `contentionLosses` 증가를 함께 실행하고, 성공 시 `seat_claim_success` 이벤트 + (해당 세션의 첫 진입이면)
  `stageTimings.seat_selection.enteredAt`을 기록한다. `hold_expired` 이벤트는 **사용자 세션의 hold가 만료될 때만**
  기록한다 — 봇 sessionId는 진짜 세션이 아니므로 `SessionResult`를 만들지 않는다(`releaseExpiredHolds`가 해제 대상의
  `sessionId`가 `bot:` 접두사인지로 판별해 건너뜀).
- **API 레벨 가드** — `GET`/`POST /api/seats` 모두 `requireSession()` + `getActiveRun()` + `requireAdmission()`(Task 008
  재사용)으로 방어한다. 페이지(`app/seats/page.tsx`)의 SSR 리다이렉트 가드가 이미 있지만, API를 직접 호출하는 우회를
  막기 위한 방어적 이중화.
- **`session-storage.ts` 확장** — `SelectedSeatStorage`에 API가 반환한 실제 `holdExpiresAt`을 추가로 저장한다. 다만
  `app/booking/BookingView.tsx`가 이 값을 실제로 읽어 쓰도록 바꾸는 것은 **Task 010 범위로 남긴다** — 지금은 값을
  나란히 저장만 해 두어 다음 Task가 재작업 없이 바로 쓸 수 있게 한다(현재 `BookingView`는 여전히
  `selectedAt + 하드코딩 5분`으로 자체 계산).

## 관련 파일

- `app/api/seats/route.ts` — `GET`(좌석맵 조회 + tick 반영) + `POST`(좌석 클레임) 핸들러 구현, `501` 스텁 제거 (수정)
- `app/api/seats/route.test.ts` — 라우트 통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/seats.ts` — `claimSeat`, `releaseExpiredHolds`, `listSeatMap`, `runSeatMapTick`(위 4단계 오케스트레이션) 등
  `lib/tick.ts`/`lib/queue.ts`와 같은 위치의 "caller" 레이어 (신규)
- `lib/seats.test.ts` — 위 함수들의 단위/동시성 통합 테스트, 실제 테스트 DB 사용 (신규)
- `lib/session-result.ts` — `incrementContentionLosses` 신규 추가 (수정)
- `lib/session-result.test.ts` — 위 추가 함수 테스트 (수정)
- `lib/simulation.ts` — 참고용(수정 없음): `computeBotClaimCount`, `findExpiredHolds`, `computeElapsedTime` 재사용
- `lib/tick.ts` — 참고용(수정 없음): `advanceTick` 재사용
- `lib/queue.ts` — 참고용(수정 없음): `requireAdmission`, `getActiveRun` 재사용
- `lib/types.ts` — 기존 `SeatSummary`/`SeatMapResponse`/`SeatClaimRequest`/`SeatClaimResponse`/`JudgmentEvent`
  (`contention_loss`/`seat_claim_success`/`hold_expired`)가 이미 정의돼 있음 — 재사용 확인, 필요 시에만 세부 조정 (수정
  여지만 있음)
- `lib/session-storage.ts` — `SelectedSeatStorage`에 `holdExpiresAt` 필드 추가 (수정)
- `app/seats/SeatsView.tsx` — `getDummySeatMap()`/클라이언트 `Math.random()` 좌석맵 제거, 2초 폴링(`GET /api/seats`) +
  클릭 즉시 클레임(`POST /api/seats`)으로 교체 (수정)
- `app/seats/SeatsPoller.tsx` 또는 동등한 클라이언트 훅 — `app/queue/QueuePoller.tsx`(Task 008)와 동일한 폴링 패턴 참고
  (신규 고려, `SeatsView.tsx` 내부에 흡수해도 무방)
- `app/seats/page.tsx` — 참고용(수정 없음 예상): 기존 `requireAdmission` 가드 그대로 유지
- `prisma/schema.prisma` — 변경 필요 여부 미확정(현재 스키마로 충분해 보임: `Hold.sessionId`에 유니크 제약 없음이 봇
  다중 hold를 이미 허용). 구현 중 필요성이 드러나면 Task 008처럼 "계획 변경"으로 기록

## 선행 조건

- Task 007 (`computeBotClaimCount`, `findExpiredHolds`, `computeElapsedTime`, `advanceTick`)
- Task 008 (`requireAdmission`, `getActiveRun`, `lib/session-result.ts` 헬퍼)

## 수락 기준

- [x] `POST /api/seats`: `AVAILABLE` 좌석 클레임 성공 시 `Seat.status → HELD` + `Hold`(만료 5분) 생성이 같은 트랜잭션에서 원자적으로 일어남
- [x] `POST /api/seats`: 이미 `HELD`/`SOLD`인 좌석 클레임 시 `{status:'conflict', code:'SEAT_ALREADY_TAKEN'}` 반환, DB 상태 변경 없음
- [x] **동시성**: 동일 좌석에 대한 병렬 클레임 요청 중 정확히 1건만 성공 (실제 테스트 DB로 검증, 모킹 금지)
- [x] `GET /api/seats`: 폴링마다 만료된 hold가 실제로 해제됨(`releasedAt` 기록 + `Seat.status → AVAILABLE`)
- [x] `GET /api/seats`: `advanceTick`이 산출한 `claimCount`만큼 봇이 실제로 available 좌석을 클레임함(같은 `claimSeat` 함수 재사용 확인)
- [x] 봇 클레임과 사용자 클레임이 동시에 같은 좌석을 노려도 정확히 1건만 성공(경합 시나리오)
- [x] 사용자 클레임 성공/충돌 시 각각 `seat_claim_success`/`contention_loss` 이벤트가 `SessionResult.events`에 기록되고,
      충돌 시 `contentionLosses`가 1 증가함
- [x] 봇 hold가 만료돼도 `SessionResult`가 생성되지 않음(봇 sessionId는 관측 데이터 기록에서 제외)
- [x] 사용자 세션의 hold가 만료되면 `hold_expired` 이벤트가 기록됨
- [x] `GET`/`POST /api/seats` 모두 미인증/미입장(`requireAdmission` 실패) 요청을 거부함
- [x] `app/seats/SeatsView.tsx`가 더미 데이터 대신 실 API로 좌석맵을 2초 간격 폴링하고, 좌석 클릭 시 즉시 클레임
      요청을 보냄
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `lib/session-result.ts`: `incrementContentionLosses(db, sessionId)` 추가 — 기존 `recordJudgmentEvent`와 동일한
      `getOrCreate` 패턴 재사용
2. [x] `lib/seats.ts`: `claimSeat({ seatId, sessionId, now })` — 조건부 `UPDATE ... RETURNING id` + `Hold` insert를 하나의
      트랜잭션으로 묶음, 결과를 `SeatClaimResponse` 형태로 반환
3. [x] `lib/seats.ts`: `releaseExpiredHolds({ runId, now })` — 해당 run의 활성 hold 조회 → `findExpiredHolds`(Task 007)에
      위임 → 만료 대상마다 `releasedAt` 기록 + `Seat.status → AVAILABLE`을 한 트랜잭션으로 실행, 사용자 세션 hold만
      `hold_expired` 이벤트 기록(봇 sessionId 제외)
4. [x] `lib/seats.ts`: `listSeatMap({ runId })` — run의 전체 좌석(≈200석) 조회, `SeatSummary[]`로 매핑
5. [x] `lib/seats.ts`: `runSeatMapTick({ runId, now })` — `releaseExpiredHolds` → 남은 available 수로 `advanceTick`(Task 007
      `lib/tick.ts`) 호출 → `claimCount`만큼 무작위 available 좌석에 `claimSeat(botSessionId, ...)` 반복 실행 → 이 네 단계를
      하나로 묶는 진입점
6. [x] `app/api/seats/route.ts`: `GET` 핸들러 — `requireSession` + `getActiveRun` + `requireAdmission` 가드 →
      `runSeatMapTick` 실행 → `listSeatMap` 결과 반환, `501` 스텁 제거
7. [x] `app/api/seats/route.ts`: `POST` 핸들러 — 동일 가드 → `SeatClaimRequest` 파싱 → `claimSeat(사용자 sessionId, ...)` →
      성공/충돌에 따라 `seat_claim_success`/`contention_loss` 이벤트 기록 + `incrementContentionLosses` 호출(충돌 시) +
      `stageTimings.seat_selection.enteredAt` 최초 기록
8. [x] `lib/session-storage.ts`: `SelectedSeatStorage`에 `holdExpiresAt` 필드 추가, `saveSelectedSeat` 시그니처 조정
9. [x] `app/seats/SeatsView.tsx`: `getDummySeatMap()` 제거, 2초 간격 `GET /api/seats` 폴링 도입(`app/queue/QueuePoller.tsx`
      패턴 참고), 좌석 클릭 시 `POST /api/seats` 즉시 호출 → 성공 시 hold 타이머 시작 + 선택 표시, 충돌 시 경고 배너 +
      즉시 재조회
10. [x] "좌석 선택 완료" 버튼: 재요청 없이 이미 확보된 hold 정보로 `/booking`(+`holdExpiresAt` 포함)으로 이동하도록 정리
11. [x] 타입 체크·린트 통과 확인
12. [x] Vitest 단위/통합 테스트 작성 (아래 테스트 체크리스트 참조)
13. [x] Playwright MCP로 실제 dev 서버를 구동해 E2E 플로우 검증 (Task 006~008과 동일하게 대화형 검증만 수행, 커밋되는
      자동화 테스트는 Vitest만 유지)

## 테스트 체크리스트

### 단위 테스트 (Vitest)

- [x] `claimSeat`: `AVAILABLE` 좌석 클레임 성공 시 `Seat.status`/`Hold` 동시 반영
- [x] `claimSeat`: `HELD`/`SOLD` 좌석 클레임 시 conflict 반환, 부작용 없음
- [x] `releaseExpiredHolds`: 만료 hold만 정확히 골라 해제(미만료 hold는 그대로 유지)
- [x] `releaseExpiredHolds`: 사용자 세션 hold 만료 시 `hold_expired` 이벤트 기록, 봇 hold 만료 시 이벤트 미기록(`SessionResult`
      미생성) 검증
- [x] `runSeatMapTick`: `advanceTick`이 반환한 `claimCount`만큼 실제 클레임이 실행됨, available 좌석보다 많은 요청이 캡에
      걸림
- [x] `incrementContentionLosses`: 호출마다 1씩 누적, 기존 이벤트 배열을 덮어쓰지 않음

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] **동시성 핵심**: 동일 좌석에 대한 병렬 `claimSeat` 호출 중 정확히 1건 성공 (CLAUDE.md 크리티컬 요구사항)
- [x] **봇-사용자 경합**: 봇 클레임과 사용자 클레임이 동시에 같은 좌석을 노릴 때도 정확히 1건만 성공
- [x] `GET /api/seats` → `POST /api/seats` 전체 흐름이 실제 DB 상태와 일치
- [x] 만료된 hold의 좌석이 다음 클레임 요청에서 실제로 재선점 가능함
- [x] 세션 미검증/미입장(`requireAdmission` 실패) 요청이 거부됨

### E2E 검증 (Playwright MCP, 실제 dev 서버 대화형 구동 — Task 006/007/008과 동일하게 커밋되는 스펙 파일 없음)

- [x] ~~좌석 클릭 → 즉시 선점 성공 피드백(hold 타이머 시작) 확인~~ → **ROADMAP D-6 반영, 재작성**: 좌석 클릭은
      네트워크 요청 없이 로컬 선택 표시만 되는지 확인
- [x] ~~이미 선점된 좌석(다른 세션/봇) 클릭 시 "이미 선택된 좌석입니다" 충돌 피드백 + 좌석맵 즉시 갱신 확인~~ →
      **재작성**: "좌석 선택 완료" confirm 시 이미 선점된 좌석이면 충돌 피드백 + 로컬 선택 초기화 + 좌석맵 즉시
      갱신 + 재선택 가능 확인 (자동화 테스트: `app/seats/SeatsView.test.tsx`)
- [x] 봇이 실시간으로(2초 폴링 사이) 좌석을 가져가는 것을 좌석맵 갱신으로 관찰
- [x] ~~"좌석 선택 완료" 버튼 클릭 시 재요청 없이 `/booking`으로 이동~~ → **재작성**: "좌석 선택 완료" 버튼 클릭
      시에만 `POST /api/seats`가 나가고, 선점 성공 시 `/booking`으로 이동하는 것 확인
- [x] hold 5분 만료 후(또는 짧은 만료값으로 재현) 좌석이 다시 `AVAILABLE`로 돌아오는 것 확인

## 변경 사항 요약

- **`lib/seats.ts` 신규 — 계획에 없던 `seatBelongsToRun` 추가**: `claimSeat`는 seatId만으로 원자적 클레임을 수행하고 어느 run 소속인지는 검사하지 않는다. API 라우트가 이 검사 없이 그대로 연결하면, 한 세션이 다른 세션의 독립 `SimulationRun`(D-1) 소속 좌석 id를 알아내 클레임할 수 있는 구멍이 생긴다는 걸 구현 중 발견해 추가했다. `Seat.simulationRunId`는 생성 후 절대 바뀌지 않는 값이라 레이스 걱정 없이 단순 조회로 막을 수 있어, `POST /api/seats`가 `claimSeat` 호출 전에 이 검사를 거치도록 했다.
- **좌석 선점 원자성은 raw SQL 대신 Prisma `updateMany`로 구현**: `tx.seat.updateMany({ where: { id, status: AVAILABLE }, data: { status: HELD } })`는 CLAUDE.md가 예시로 든 raw `UPDATE ... RETURNING`과 동일한 원자성(단일 UPDATE 문, Postgres 행 잠금으로 동시 요청 직렬화)을 raw query 없이 얻는다. `updated.count`로 성공/충돌을 판별한다.
- **`incrementContentionLosses`는 read-then-write가 아니라 Prisma `{ increment: 1 }`로 구현**: 처음엔 `row.contentionLosses + 1`을 읽어서 쓰는 방식으로 짰다가, 동시 손실이 발생하면 lost-update 레이스가 생길 수 있음을 깨닫고 원자적 `UPDATE ... SET x = x + 1`로 바꿨다.
- **`seat_selection` stageTiming의 트리거 지점을 작업 문서 초안에서 변경**: 원래 "성공 클레임 시에만 `enteredAt` 기록"으로 적었으나, 구현하면서 좌석 선택 스테이지 "진입"은 클레임 성공 여부와 무관하게 좌석맵을 처음 보는 순간(`GET`)이 맞다고 판단해 `enteredAt`은 `GET`에서, `exitedAt`은 클레임 성공(`POST`) 시로 나눴다. `recordStageEntered`가 이미 idempotent라 2초 폴링마다 불러도 문제없다. 이 변경은 `docs/ROADMAP.md`에 **D-3**로 별도 기록했다 — 이 구간에 경합 재시도 시간이 포함되므로 Task 011의 "빠를수록 좋음" 평가 로직에서 감안해야 한다.
- **좌석 클레임 충돌은 HTTP 에러가 아니라 200 + `SeatClaimResponse` 유니온의 `status: "conflict"`로 응답**: "이미 선택된 좌석"은 정상적으로 발생하는 시뮬레이션 상황이지 서버 에러가 아니기 때문이다.
- **언어 규칙 위반을 구현 중 발견해 수정**: `claimSeat`의 충돌 메시지를 처음엔 한국어(`"이미 선택된 좌석입니다"`)로 넣었는데, UI로 노출될 수 있는 문자열이라 CLAUDE.md의 "모든 UI 노출 텍스트는 영어" 규칙 위반이었다. `"This seat has already been taken."`로 수정했다.
- **`lib/session-storage.ts`의 `SelectedSeatStorage`에 실제 `holdExpiresAt` 추가**: `app/booking/BookingView.tsx`가 이 값을 실제로 읽어 쓰도록 바꾸는 것은 계획대로 **Task 010 범위로 남겨뒀다** — 지금은 값을 나란히 저장만 해 두어 다음 Task가 재작업 없이 바로 쓸 수 있게 했다(`BookingView`는 여전히 `selectedAt + 하드코딩 5분`으로 자체 계산 중).
- **검증**: `npx tsc --noEmit`, `npm run lint` 모두 통과. `npx vitest run` **96 tests / 10 files** 전부 통과(`lib/seats.test.ts` 16건 — 동시성·봇-유저 경합 케이스 포함, `app/api/seats/route.test.ts` 11건 — 가드/충돌/이벤트 기록 검증 포함, `lib/session-result.test.ts`에 `incrementContentionLosses` 2건 추가, 기존 파일들). 동시성 테스트는 5회 연속 재실행해도 안정적으로 통과함을 확인. Playwright(Chrome MCP)로 실제 dev 서버를 구동해 홈 → 세션 시작 → 대기열 → 좌석 페이지 전체 플로우를 검증: 좌석 클릭 즉시 클레임 + hold 타이머, 봇이 실시간으로 좌석을 가져가는 것(DB 조회로 `bot:{runId}` 세션의 지속적 클레임 확인), "완료" 버튼이 재요청 없이 `/booking`으로 이동(네트워크 로그로 추가 POST 없음 확인), hold 만료 후 좌석이 실제로 `AVAILABLE`로 복귀, `SessionResult`에 각 이벤트·`contentionLosses`가 정확히 기록되는 것을 DB 조회로 확인. 다만 "충돌 배너"가 뜨는 정확한 순간을 물리적 클릭으로 재현하는 데는 실패했다 — 2초 폴링이 매우 안정적으로 빠르게 동작해서 좌석을 가로챈 뒤 클릭하기 전에 매번 폴링이 먼저 상태를 반영해버렸다(4회 시도, 매번 폴링이 이김). 대신 실제 브라우저 세션 쿠키로 `POST /api/seats`를 직접 호출해 서버가 실제로 conflict를 반환하는 것은 라이브로 확인했고, 클라이언트의 배너 렌더링 자체는 자동화 테스트(DB 검증 포함)로 커버된다.
- **다음 Task 인계 사항**: (1) Task 010은 `lib/session-storage.ts`의 `holdExpiresAt`을 바로 읽어 `BookingView`/`PaymentView`의 하드코딩된 5분 타이머 계산을 서버 발급 값으로 교체할 수 있다. (2) `lib/seats.ts`의 `claimSeat`/`seatBelongsToRun`은 Task 010의 결제 성공 트랜잭션(`Seat.status → SOLD` + `Booking` 생성)에서도 그대로 재사용 가능한 패턴이다. (3) D-3(ROADMAP)에 기록된 `seat_selection` 구간의 의미(경합 재시도 시간 포함)를 Task 011 피드백 로직 설계 시 참고할 것.

## 후속 변경 — ROADMAP D-6 (Phase 3 진행 중, Task 009 완료 후 반영)

실제 플레이 중 봇에게 이미 선점된 좌석을 클릭했을 때 재선택이 매끄럽지 않은 문제가 발견되어,
위 "클릭 즉시 클레임" 설계를 뒤집었다. 상세 결정 내용은 `docs/ROADMAP.md`의 D-6 참고.

- **`app/seats/SeatsView.tsx`**: `handleSeatClick`에서 `POST /api/seats` 호출을 제거하고 순수 로컬
  `setSelection({ seatId })`만 남김. `handleConfirm`을 async로 바꿔 `POST /api/seats` 호출 +
  성공/충돌 처리(성공 → `saveSelectedSeat` + `/booking` 이동, 충돌 → 배너 + 로컬 선택 초기화 +
  좌석맵 재조회)를 여기로 이동. `Selection` 타입에서 `holdExpiresAt` 제거(confirm 이전엔 실제
  hold가 없음), 좌석맵 화면의 `HoldTimer` 블록도 제거(실제 hold는 confirm 성공 즉시 `/booking`
  으로 넘어가므로 이 페이지에 카운트다운이 있을 이유가 없음).
- **API/트랜잭션 레이어(`app/api/seats/route.ts`, `lib/seats.ts`)는 변경 없음** — `POST
  /api/seats`의 원자적 클레임(`claimSeat`)은 호출 시점과 무관하게 이미 올바르게 설계돼 있었다.
- **신규 자동화 테스트**: 그동안 이 프로젝트에 없었던 컴포넌트 테스트 인프라(`@testing-library/react`,
  `@testing-library/user-event`, `@testing-library/jest-dom`)를 devDependency로 추가하고
  `app/seats/SeatsView.test.tsx`를 신규 작성 — 이번 D-6의 동기가 된 버그 시나리오(좌석 클릭은
  로컬 전용, confirm 시 conflict를 받으면 로컬 선택이 초기화되어 즉시 다른 좌석을 재선택할 수
  있음)를 직접 검증한다. `fetch`/`next/navigation`의 `useRouter`를 모킹해 클릭 시점에 어떤
  네트워크 요청도 나가지 않음을 확인하고, confirm 충돌 후 재선택·재confirm까지 전체 흐름을
  한 테스트로 검증한다.
- **검증**: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`(97 tests / 11 files, 기존 96건 +
  신규 컴포넌트 테스트 1건) 모두 통과.
