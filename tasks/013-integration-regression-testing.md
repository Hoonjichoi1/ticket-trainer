# Task 011-1: 핵심 기능 통합 테스트

> 파일명은 `013-`으로 시작하지만 ROADMAP.md 기준으로는 **Task 011-1**이다. `011-` 번호는 이미
> `tasks/011-queue-arrival-rate-position.md`(D-4 post-hoc 수정 문서)가 선점하고 있어, 새 충돌을
> 만들지 않기 위해 `tasks/012-result-report-feedback.md`가 그랬던 것과 동일한 선례를 따라 `tasks/`
> 디렉토리의 다음 순번(013)을 파일명으로 쓰고 제목만 ROADMAP과 일치시켰다.

## 상태

- [ ] 진행 중
- [ ] 완료 — See: `docs/ROADMAP.md` Task 011-1 항목 업데이트

## 개요

Phase 3 기능 작업(Task 006~011)이 모두 완료되어 MVP 핵심 플로우(세션 → 대기열 → 토큰 → 좌석 →
예매정보 → 결제 → 결과)가 갖춰졌다. 이 Task는 **새 기능 구현이 아니라**, 지금까지 개별 Task 단위로
검증된 것들을 전체 플로우 관점에서 다시 훑는 종합 E2E 회귀 테스트다 — 티어 간 상호작용, 동시성,
관측 데이터 정합성처럼 개별 Task 리뷰로는 못 잡는 문제를 찾아내는 것이 목적.

**범위 (ROADMAP.md 원문)**:
- 종합 E2E 테스트(Playwright MCP): 전체 플로우 티어별(소/중/메가) 검증, 봇·사용자 좌석 경합 실동작 +
  tick 엔진 결정론 통합 검증(`lastTickAt` 이중 전진 없음 포함), 동시성/경쟁 조건 테스트(다중 세션
  동일 좌석 경합)
- 에러 핸들링·엣지 케이스: 오픈 전 대기열 진입, 토큰 없이 좌석 접근, 만료 hold로 결제, 결제 에러
  주입 후 각 분기, 세션 만료, Neon pooled connection 부하 시 동작
- 관측 데이터 정합성 검증: 리포트의 타이밍·패배 횟수·이벤트가 실제 플로우 행동과 일치하는지 대조
- 테스트 결과 보고 및 버그 리스트 작성 → 수정 → 재테스트

**진행 원칙(사용자 확정)**: 이 Task 진행 중 이미 병합된 Task(006~011) 코드를 고쳐야 하는 버그가
발견되면 **즉시 고치지 않는다**. ROADMAP D-log 포맷(D-4~D-10 선례)으로 먼저 보고하고, 승인 후에만
수정 → 회귀 테스트 → ROADMAP D-11(이후 순번) 기록 순으로 진행한다.

**사전 확정 사항**:
- **Neon pooled connection 부하 테스트**: 로컬 dev 환경(`lib/test-db.ts`)이 로컬 Postgres를 쓰고
  있어 실제 Neon 풀링 브랜치가 연결돼 있지 않다 → **보류 + 문서화**(아래 "변경 사항 요약"의 deferred
  항목 참조). 이번 Task에서는 실행하지 않는다.
- **커버리지 갭 발견 시**: 기존 Vitest 스위트(19개 파일, 178 tests)에 없는 것이 발견되면 새
  디렉토리·헬퍼를 만들지 않고 관련 기존 `*.test.ts` 파일에 케이스를 추가한다(기존 코드 컨벤션 재사용).

## 관련 파일

이 Task는 원칙적으로 신규 파일을 만들지 않는다 — Task 006~011이 만든 기존 코드를 대상으로 검증만
수행한다. 아래는 검증 대상이며, 갭이 발견될 경우에 한해 `(수정)` 표시된 파일에 케이스가 추가될 수
있다.

- `lib/tick.ts`, `lib/simulation.ts` — tick 엔진 결정론(`lastTickAt` 이중 전진 없음) 검증 대상
- `lib/seats.ts`, `lib/queue.ts`, `lib/booking.ts`, `lib/payment.ts`, `lib/result.ts`,
  `lib/session.ts`, `lib/session-result.ts` — 봇/사용자 경합, hold 만료, 에러 주입, 결과 집계,
  세션 가드 로직 검증 대상
- `app/api/*/route.ts` (session, queue, seats, booking, payment, holds/release, result,
  dev/timewarp) — 라우트 레벨 통합 검증 대상
- `app/api/seats/route.test.ts` — (잠정, 수정) 갭 발견 시 HTTP 라우트 레벨 다중 세션 동일 좌석 경합
  케이스 추가 후보
- 세션 만료(`SESSION_MISSING`/`SESSION_INVALID`) 관련 라우트 테스트 — (잠정, 수정) 갭 발견 시 케이스
  추가 후보
