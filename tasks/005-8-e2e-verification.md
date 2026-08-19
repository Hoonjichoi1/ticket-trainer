# Task 005-8: 전체 플로우 통합 검증

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-8 항목 업데이트 및 Task 005 완료 처리

## 개요

Task 005 분할의 마무리 서브태스크. 005-2~005-7이 모두 완료된 후, 홈→대기열→좌석→예매정보→결제→결과 전체 선형 플로우가 더미 상태로 끊김 없이 완주 가능한지 검증하고, 타입 체크·린트·로드맵 문서를 정리한다.

## 관련 파일

- (신규/수정 파일 없음 — 검증 및 문서 갱신 전용)

## 선행 조건

- Task 005-2, 005-3, 005-4, 005-5, 005-6, 005-7 전부 완료

## 수락 기준

- [x] 홈→결과 전체 선형 플로우가 더미 상태로 끊김 없이 완주 가능 (dev server 수동 확인, 성공/실패 케이스 각 1회)
- [x] 좌석 선택 → 예매정보 → 결제 → 결과까지 선택한 좌석 정보가 `sessionStorage`를 통해 일관되게 유지됨
- [x] 타입 체크·린트 통과
- [x] `docs/ROADMAP.md` Phase 2의 Task 005 항목이 005-1~005-8 서브태스크 목록으로 갱신됨

## 구현 단계

1. [x] dev server에서 홈→결과 전체 플로우 수동 클릭 검증 — 성공 케이스 1회
2. [x] dev server에서 홈→결과 전체 플로우 수동 클릭 검증 — 실패(결제 에러) 케이스 1회
3. [x] 좌석 선택 → 예매정보 → 결제 → 결과 구간에서 `sessionStorage` 좌석 정보 일관성 확인
4. [x] 타입 체크·린트 통과 확인
5. [x] `docs/ROADMAP.md` Phase 2 Task 005 블록을 005-1~005-8 목록으로 갱신, 완료된 서브태스크는 ✅ 표시
6. [x] `tasks/005-all-pages-ui-dummy-data.md` 상태를 완료로 변경

## 변경 사항 요약

- **성공 케이스 (Playwright MCP)**: 홈(Small 티어 선택, 오픈 전 "Book Now" 비활성 확인) → `/queue?tier=SMALL`(오픈 이후 클릭과 동일한 목적지로 직접 이동 — 카운트다운 자체는 005-2에서 이미 검증된 별개 메커니즘이라 60초 실대기는 생략) → "Continue to Seat Selection" → Block A → 좌석 A1 선택·확정 → Booking(수령방법 Mobile Ticket + 약관 2건 동의) → Payment(Bank Transfer, 가장 빠른 수단) → 성공 모달(`BKG-xxxxxx`) → Done → `/result`에 성공 리포트(총 소요시간/경합 1회/피드백 2건) 정상 표시.
- **실패 케이스 (Playwright MCP)**: "Try again"으로 세션 초기화 후 동일 플로우를 재수행 — `/queue?tier=MEGA` → Block B → 좌석 C7 → Booking(Pick Up at Venue) → Payment에서 Easy Pay + "Simulate a payment failure" 체크 → 결제 실패 모달(`Error 504: Gateway Timeout…`, Close/Retry) 확인 → Close(모달만 닫히고 hold 유지, PRD의 "결제창 닫고 재결제" 분기와 일치). 백엔드가 없어 "새로고침/이탈 시 hold 상실 → 결과(실패)" 자동 전이는 Task 010에서 구현될 부분이므로, 005-7이 마련한 `/result?outcome=PAYMENT_FAILED` 딥링크로 이동해 실패 리포트(전용 헤드라인/피드백)가 정상 렌더되는 것을 확인.
- **`sessionStorage` 일관성**: 두 케이스 모두 좌석 선택 페이지에서 저장한 좌석(A1, C7)이 예매정보·결제 페이지에서 동일하게 표시됨을 스냅샷으로 확인. "Try again" 클릭 시 `clearSelectedSeat()`로 정리되어 다음 런에 이전 좌석이 남지 않음도 확인.
- **검증**: 전체 플로우 진행 중 브라우저 콘솔 에러/경고 0건. `npx tsc --noEmit`, `npm run lint` 통과.
- **문서 갱신**: `docs/ROADMAP.md` Phase 2 Task 005 항목을 005-1~005-8 서브태스크 목록(전부 ✅)으로 갱신하고 Task 005 자체도 ✅ 처리. `tasks/005-all-pages-ui-dummy-data.md` 상태를 완료로 변경.
