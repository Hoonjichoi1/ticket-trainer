# Task 003: 타입 정의 및 시뮬레이션 엔진 스켈레톤

## 상태

- [ ] 진행 중
- [ ] 완료 — See: `docs/ROADMAP.md` Task 003 항목 업데이트

## 개요

`lib/types.ts`에 공유 타입을 정의하고 `lib/simulation.ts`에 tick-on-request 패턴의 스켈레톤을 stub으로 구현한다. 실제 계산 로직은 Phase 3(Task 007)에서 채우며, 여기서는 함수 시그니처와 인터페이스만 확정한다.

## 관련 파일

- `lib/types.ts` — 공유 타입 정의 (신규)
- `lib/simulation.ts` — tick 엔진 스켈레톤 (신규)

## 선행 조건

- Task 002 (스키마 확정 — 타입이 스키마 모델과 정합해야 함)

## 수락 기준

- [ ] `lib/types.ts`에 Tier enum, SeatStatus, QueueStatus 정의됨
- [ ] API 요청/응답 타입 정의됨 (session, queue, seats, booking, payment)
- [ ] 결과 outcome/event 타입 정의됨 (Task 008~010에서 기록할 판단 이벤트 스키마 사전 확정)
- [ ] `lib/simulation.ts`에 tick 함수 시그니처 존재 (경과 시간 기반 봇 선점 수 계산, 순번 감소 계산, hold 만료 판정 — 각각 함수 인터페이스만, 내부는 TODO)
- [ ] 타입 체크(`tsc --noEmit` 또는 `npm run build`) 통과

## 구현 단계

1. [ ] `lib/types.ts`: Tier, SeatStatus, QueueStatus 등 enum 정의
2. [ ] `lib/types.ts`: API 요청/응답 타입 정의 (Task 001의 빈 핸들러 시그니처와 정합)
3. [ ] `lib/types.ts`: 판단 이벤트 타입 정의 (에러 발생/재결제/새로고침/hold 만료 등 — Task 008~010이 기록할 이벤트 종류를 미리 확정)
4. [ ] `lib/simulation.ts`: tick 함수 시그니처 stub 작성 (`now - lastTickAt` 경과 시간 계산 부분만 구현, 봇 선점/순번 감소/hold 만료 판정은 TODO)
5. [ ] `lib/simulation.ts`: 결정론 보장을 위한 인터페이스 설계 메모 주석 반영 (같은 입력 → 같은 출력)
6. [ ] 타입 체크 통과 확인

## 변경 사항 요약

>
