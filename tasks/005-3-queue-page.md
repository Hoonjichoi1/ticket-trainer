# Task 005-3: 대기열 페이지 (순번 표시 + 경고 배너)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-3 항목 업데이트

## 개요

Task 005 분할 중 대기열 페이지 담당 서브태스크. 더미 순번/대기 인원/예상 시간을 표시하고, 새로고침 시 순번이 초기화된다는 상시 경고를 노출한다. 관련 기능: F003, F004.

## 관련 파일

- `app/queue/page.tsx` — 대기열: 순번/경고 배너 (수정)

## 선행 조건

- Task 005-1 (상태 전달 방식 확정)

## 수락 기준

- [x] `lib/dummy-data.ts`의 `getDummyQueuePosition`으로 더미 순번/앞 대기 인원/예상 시간 표시
- [x] "새로고침 시 순번 초기화" 상시 경고 배너(`WarningBanner`) 노출
- [x] 좌석 선택 페이지로 이동하는 링크/버튼 제공
- [x] `StepIndicator`로 현재 단계(대기열) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `getDummyQueuePosition` 렌더: 순번, 앞 대기 인원, 예상 대기 시간
2. [x] `WarningBanner` 배치 ("새로고침 시 순번이 초기화됩니다" 상시 경고, tone: warning)
3. [x] 좌석 페이지(`/seats`)로 이동하는 링크 배치
4. [x] `StepIndicator`(현재 단계: 대기열) 배치
5. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- `app/queue/page.tsx`를 서버 컴포넌트로 재작성 (클라이언트 상태 불필요 — 정적 더미 렌더). `getDummyQueuePosition()`으로 순번/앞 대기 인원/예상 대기 시간(`m초` 포맷) 표시.
- `WarningBanner`(tone: warning, 기본값)로 "새로고침 시 순번 초기화" 상시 경고 배치, `StepIndicator currentStage="queue"` 배치.
- 홈 페이지에서 넘어온 `?tier=` 쿼리는 이 페이지의 수락 기준에 소비 요구사항이 없어 읽지 않음(범위 외 기능 추가 방지).
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 `/queue?tier=MEDIUM` 방문 — 경고 배너·순번(128)/앞 대기(127)/예상 대기(1m 35s) 렌더, StepIndicator 2단계(Queue) 하이라이트, "Continue to Seat Selection" 클릭 시 `/seats`로 정상 이동 확인. 콘솔 에러/경고 없음.
