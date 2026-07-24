# Task 004: 공통 컴포넌트 · 디자인 시스템 · 더미 데이터

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 004 항목 업데이트

## 개요

Phase 2(UI/UX 완성) 착수 태스크. 백엔드 없이 전체 플로우를 체험 가능하게 만들기 전에, 모든 페이지가 공유할 디자인 토큰·공통 컴포넌트·더미 데이터 유틸리티를 먼저 확립한다. 특정 티케팅 플랫폼(멜론/예스24/인터파크 등) UI를 복제하지 않는 자체 브랜드 정체성을 정의하고, F005(좌석 3색 시각 문법)의 색상 규칙을 토큰화한다. Task 005(전 페이지 UI)가 이 컴포넌트/더미 데이터를 그대로 소비한다.

## 관련 파일

- `app/globals.css` — 디자인 토큰(색상/타이포) 확장 (수정)
- `app/components/StepIndicator.tsx` — 단계 진행 인디케이터 (신규)
- `app/components/CountdownTimer.tsx` — 오픈 카운트다운 표시 (신규)
- `app/components/HoldTimer.tsx` — hold 잔여 시간 표시 (신규)
- `app/components/SeatCell.tsx` — 좌석 셀 (3색 상태) (신규)
- `app/components/WarningBanner.tsx` — 경고 배너 (신규)
- `app/components/PaymentModal.tsx` — 모의 결제창 모달 (신규)
- `lib/dummy-data.ts` — 더미 콘서트/200석 배치/대기열/결과 리포트 생성 유틸 (신규)

## 선행 조건

- Task 003 (완료 — `lib/types.ts`의 API 응답 타입과 더미 데이터 구조가 정합해야 함)

## 수락 기준

- [x] TailwindCSS 4 기반 디자인 토큰 정의 (색상 팔레트, 타이포 스케일) — 특정 플랫폼 UI 복제 금지, 자체 브랜드 정체성 확립
- [x] 좌석 상태 3색 규칙 토큰화: available(보라) / held(연보라색) / sold(회색) — `SeatCell`이 이 토큰만 참조
- [x] 공통 컴포넌트 6종(`StepIndicator`, `CountdownTimer`, `HoldTimer`, `SeatCell`, `WarningBanner`, `PaymentModal`) 구현
- [x] `lib/dummy-data.ts`가 `lib/types.ts`의 응답 타입(`SeatMapResponse`, `QueuePollResponse`, `SessionResultResponse` 등)과 동일한 shape으로 더미 값을 생성 — Task 007~011에서 실 API로 교체 시 컴포넌트 props 변경 최소화
- [x] 타입 체크(`npm run build` 또는 `tsc --noEmit`) 및 린트(`npm run lint`) 통과

## 구현 단계