- `docs/ROADMAP.md` — Task 011-1 완료 표시, 신규 발견 버그의 D-11 이후 항목 기록
- `tasks/013-integration-regression-testing.md` — 이 문서 자체

## 선행 조건

- Task 006~011 전부 완료(이미 충족)
- ROADMAP D-10 사후 기록 완료(이 Task 착수 전 선행 처리 — `docs/ROADMAP.md` 참조)

## 수락 기준

- [ ] 전체 플로우(홈 티어 선택 → 대기열 → 토큰 → 구역 선택 → 좌석 선점 → 예매정보 → 결제 → 결과 →
      다시 도전)가 소/중/메가 3개 티어 모두에서 정상 동작 확인
- [ ] 봇·사용자 좌석 경합이 실제로 관찰되고, tick 엔진이 결정론적으로 동작함(`lastTickAt` 이중 전진
      없음) 확인
- [ ] 동시성/경쟁 조건(다중 세션 동일 좌석 경합) 테스트 통과 — 정확히 한쪽만 성공
- [ ] 에러 핸들링·엣지 케이스 6항목(오픈 전 대기열 진입/토큰 없이 좌석 접근/만료 hold로 결제/결제
      에러 각 분기/세션 만료/Neon 풀링 부하) 각각 검증 또는 (Neon 풀링 부하는) 보류 사유 문서화
- [ ] 결과 리포트의 타이밍·패배 횟수·이벤트가 실제 수행한 조작과 일치함을 확인
- [ ] 테스트 중 발견된 버그는 전부 목록화되고, 병합된 코드 수정이 필요한 건은 사용자 승인 후에만
      반영·재테스트됨
- [ ] 타입 체크·린트·Vitest 전체 스위트 통과

## 구현 단계

1. [x] 커버리지 갭 조사 — ROADMAP 5개 대분류를 기존 `*.test.ts`와 대조해 "이미 커버됨" vs "코드로
      한 번도 검증 안 됨" 표로 정리 (결과: 아래 테스트 체크리스트 참조)
2. [x] 발견된 갭에 대해서만 기존 관련 `route.test.ts`/`lib/*.test.ts` 파일에 신규 Vitest 케이스 추가
      — 조사 결과 신규 케이스 없음(라우트 레벨 다중 세션 경합은 모킹 구조상 의미 있게 구현 불가로
      판단, 이유는 테스트 체크리스트 참조)
3. [x] `npx vitest run --fileParallelism=false`로 기존 전체 테스트 green 확인(베이스라인) —
      178/178 통과. `npx tsc --noEmit`, `npm run lint`도 통과
4. [ ] 로컬 dev 서버 기동 + Playwright MCP로 전체 플로우 × 3티어 라이브 검증
5. [ ] Playwright MCP로 봇·사용자 경합, 동시성, 에러/엣지 케이스 시나리오 순서대로 라이브 검증
      (`/api/dev/timewarp`로 가속)
6. [ ] 각 시나리오 진행마다 결과 리포트의 관측 데이터(stageTimings/contentionLosses/events)를 실제
      조작과 대조
7. [ ] 버그 발견 시 즉시 중단 → 사용자에게 D-log 포맷으로 보고 → 승인 대기
8. [ ] 승인된 수정 사항 반영 → 회귀 테스트 추가 → `docs/ROADMAP.md`에 D-11(이후 순번) 기록 →
      원인 Task 파일에 후속 변경 절 추가(또는 신규 task 파일, 규모에 따라 판단) → 재테스트
9. [ ] 타입 체크·린트 통과 확인
10. [ ] "변경 사항 요약" 작성(CLAUDE.md "Task 완료 보고 규격" 4항목 형식) + ROADMAP.md Task 011-1
       줄에 ✅ 표시

## 테스트 체크리스트

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

**갭 조사 결론: 신규 Vitest 케이스 없음.** 기존 178개 테스트(19개 파일)를 ROADMAP 5개 대분류와
대조한 결과:

- [x] 봇·사용자 경합 + tick 직렬화(`lastTickAt` 이중 전진 없음): `lib/seats.test.ts`
      ("bot-vs-user contention..."), `lib/tick.test.ts`("serializes concurrent ticks...")에서
      이미 커버
- [x] 대기열 토큰 이중 발급 방지: `lib/queue.test.ts:212`에서 이미 커버
- [x] 오픈 전 대기열 진입(`SALE_NOT_OPEN`): `lib/queue.test.ts`, `app/api/queue/route.test.ts`에서
      이미 커버
- [x] 토큰 없이 좌석 접근(`NOT_ADMITTED`): `app/api/seats/route.test.ts`에서 이미 커버
- [x] 만료 hold로 결제(`hold_expired`): `lib/payment.test.ts`, `app/api/payment/route.test.ts`에서
      이미 커버
