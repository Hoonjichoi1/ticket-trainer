# Task 007: tick-on-request 시뮬레이션 엔진 구현

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 007 항목 업데이트

## 개요

Phase 3 우선순위 작업(F007, F008 계산 코어) — 대기열 순번 감소(F003)·hold 만료(F007)·경쟁 봇 선점(F008)·결제 실패 주입(F009)이 모두 의존하는
tick-on-request 결정론적 시뮬레이션 엔진의 **순수 계산 로직**을 구현한다. `lib/simulation.ts`에는 Task 003에서 만든 스켈레톤이 이미 있으며,
`computeElapsedTime`은 구현되어 있고 `computeBotClaimCount`/`computeQueuePosition`/`findExpiredHolds` 3개 함수는 `throw`로 막혀 있다 — 이번 Task는 이 3개 함수의 실제 계산 로직을 채운다.

**범위 경계 (순환 의존 방지, ROADMAP 명시):** 이 Task는 "봇이 이번 tick에 몇 석을 선점해야 하는가" 같은 **수를 산출**하는 것까지만 담당한다.
실제 좌석 선점 트랜잭션(`UPDATE seats ... RETURNING` + `INSERT holds`) 실행은 Task 009에서 연결된다. 다만 `SimulationRun.lastTickAt`을
DB에서 읽고 경과 시간을 계산한 뒤 원자적으로 갱신하는 오케스트레이션(순수 계산 함수를 호출하는 "caller")은 이 Task의 산출물이다 —
`lib/simulation.ts` 파일 상단 주석에 "Reading/persisting `lastTickAt` is the caller's job"이라 명시된 그 caller를 이 Task에서 만든다.

## 관련 파일

- `lib/simulation.ts` — 순수 계산 함수 3종(`computeBotClaimCount`, `computeQueuePosition`, `findExpiredHolds`) 구현체로 교체 (수정, 시그니처/주석의 TODO 계약 그대로 따름)
- `lib/simulation.test.ts` — 순수 함수 단위 테스트, DB 불필요 (신규)
- `lib/tick.ts` — `SimulationRun.lastTickAt`을 원자적으로 읽고 갱신한 뒤 `lib/simulation.ts`의 순수 함수를 호출하는 오케스트레이터 (신규) — 동시 tick 요청의 이중 전진 방지가 핵심 책임
- `lib/tick.test.ts` — `lib/tick.ts` 통합 테스트, 실제 테스트 DB 사용 (신규, 동시성 케이스 포함)
- `prisma/schema.prisma` — 참고용(수정 없음): `SimulationRun.lastTickAt`, `SimulationConfig`(botIntensity, admissionRatePerSec), `QueueEntry.joinedAt`, `Hold.expiresAt` 필드 확인
- `lib/types.ts` — 참고용(수정 없음): `Tier`, `QueueEntryStatus` 등 기존 타입 재사용

## 선행 조건

- Task 002 (스키마: `SimulationRun.lastTickAt`, `SimulationConfig`, `Hold`, `QueueEntry`)
- Task 003 (`lib/simulation.ts` 스켈레톤 — 함수 시그니처·순수성 계약 확정)
- Task 006 (세션·`SimulationRun` 생성 — tick 대상 인스턴스가 존재해야 함)

## 수락 기준

