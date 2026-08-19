# Task 005-6: 결제 페이지 (결제 수단 선택 + 모의 결제창)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-6 항목 업데이트

## 개요

Task 005 분할 중 결제 페이지 담당 서브태스크. 결제 수단 3종 선택과 `PaymentModal`을 통한 모의 결제 진행(성공/실패 더미 분기)을 구현한다. 관련 기능: F014.

## 관련 파일

- `app/payment/page.tsx` — 결제 라우트 진입점, 서버 컴포넌트 (수정)
- `app/payment/PaymentViewLoader.tsx` — `ssr:false` 클라이언트 전용 로더 (신규, hydration mismatch 회피용)
- `app/payment/PaymentView.tsx` — 결제 수단 선택/모의 결제 모달 실제 로직 (신규)

## 선행 조건

- Task 005-1 (상태 전달 방식 확정)
- Task 005-5 (예매 정보 입력 완료 후 진입하는 페이지)

## 수락 기준

- [x] 결제 수단 3종(간편결제/카드 더미 폼/무통장입금) 선택 UI
- [x] `PaymentModal`로 모의 결제 진행 (로딩→성공/실패 상태 전환)
- [x] 에러 화면 UI (더미로 성공/실패 케이스 모두 확인 가능한 트리거 포함)
- [x] `StepIndicator`로 현재 단계(결제) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] 결제 수단 3종 선택 UI 구현 (카드 선택 시 더미 카드 정보 입력 폼 노출)
2. [x] `PaymentModal` 연동: 결제 시작 시 로딩 phase → 더미 성공/실패 분기
3. [x] 성공/실패를 모두 확인할 수 있는 더미 트리거 구현 (예: 특정 카드번호/버튼으로 실패 강제)
4. [x] 에러 화면 UI (재시도/이탈 선택지 표시)
5. [x] 성공 시 결과 리포트 페이지로 이동 + `StepIndicator`(현재 단계: 결제) 배치
6. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **파일 분리 (005-4/005-5와 동일 패턴)**: 선택 좌석 요약과 hold 잔여 시간을 보여주기 위해 `sessionStorage`(`getSelectedSeat()`)를 읽어야 하므로, 동일하게 3파일 분리 적용: `app/payment/page.tsx`(서버 컴포넌트) → `PaymentViewLoader.tsx`(`ssr:false`) → `PaymentView.tsx`(실제 로직). 좌석 정보가 없으면 005-5와 동일하게 `/seats` 안내 화면만 렌더.
- **결제 수단별 소요 시간**: PRD F014("무통장 최속, 카드 최저속")에 맞춰 더미 `setTimeout` 값을 차등 적용 — 무통장이체 600ms(fastest) / 간편결제 1200ms / 카드 2200ms(slowest). 각 옵션에 소요 시간 힌트(`~0.6s · fastest` 등)를 표시해 hold 잔여 시간 대비 수단 선택 판단을 유도.
- **카드 폼**: `DummyCardDetails` 타입 그대로 사용 (카드번호/만료월/만료년/CVC), 실제 검증 없이 값 존재 여부로만 "Pay now" 활성화 조건 체크.
- **성공/실패 트리거**: "Simulate a payment failure (test)" 체크박스로 강제 실패를 트리거 — 실패 시 `timeout`/`server_error` 중 무작위로 골라 실제처럼 불친절한 에러 문구(`Error 504: Gateway Timeout…`, `Error 500: Internal Server Error…`) 노출. `PaymentModal`의 실패 phase가 이미 Close/Retry 버튼을 제공하므로 별도 에러 화면 컴포넌트 없이 그대로 사용.
- **Close/Retry 분기**: 성공 phase의 "Done" 클릭 시에만 `/result`로 이동, 실패 phase의 "Close"는 모달만 닫고 좌석/hold·입력값 유지(재결제 유도), "Retry"는 동일 조건으로 결제를 즉시 재시도.
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 (1) `sessionStorage` 비어있을 때 안내 화면, (2) 더미 좌석(C7) 주입 후 좌석/hold 타이머/3종 수단 정상 렌더, (3) Bank Transfer 선택 후 정상 결제 → 성공 모달 → Done 클릭 시 `/result` 이동, (4) Card 선택 + 더미 카드 정보 입력 + 실패 체크박스 → 실패 모달(에러 문구, Close/Retry) → Retry 재시도 → Close로 모달만 닫히고 페이지 상태 유지 확인. 콘솔 에러/경고 없음.
