# Task 005-5: 예매 정보 페이지 (hold 타이머 + 수령 방법 + 약관)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-5 항목 업데이트

## 개요

Task 005 분할 중 예매 정보 페이지 담당 서브태스크. `sessionStorage`에서 선택 좌석 정보를 읽어 hold 잔여 시간과 함께 표시하고, 수령 방법 선택과 약관 동의를 받는다. 관련 기능: F013.

## 관련 파일

- `app/booking/page.tsx` — 예매 정보 라우트 진입점, 서버 컴포넌트 (수정)
- `app/booking/BookingViewLoader.tsx` — `ssr:false` 클라이언트 전용 로더 (신규, hydration mismatch 회피용)
- `app/booking/BookingView.tsx` — hold 타이머/수령방법/약관 실제 로직 (신규)

## 선행 조건

- Task 005-1 (`sessionStorage` read 헬퍼)
- Task 005-4 (좌석 선택 페이지에서 `sessionStorage`에 좌석 데이터를 써야 이 페이지에서 읽을 수 있음)

## 수락 기준

- [x] `sessionStorage`에서 선택 좌석 정보를 읽어 표시 (없으면 좌석 페이지로 안내)
- [x] hold 잔여 시간 표시
- [x] 매수 1매 고정 표시
- [x] 수령 방법 선택(select/radio) 구현
- [x] 약관 동의 체크박스 구현
- [x] 전체 동의 시에만 "결제하기" 버튼 활성화
- [x] `StepIndicator`로 현재 단계(예매 정보) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] `sessionStorage`에서 선택 좌석 읽기, 데이터 없을 시 `/seats`로 안내하는 UI/리디렉션 구현
2. [x] 선택 좌석 정보 + `HoldTimer`(hold 잔여 시간) 배치
3. [x] 매수 1매 고정 표시
4. [x] 수령 방법 선택 폼(select 또는 radio) 구현
5. [x] 약관 동의 체크박스 구현 (전체 동의 여부로 버튼 활성 조건 계산)
6. [x] "결제하기" 버튼 활성 조건 처리 + `StepIndicator`(현재 단계: 예매 정보) 배치
7. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **파일 분리 (005-4와 동일 패턴)**: `getSelectedSeat()`가 `sessionStorage`를 읽는데, SSR 렌더 시점엔 `window`가 없어 항상 `null`을 반환하고 클라이언트 hydration 시점엔 실제 값을 반환 — 그대로 두면 005-4에서 겪은 것과 동일한 hydration mismatch가 발생한다. 동일하게 3파일로 분리: `app/booking/page.tsx`(서버 컴포넌트, `BookingViewLoader`만 렌더) → `app/booking/BookingViewLoader.tsx`("use client", `next/dynamic(..., {ssr:false})`) → `app/booking/BookingView.tsx`("use client", 실제 로직).
- **hold 잔여 시간**: `sessionStorage`엔 좌석 선택 시각(`selectedAt`)만 저장돼 있고 별도 만료 시각은 없으므로, `selectedAt + 5분`을 hold 만료 시각으로 계산해 `HoldTimer`에 전달 — 좌석 선택 페이지의 5분 hold 규칙과 일관되게 유지.
- **좌석 없음 가드**: `getSelectedSeat()`가 `null`이면 폼 대신 "No seat selected yet" 안내 + `/seats`로 가는 버튼만 렌더.
- **수령 방법**: `DeliveryMethod`(`"mobile" | "onsite"`) 라디오 2종(Mobile Ticket / Pick Up at Venue). **약관**: 이용약관 + 환불정책 체크박스 2개, 수령방법 선택 + 두 체크박스 모두 체크돼야 "Proceed to Payment" 활성화.
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 (1) `sessionStorage` 비어있는 상태에서 `/booking` 방문 시 안내 문구+링크만 뜨는지, (2) `sessionStorage`에 더미 좌석(C7)을 주입한 뒤 좌석 정보/hold 타이머/폼이 정상 렌더되는지, (3) 수령방법 선택+체크박스 2개 체크 시 버튼이 활성화되고 클릭 시 `/payment`로 이동하는지 모두 확인. 콘솔 에러/경고 없음.