- [x] `computeBotClaimCount`가 `floor(botIntensity * elapsed.seconds)`를 `availableSeatCount`로 상한 클램프해 반환
- [x] `computeQueuePosition`이 `max(0, initialPosition - admissionRatePerSec * elapsed.seconds)`를 반환하고, 0 도달 시 `admitted: true`
- [x] `findExpiredHolds`가 `expiresAt < now`인 hold만 필터링해 반환 (DB 쓰기 없음)
- [x] `lib/tick.ts`의 오케스트레이터가 `SimulationRun.lastTickAt`을 읽어 경과 시간을 계산하고, 같은 트랜잭션 내에서 `lastTickAt`을 갱신 (단, 단순히 `now`로 덮어쓰지 않고 실제 claim된 좌석 수에 해당하는 시간만큼만 전진 — 아래 변경 사항 요약 참조)
- [x] 동시에 들어온 두 tick 요청이 같은 경과 시간 구간을 중복 계산해 `lastTickAt`을 이중 전진시키지 않음 (레이스 컨디션 방지)
- [x] 티어별 `SimulationConfig` 계수(botIntensity, admissionRatePerSec 등)는 `SimulationRun.tier`로 조회한 값을 사용
- [x] 동일 입력(같은 `since`/`now`/설정값)으로 반복 호출 시 항상 동일 출력 (결정론 assert 가능)
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `lib/simulation.ts`: `computeBotClaimCount` 구현 — `Math.floor(botIntensity * elapsed.seconds)`를 `availableSeatCount`로 클램프
2. [x] `lib/simulation.ts`: `computeQueuePosition` 구현 — 감소 계산 + `admitted` 플래그
3. [x] `lib/simulation.ts`: `findExpiredHolds` 구현 — `expiresAt < now` 필터
4. [x] `lib/simulation.ts` 파일 상단 주석의 "TODO"/"not implemented" 표기 제거, 순수성 계약 설명은 유지
5. [x] `lib/tick.ts`: `SimulationRun` 조회 + `lastTickAt` 원자적 갱신 쿼리 설계 — 동시 요청 레이스를 막는 방식 결정(예: `SELECT ... FOR UPDATE` 후 `UPDATE`를 하나의 트랜잭션으로 묶거나, CTE로 이전 값을 캡처하며 동시에 갱신하는 단일 원자적 쿼리) 및 근거를 변경 사항 요약에 기록
6. [x] `lib/tick.ts`: 조회한 `SimulationRun.tier`로 `SimulationConfig`를 조회해 `computeBotClaimCount`/`computeQueuePosition` 입력으로 전달
7. [x] `lib/tick.ts`: 오케스트레이터의 반환 타입 정의 — 봇 선점 수, 만료 대상 hold 목록 등 Task 008/009가 그대로 소비할 수 있는 형태로 설계
8. [x] 타입 체크·린트 통과 확인
9. [x] Vitest 단위 테스트 작성 (아래 테스트 체크리스트 참조)
10. [x] `lastTickAt` 동시성 통합 테스트 작성 및 실행 (실제 테스트 DB)

## 테스트 체크리스트

### 단위 테스트 (Vitest)

- [x] `computeBotClaimCount`: 경과 시간별 봇 선점 좌석 수 계산 (0초, 일반 구간)
- [x] `computeBotClaimCount`: 남은 좌석 부족 시 `availableSeatCount`로 상한 클램프
- [x] `computeBotClaimCount`: `botIntensity` 0 / 매우 큰 값 엣지 케이스
- [x] `computeQueuePosition`: 정상 감소 계산, 0 미만으로 내려가지 않음, `admitted` 플래그 정확성
- [x] `findExpiredHolds`: `expiresAt < now`인 hold만 필터링되고 나머지는 제외됨
- [x] `findExpiredHolds`: 빈 입력, 전부 만료, 전부 미만료 케이스
- [x] 결정론: 동일 입력 반복 호출 시 동일 출력 assert (3개 함수 모두)

### 통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `lib/tick.ts` 오케스트레이터가 `SimulationRun.lastTickAt`을 정확히 읽고 갱신함
- [x] **동시성**: 동일 `SimulationRun`에 대해 병렬로 tick 요청을 보내도 `lastTickAt`이 경과 시간만큼만 한 번 전진하고 이중 계산되지 않음 (봇 선점 수가 중복 산정되지 않는지 검증)
- [x] 티어별 `SimulationConfig` 조회 및 계수 반영 정확성

## 변경 사항 요약

