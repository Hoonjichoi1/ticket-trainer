# Task 005-2: 홈 페이지 (티어 선택 + 오픈 카운트다운)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-2 항목 업데이트

## 개요

Task 005 분할 중 홈 페이지 담당 서브태스크. 소/중/메가 3티어 선택과 오픈 카운트다운을 구현해 대기열 페이지로 티어 정보를 전달한다. 관련 기능: F001, F002.

## 관련 파일

- `app/page.tsx` — 홈: 티어 선택 + 카운트다운 (수정)

## 선행 조건

- Task 005-1 (상태 전달 방식 확정 — `?tier=` 쿼리 파라미터 규칙)

## 수락 기준

- [x] 소/중/메가 3티어 카드 + 티어별 난이도 설명 표시
- [x] 가상 콘서트 정보(`lib/dummy-data.ts`의 `getDummyConcert`) 표시
- [x] `CountdownTimer`로 오픈 카운트다운 표시
- [x] 정각 전 "예매하기" 버튼 비활성 → 정각 후 활성
- [x] 티어 선택 시 `?tier=` 쿼리 파라미터로 대기열 페이지 이동
- [x] `StepIndicator`로 현재 단계(홈) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `getDummyConcert`로 콘서트 정보 + `CountdownTimer` 연동
2. [x] 3티어 카드 UI 구현 (`TIER_LABELS` 활용, 티어별 난이도 설명 텍스트 작성)
3. [x] 정각 전/후 버튼 활성 로직 구현 (카운트다운 완료 이벤트 또는 현재 시각 비교)
4. [x] 티어 카드 클릭 시 `?tier=` 쿼리 파라미터로 `/queue` 이동
5. [x] `StepIndicator`(현재 단계: 홈) 배치
6. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- `app/page.tsx`를 `"use client"` 컴포넌트로 전면 재작성. `useState(() => getDummyConcert())`로 콘서트를 마운트 시 한 번만 고정(매 렌더마다 `openAt`이 밀리는 것 방지), `isOpen` 초기값은 `openAt <= now` 비교로 계산해 오픈 시각이 이미 지난 상태로 로드돼도 정확히 반영.
- 티어 카드 3개는 버튼으로 구현(단일 선택, `aria-pressed`), 선택 상태와 오픈 여부(`isOpen && selectedTier !== null`)를 모두 만족해야 "Book Now" 버튼이 활성화됨.
- 티어별 난이도 설명 문구는 더미 데이터에 없어 이 페이지에 `TIER_DESCRIPTIONS`로 직접 작성(영문, PRD의 봇 강도/에러율 뉘앙스만 반영, 수치는 Phase 3 `SimulationConfig`에서 확정).
- 기존 스텁의 한글 UI 텍스트("홈 — 팬덤 티어 선택...", "예매하기")는 CLAUDE.md의 "모든 UI 텍스트는 영문" 규칙에 따라 영문으로 교체.
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 dev server(`localhost:3000`) 시각 검증 — 오픈 전 카운트다운 표시+버튼 비활성, 티어 카드 클릭 시 선택 상태(pressed) 반영, 카운트다운 종료 시 "Sale is open"과 버튼 자동 활성화, "Book Now" 클릭 시 `/queue?tier=MEDIUM`으로 정상 이동(쿼리 파라미터 전달 확인) 모두 확인. 콘솔 에러/경고 없음.