1. [x] `app/globals.css`에 디자인 토큰 확장: 브랜드 accent 색상(보라 계열), 좌석 상태 3색(available/held/sold) semantic 토큰, 경고/에러 색상 정의
2. [x] `lib/dummy-data.ts` 작성: 더미 콘서트 1개, 200석 배치(좌석 상태 랜덤 분포 포함), 대기열 순번 샘플, 결과 리포트 샘플 — 각각 `lib/types.ts`의 대응 타입을 반환 타입으로 명시
3. [x] `StepIndicator` 구현: 홈→대기열→좌석→예매정보→결제→결과 6단계, 현재 단계 prop으로 하이라이트
4. [x] `CountdownTimer`, `HoldTimer` 구현: 대상 시각(target `Date`)을 prop으로 받아 로컬에서 잔여 시간만 표시 — **주의**: 이 컴포넌트의 `setInterval`은 화면 표시 재계산 전용이며 시뮬레이션 상태의 소유자가 아님(서버 tick 엔진이 Phase 3에서 진실 소스, CLAUDE.md "봇을 setInterval로 구현 금지" 항목과 무관)
5. [x] `SeatCell` 구현: 3색 상태 렌더 + 클릭 피드백(hover/selected 시각 스타일), 상태는 prop으로 주입(로직 없음)
6. [x] `WarningBanner`, `PaymentModal` 구현: 배너는 상시 노출형 경고 문구 슬롯, 모달은 로딩→성공/실패 상태 전환 뼈대(실제 결제 로직은 Task 010)
7. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **디자인 방향**: "실전 티케팅 훈련 시뮬레이터" 컨셉으로 자체 브랜드 정체성 확립 (NOL/예스24 등 플랫폼 복제 없음). 라이트 전용 테마(다크/라이트 토글 없음 — 최초 다크 전용 제안은 논의 후 라이트 전용으로 확정). PRD가 강제하는 "포도알"(예매 가능 좌석=보라) 규칙을 색상 계열 하나로 스토리화: available(비비드 바이올렛) → held(연보라) → sold(스톤 그레이). `SeatCell`을 사각형이 아닌 **원형**으로 렌더링하는 것을 이 디자인 시스템의 시그니처로 채택.
- **타이포그래피**: Space Grotesk(제목)·Inter(본문)·JetBrains Mono(카운트다운/hold 타이머/좌석 번호 등 "실시간 시뮬레이션 데이터" 전용)로 역할 분리. `app/layout.tsx`의 Geist/Geist_Mono를 이 3개 폰트로 교체 — **범위 편차**: `app/layout.tsx`는 원래 이 태스크의 "관련 파일" 목록에 없었으나, `next/font/google`이 실제 폰트를 로드하는 유일한 지점이라 토큰이 의미를 가지려면 필수적이어서 포함함(사용자 확인 완료).
- **`app/globals.css`**: `@theme inline` 블록에 라이트 전용 색 토큰 전면 재정의 — `--color-page/surface/surface-raised/border`, `--color-ink/mute`, `--color-brand/focus`, `--color-seat-available/held/sold`, `--color-warning/danger/success`. 기존 `--background`/`--foreground`는 신규 토큰의 별칭으로 유지(Task 5 이전 미수정 페이지 호환). 버그성 잔재였던 `body { font-family: Arial... }` 및 다크모드 미디어쿼리 제거, `color-scheme: light` 명시.
- **`lib/dummy-data.ts`** (신규): `getDummyConcert`, `TIER_LABELS`, `getDummySeatMap`(A~J행×20석=200석, 가중 랜덤 상태 분포, `rng` 주입 가능), `getDummyQueuePosition`, `getDummySessionResult` — 모두 `lib/types.ts`의 대응 응답 타입을 그대로 반환.
- **컴포넌트 6종** (`app/components/` 신규 디렉토리): `StepIndicator`(서버 컴포넌트, 독자 6단계 타입), `WarningBanner`(서버 컴포넌트, 비상시노출), `SeatCell`(`"use client"`, 원형 시그니처 + selected 링 + reduced-motion 대응 펄스), `CountdownTimer`/`HoldTimer`(`"use client"`, 재계산 전용 setInterval + 시뮬레이션 상태 비소유 명시 주석), `PaymentModal`(`"use client"`, 완전 controlled 3-phase 셸, Escape로 닫기).
- **검증**: `npx tsc --noEmit` / `npm run build` / `npm run lint` 모두 통과. `app/page.tsx`를 임시로 6개 컴포넌트 프리뷰로 교체해 Playwright MCP로 시각 확인(StepIndicator 단계 전환, WarningBanner 2종 tone, Countdown/HoldTimer 정상/위험 색상 전환, SeatCell 4종 상태+selected, PaymentModal 3-phase) 후 `app/page.tsx` 원상복구 — Task 4의 파일 범위(`globals.css`+컴포넌트 6종+`dummy-data.ts`)에는 최종 diff상 변경 없음.
- **후속 참고**: 검증 과정에서 생성된 임시 스크린샷 4개(`task4-*.png`)와 `.playwright-mcp/` 디렉토리가 저장소 루트에 untracked 상태로 남아 있음 — 이 세션의 rm 권한이 거부되어 자동 정리하지 못했으므로, 커밋 전 수동 삭제 필요.
