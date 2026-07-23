# Task 003: 타입 정의 및 시뮬레이션 엔진 스켈레톤

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 003 항목 업데이트

## 개요

`lib/types.ts`에 공유 타입을 정의하고 `lib/simulation.ts`에 tick-on-request 패턴의 스켈레톤을 stub으로 구현한다. 실제 계산 로직은 Phase 3(Task 007)에서 채우며, 여기서는 함수 시그니처와 인터페이스만 확정한다.

## 관련 파일

- `lib/types.ts` — 공유 타입 정의 (신규)
- `lib/simulation.ts` — tick 엔진 스켈레톤 (신규)

## 선행 조건

- Task 002 (스키마 확정 — 타입이 스키마 모델과 정합해야 함)

## 수락 기준

- [x] `lib/types.ts`에 Tier enum, SeatStatus, QueueStatus 정의됨 — 단, 직접 재정의하지 않고 `@/lib/generated/prisma/enums`를 재노출(`export *`)하고 `QueueStatus`는 실제 Prisma enum명인 `QueueEntryStatus`의 type alias로 정의 (아래 변경 사항 요약 참조)
- [x] API 요청/응답 타입 정의됨 (session, queue, seats, booking, payment)
- [x] 결과 outcome/event 타입 정의됨 (Task 008~010에서 기록할 판단 이벤트 스키마 사전 확정)
- [x] `lib/simulation.ts`에 tick 함수 시그니처 존재 (경과 시간 기반 봇 선점 수 계산, 순번 감소 계산, hold 만료 판정 — 각각 함수 인터페이스만, 내부는 TODO)
- [x] 타입 체크(`tsc --noEmit` 또는 `npm run build`) 통과

## 구현 단계

1. [x] `lib/types.ts`: Tier, SeatStatus, QueueStatus 등 enum 정의
2. [x] `lib/types.ts`: API 요청/응답 타입 정의 (Task 001의 빈 핸들러 시그니처와 정합)
3. [x] `lib/types.ts`: 판단 이벤트 타입 정의 (에러 발생/재결제/새로고침/hold 만료 등 — Task 008~010이 기록할 이벤트 종류를 미리 확정)
4. [x] `lib/simulation.ts`: tick 함수 시그니처 stub 작성 (`now - lastTickAt` 경과 시간 계산 부분만 구현, 봇 선점/순번 감소/hold 만료 판정은 TODO)
5. [x] `lib/simulation.ts`: 결정론 보장을 위한 인터페이스 설계 메모 주석 반영 (같은 입력 → 같은 출력)
6. [x] 타입 체크 통과 확인

## 변경 사항 요약

> **enum 재정의 대신 재노출**: `lib/types.ts`는 `Tier`/`SeatStatus`/`QueueEntryStatus`/`SessionOutcome`/`SimulationRunStatus`를 직접 선언하지 않고 `export * from "@/lib/generated/prisma/enums"`로 Prisma 생성 enum(값 객체 + 파생 union 타입)을 그대로 재노출한다. 스키마가 변경되면 자동으로 반영되어 타입 드리프트를 방지한다. 태스크 원문/PRD가 캐주얼하게 부르는 "QueueStatus"는 실제 Prisma enum명이 아니므로(`QueueEntryStatus`가 정식명), `QueueStatus`는 `QueueEntryStatus`의 얇은 type alias로만 제공한다.
>
> **판단 이벤트 스키마**: `JudgmentEvent`를 `type` 필드로 판별되는 discriminated union으로 설계 — `queue_reset`, `contention_loss`, `seat_claim_success`, `payment_error`, `payment_retry_success`, `payment_abandoned`, `hold_expired` 7종. `SessionResult.events`(Json 컬럼)에 직렬화되는 형태를 그대로 반영했으며, Task 008~010은 이 타입을 변경하지 않고 이벤트를 append하기만 하면 되도록 설계했다. `StageTimings`도 별도로 정의해 `SessionResult.stageTimings` 형태를 미리 확정했다. 모든 wire 타입의 시간 필드는 `Date`가 아닌 ISO 8601 `string`으로 통일했다(`NextResponse.json()`/Prisma `Json` 컬럼은 `Date` 객체를 그대로 보존하지 않음).
>
> **tick 함수 시그니처 분리 (TickInput/TickResult 단일 래퍼 미채택)**: `computeBotClaimCount`(봇 선점 수), `computeQueuePosition`(순번 감소), `findExpiredHolds`(hold 만료 판정)를 하나의 tick 객체로 묶지 않고 계산별 독립 input/output 인터페이스로 분리했다 — 각각 다른 라우트(`/api/seats`, `/api/queue`)에서 서로 다른 시점에 독립 호출되므로, 하나로 묶으면 불필요한 결합과 미사용 필드가 생긴다. `computeElapsedTime`만 실제 구현했고(`Math.max(0, now - since)`로 클램프), 나머지 세 함수는 `throw new Error(...)` stub으로 남겨 strict 모드 타입체크는 통과하되 실수로 호출 시 조용히 틀린 값(0 등)을 반환하지 않고 즉시 실패하도록 했다.
>
> **알려진 갭 문서화 (Task 007 인계 사항)**: `lib/simulation.ts` 상단 주석에 두 가지를 명시적으로 남겼다 — (1) `SimulationRun`에 봇 진행 누적치/시드 필드가 없어(현재 `lastTickAt`만 존재) 짧은 간격의 폴링에서 소수점 진행분이 유실될 수 있음 — accumulator 필드 추가 또는 현재 HELD 좌석 수로 대체하는 결정이 Task 007에서 필요, (2) 동시 tick 요청의 이중 전진(double-advance) 방지는 이 순수 함수들의 책임이 아니라 호출자의 read-modify-write 보호(conditional UPDATE 등) 책임임을 명시.
>
> 신규 파일: `lib/types.ts`, `lib/simulation.ts`. 기존 파일 수정 없음(`prisma/schema.prisma`, `app/api/*/route.ts` 등은 이 태스크 범위 밖). `npx tsc --noEmit`, `npm run lint -- lib/types.ts lib/simulation.ts` 모두 통과 확인.