- **`lib/simulation.ts` 3개 순수 함수 구현**: 스켈레톤(Task 003)에 이미 확정된 시그니처/JSDoc 계약을 그대로 따라 `computeBotClaimCount`(`floor(botIntensity * elapsed.seconds)`를 `availableSeatCount`로 클램프), `computeQueuePosition`(`max(0, initialPosition - admissionRatePerSec * elapsed.seconds)` + `admitted` 플래그), `findExpiredHolds`(`expiresAt < now` 필터)를 구현. DB I/O 없는 순수 함수 상태 유지.
- **`lib/tick.ts` 신규 오케스트레이터 — fractional-progress 손실 문제를 스키마 변경 없이 해결**: 스켈레톤 주석에 "Known gap"으로 명시돼 있던 문제(매 tick마다 `lastTickAt`을 `now`로 단순 덮어쓰면, `floor()` 때문에 폴링이 잦고 `botIntensity`가 낮을 때 소수점 진행분이 매번 버려짐 — 예: `botIntensity=0.1`에 2초마다 폴링하면 매번 `floor(0.2)=0`이라 봇이 영원히 0석 선점)를 별도 누적 카운터 필드 추가 없이 해결했다. 방식: `lastTickAt`을 항상 `now`로 갱신하지 않고, **이번 tick에서 실제로 claim된 정수 좌석 수에 해당하는 시간만큼만**(`claimCount / botIntensity`초) 전진시키고 나머지(소수점 잔여)는 전진시키지 않아 다음 tick의 경과 시간 계산에 자연히 이월되도록 했다. `lib/tick.test.ts`의 "carries fractional bot progress forward" 테스트로 3번의 짧은 tick(합계 11초, 매번 개별로는 0석)이 누적으로 정확히 1석(=`floor(0.1*11)`)이 되는 것을 확인함 — `lib/simulation.ts` 헤더 주석도 이 해결 방식으로 갱신.
- **동시 tick 레이스 방지 — `SELECT ... FOR UPDATE` + Prisma 인터랙티브 트랜잭션**: 원자적 CTE 단일 UPDATE 문 방식(`WITH old AS (...) UPDATE ... RETURNING`)도 검토했으나, 계산에 필요한 `SimulationConfig`(티어별 `botIntensity`) 조회가 `lastTickAt` 갱신값 계산보다 먼저 필요해 순수 SQL 한 문장으로 묶기 어려웠다. 대신 `prisma.$transaction` 콜백 안에서 `tx.$queryRaw` `SELECT "lastTickAt", "tier" FROM "SimulationRun" WHERE id = ${runId} FOR UPDATE`로 행 잠금을 잡고 그 안에서 `SimulationConfig` 조회·계산·`tx.simulationRun.update()`까지 수행 — 두 번째 동시 요청은 `FOR UPDATE`에서 첫 번째 트랜잭션 커밋까지 블록되고, 커밋 후에는 이미 전진된 `lastTickAt`을 자신의 기준값으로 읽으므로 같은 경과 구간을 중복 계산하지 않는다. `lib/tick.test.ts`의 "serializes concurrent ticks" 테스트가 실제 로컬 Postgres에 대해 `Promise.all`로 동시 호출해 이 직렬화를 검증(모킹 없음).
- **`lib/tick.ts`가 `prisma`(`lib/db.ts`)를 직접 사용**: Task 006의 `app/api/session/route.ts`와 동일한 패턴(운영 클라이언트를 직접 사용, 테스트는 `lib/test-db.ts`가 같은 `DATABASE_URL`을 가리키는 별도 클라이언트로 검증). 새 스키마 마이그레이션 없음 — `SimulationRun.lastTickAt`(Task 002에 이미 존재)만 사용.
- **큐/hold 만료 계산은 별도 오케스트레이터 없이 순수 함수만 유지**: `computeQueuePosition`(기준점이 각 `QueueEntry.joinedAt`)과 `findExpiredHolds`(기준값이 각 `Hold.expiresAt`)는 `lastTickAt`처럼 갱신해야 할 공유 상태가 없어 레이스 컨디션 자체가 없다 — Task 008/009의 라우트가 이미 조회한 데이터를 넘겨 직접 호출하면 충분하다고 판단해 `lib/tick.ts`는 봇 claim 계산(유일하게 공유 상태 `lastTickAt`을 갖는 경로)만 오케스트레이션한다.
- **검증**: `npx tsc --noEmit`, `npm run lint` 모두 통과. `npx vitest run` 39 tests / 5 files 전부 통과(`lib/simulation.test.ts` 17건 — DB 불필요, `lib/tick.test.ts` 5건 — 실제 로컬 Postgres 사용, 동시성 케이스 포함). Task 007은 별도 API 라우트/UI가 없어 ROADMAP의 Task 007 테스트 체크리스트에도 Playwright E2E 항목이 없음 — Vitest 단위/통합 테스트만으로 완료 인정.
- **다음 Task 인계 사항**: (1) Task 009는 `lib/tick.ts`의 `advanceTick()`이 반환하는 `botClaim.claimCount`만큼 봇 세션으로 실제 hold 트랜잭션(사용자와 동일한 조건부 `UPDATE seats ... RETURNING` + `INSERT holds`)을 실행해야 함 — 어떤 좌석을 고를지는 이 Task의 범위 밖. (2) Task 008/009는 `computeQueuePosition`/`findExpiredHolds`를 각자 조회한 `QueueEntry`/`Hold` 데이터로 직접 호출하면 됨(`lib/tick.ts`를 거칠 필요 없음). (3) `advanceTick()`은 `availableSeatCount`를 호출자가 넘겨야 하므로, Task 009 라우트가 tick 호출 직전에 해당 run의 `AVAILABLE` 좌석 수를 조회해 전달해야 함.