- [x] 결제 에러 주입 후 각 분기(`timeout`/`server_error`/`payment_retry_success`/정상 성공):
      `lib/payment.test.ts`에서 이미 커버
- [x] 세션 만료(`SESSION_MISSING`/`SESSION_INVALID`): `lib/session.test.ts`에서 두 분기 모두 커버.
      모든 라우트가 `requireSession()`의 에러를 그대로 pass-through하므로(`app/api/seats/route.ts`
      확인, 코드별 분기 없음) 라우트별 재검증은 커버리지 증가 없는 중복 — 실질 갭 아님으로 판단
- [x] **다중 세션 동일 좌석 경합(HTTP 라우트 레벨) — 의도적으로 신규 테스트 추가 안 함**: 모든
      `route.test.ts`가 `next/headers`의 `cookies()`를 단일 공유 Map으로 모킹하는 구조라, 서로 다른
      세션 쿠키를 가진 두 요청의 진짜 동시성을 라우트 핸들러 레벨에서 흉내낼 방법이 없음(실제
      Next.js는 요청별 격리, 모킹은 아님). `lib/seats.test.ts`가 이미 `claimSeat()` 함수 레벨에서
      이 경합을 정확히 검증하고, 라우트는 그 위에 순차적 가드(`requireSession`/`requireAdmission`)만
      얹는 얇은 레이어라 억지 테스트의 실익이 없음 — 대신 아래 E2E 섹션에서 실제 브라우저 두 세션으로
      라이브 검증(원래 ROADMAP도 이 항목을 Playwright MCP 카테고리에 배치)

### E2E 검증 (Playwright MCP, 실제 dev 서버 대화형 구동 — Task 006~012와 동일하게 커밋되는 스펙
파일 없음)

- [ ] 전체 플로우 × 3티어(SMALL → MEDIUM → MEGA): 홈 → 대기열 → 토큰 → 구역 → 좌석 선점(confirm)
      → 예매정보 → 결제(정상 성공) → 결과 → 다시 도전, 매 단계 관측 데이터 대조
- [ ] 봇·사용자 좌석 경합 라이브 관찰(MEGA 티어, timewarp로 가속) + `contention_loss` 리포트 반영
      확인
- [ ] 동시성 — 다중 세션 동일 좌석 경합 UI 레벨 보조 확인
- [x] 오픈 전 대기열 진입 시도 → 403 — D-11 수정 후 재검증(Playwright, `/api/dev/timewarp`로 `Concert.openAt`을 미래로 이동): 홈페이지가 실제 `openAt` 기준 "Sale opens in 00:59:53"을 표시했고, `POST /api/queue`도 403 `SALE_NOT_OPEN`으로 정확히 거부됨. 재검증 중 발견된 `QueuePoller` 별개 버그는 사용자 승인 후 D-12로 수정 완료 — 아래 "변경 사항 요약" 참조
- [ ] 토큰 없이 `/seats` 직접 접근 → 리다이렉트/403
- [ ] 만료된 hold로 결제 시도(timewarp) → `hold_expired` → `/result`(D-9) 도달
- [ ] 결제 에러 → 재시도 성공(`payment_retry_success`) / 결제 에러 → 이탈(`payment_abandoned`)
      각각 리포트 반영 확인
- [ ] 세션 만료(쿠키 무효/삭제) → `SESSION_MISSING`/`SESSION_INVALID` 확인
- [ ] Neon pooled connection 부하 — **스킵** (보류 사유는 아래 "변경 사항 요약" 참조)
- [ ] 관측 데이터 정합성 종합 대조(전체 시나리오에 걸쳐 리포트와 실제 조작 간 불일치 없는지 최종 점검)

## 변경 사항 요약

> 작업 완료 후 작성.

**진행 중 발견 → 승인 후 수정 완료**: D-11 재검증 중 `app/queue/QueuePoller.tsx`에서 별개의 버그 발견 — 첫 `POST /api/queue`가 `SALE_NOT_OPEN`(403)으로 실패해도 `hasJoinedRef.current`가 무조건 `true`로 세팅되어, 2초 뒤 재시도가 `GET`으로 바뀌고 그 `GET`은 큐 엔트리가 없어 404(`Not currently in the queue. Call POST /api/queue first.`)를 반환한다. 그 결과 화면 메시지가 올바른 "Ticket sale has not opened yet."에서 잘못된 메시지로 덮어써진다. 이 Task의 진행 원칙(발견 시 즉시 고치지 않고 D-log 포맷으로 보고 후 승인 대기)에 따라 보고 후 사용자 승인을 받아 D-12로 수정·회귀 테스트 추가 완료 — 자세한 내용은 `docs/ROADMAP.md` D-12 참조.
