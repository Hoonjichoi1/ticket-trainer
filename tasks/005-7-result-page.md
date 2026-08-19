# Task 005-7: 결과 리포트 페이지 (타임라인 + 판단 피드백)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-7 항목 업데이트

## 개요

Task 005 분할 중 결과 리포트 페이지 담당 서브태스크. 더미 결과 데이터로 성공/실패, 단계별 소요 시간 타임라인, 판단 피드백을 표시하고 홈으로 복귀하는 선형 플로우를 마무리한다. 관련 기능: F011.

## 관련 파일

- `app/result/page.tsx` — 결과 리포트: 타임라인/피드백 (수정)
- `app/result/TryAgainButton.tsx` — "다시 도전" 클릭 시 `sessionStorage` 정리 + 홈 이동 (신규)

## 선행 조건

- Task 005-1 (더미 데이터 유틸 사용 규칙)

## 수락 기준

- [x] 성공/실패 표시
- [x] 단계별 소요 시간 타임라인(더미) 표시
- [x] 경합 패배 횟수(더미) 표시
- [x] 판단 피드백 문구(더미) 표시
- [x] "다시 도전" 버튼으로 홈 복귀
- [x] `StepIndicator`로 현재 단계(결과) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `lib/dummy-data.ts`의 `getDummySessionResult`로 결과 샘플 데이터 로드
2. [x] 성공/실패 표시 UI 구현
3. [x] 단계별 소요 시간 타임라인 렌더 (`StageTimings` 기반)
4. [x] 경합 패배 횟수 + 판단 피드백 문구(`FeedbackItem`) 렌더
5. [x] "다시 도전" 버튼 구현 (홈으로 이동, 필요 시 `sessionStorage` 정리)
6. [x] `StepIndicator`(현재 단계: 결과) 배치
7. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **`?outcome=` 쿼리로 성공/실패 전환**: 아직 백엔드가 없어 실제 세션 결과를 알 수 없으므로, `SessionOutcome`의 5개 값(`SUCCESS`/`QUEUE_TIMEOUT`/`SEAT_LOST`/`PAYMENT_FAILED`/`ABANDONED`)을 URL 쿼리로 받아 `getDummySessionResult({ outcome, feedback })`에 전달 — 유효하지 않거나 없으면 `SUCCESS`로 폴백. Task 005-1이 확정한 "단방향 상태는 URL 쿼리" 규칙(`?tier=`)을 그대로 재사용한 것이며, Task 005-8의 성공/실패 각 1회 E2E 검증이 이 쿼리로 두 경로 모두 접근 가능.
- **완전 서버 컴포넌트**: 결과 데이터가 더미 픽스처뿐이라 클라이언트 전용 상태(sessionStorage 등)를 페이지 자체에서 읽지 않음 — 005-4~005-6과 달리 `ssr:false` 3파일 분리 불필요. Next.js 16에서 `searchParams`가 `Promise`로 바뀐 점을 반영해 `async function ResultPage({ searchParams })`로 구현 (`node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` 확인).
- **실패별 맞춤 피드백**: `FAILURE_FEEDBACK` 맵으로 outcome별 1개씩 다른 코칭 문구 제공 (성공 시엔 `getDummySessionResult`의 기본 피드백 2건 그대로 사용).
- **"다시 도전"**: `app/result/TryAgainButton.tsx`("use client")에서 `clearSelectedSeat()` 호출 후 `/`로 이동 — 이전 런의 좌석이 sessionStorage에 남아 다음 런에 잠깐 노출되는 것을 방지.
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 (1) `/result` 기본 접속 시 성공 UI(타임라인 4단계, 경합 1회, 피드백 2건), (2) `/result?outcome=SEAT_LOST` 접속 시 실패 UI(전용 헤드라인/피드백)로 정상 전환, (3) sessionStorage에 더미 좌석을 넣은 뒤 "Try again" 클릭 시 `/`로 이동하고 sessionStorage가 비는지 확인. 콘솔 에러/경고 없음.
