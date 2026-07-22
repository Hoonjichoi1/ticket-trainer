# Task 002: DB 스키마 · Prisma · 환경 설정

## 상태

- [ ] 진행 중
- [ ] 완료 — See: `docs/ROADMAP.md` Task 002 항목 업데이트

## 개요

Concert, Seat, Hold, Booking, QueueEntry, SimulationConfig, SessionResult 및 시뮬레이션 인스턴스 상태를 포함하는 Prisma 스키마를 작성한다. CLAUDE.md 크리티컬 이슈(부분 유니크 제약, tick 엔진 영속화)를 스키마 단계에서 반영해야 이후 Task가 재작업 없이 진행 가능.

## 관련 파일

- `schema.prisma` — 전체 데이터 모델 (신규)
- `.env.local` — Neon pooled connection (`-pooler` 접미사 필수) (신규, gitignore 대상)
- `.env.example` — 환경변수 레퍼런스 (신규)
- `lib/db.ts` — Prisma client 싱글톤 (신규)
- `prisma/seed.ts` — 시드 스크립트 (신규)

## 선행 조건

- 사전 결정 사항 D-1 (시뮬레이션 인스턴스 단위: 세션별 독립 인스턴스로 확정됨)
- 사전 결정 사항 D-2 (티어 선택 전달 경로: 대기열 진입 API 파라미터로 확정됨)

## 수락 기준

- [ ] `Hold` 테이블에 `UNIQUE(seatId) WHERE expiresAt > now()` 부분 유니크 제약 존재 (이중 hold 방지)
- [ ] `QueueEntry.joinedAt`(DateTime), `SimulationConfig.admissionRatePerSec`(Float) 필드 존재
- [ ] 인덱스 존재: `Seat.concertId`, `Hold.expiresAt`, `Hold(seatId, expiresAt)` 부분 유니크, `QueueEntry(concertId, sessionId)`
- [ ] D-1 결정(세션별 인스턴스) 반영: `SimulationRun` 모델(`id`, `sessionId`, `tier`, `lastTickAt`, `status`) 존재, `Seat`/`QueueEntry`가 스코프 키로 연결됨
- [ ] `lastTickAt`이 메모리가 아닌 DB(`SimulationRun`)에 영속화됨
- [ ] D-2 결정 반영: 선택 티어를 기록할 필드(`SimulationRun.tier`) 확정
- [ ] `.env.local`의 `DATABASE_URL`이 Neon **pooled**(`-pooler`) 커넥션을 사용
- [ ] `npx prisma migrate dev` 성공, seed 스크립트 실행 시 콘서트 1개 + 200석 + 3티어 `SimulationConfig` 생성 확인

## 구현 단계

1. [ ] `schema.prisma` 초안 작성 (Concert, Seat, Hold, Booking, QueueEntry, SimulationConfig, SessionResult, SimulationRun)
2. [ ] `Hold` 부분 유니크 제약 및 인덱스 반영
3. [ ] `SimulationRun.lastTickAt` 및 봇 결정론 유지용 필드(누적 처리 카운터/시드) 추가
4. [ ] `@prisma/adapter-neon` 연동 설정
5. [ ] `.env.local`(pooled connection) / `.env.example` 작성
6. [ ] `lib/db.ts` Prisma client 싱글톤 구현
7. [ ] 초기 마이그레이션 실행
8. [ ] `prisma/seed.ts` 작성 (콘서트 1개, 200석 배치 템플릿, 소/중/메가 3티어 `SimulationConfig`)
9. [ ] seed 실행 후 DB 상태 확인

## 변경 사항 요약

>
