# Task 005-1: 공통 기반 — 페이지 간 상태 전달 방식 + 구역 그룹핑 헬퍼

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-1 항목 업데이트

## 개요

Task 005(모든 페이지 UI 완성)를 페이지 단위 서브태스크로 분할하며 가장 먼저 확정해야 하는 공통 기반. 백엔드가 아직 없는 상태에서 페이지 간 상태를 어떻게 넘길지(티어 선택, 선택 좌석)와, 200석을 5개 구역(Block A~E)으로 그룹핑하는 로직을 여기서 확정해 005-2~005-7이 동일한 규칙을 재발명하지 않도록 한다. 관련 기능: F001, F005.

## 관련 파일

- `lib/dummy-data.ts` — `Seat.number` 기준 5구역(Block A~E) 그룹핑 헬퍼 함수 추가 (수정)
- `lib/session-storage.ts` — 선택 좌석 sessionStorage read/write 헬퍼 및 키 상수 (신규)

## 선행 조건

- Task 004 (완료 — `lib/dummy-data.ts`, `lib/types.ts`의 `SeatSummary` shape을 그대로 사용)

## 수락 기준

- [x] 티어 선택 상태는 홈→대기열 이동 시 `?tier=` URL 쿼리 파라미터로 전달하기로 확정 (별도 상태 관리 라이브러리 도입 없음)
- [x] 선택 좌석 상태는 좌석 선택→예매정보→결제→결과 페이지 간 `sessionStorage`로 전달하기로 확정, 키 상수와 read/write 헬퍼 함수 시그니처 정의
- [x] `lib/dummy-data.ts`에 `Seat.number` 기준 5구역 그룹핑 헬퍼 함수 작성: 1~4번=Block A, 5~8번=Block B, 9~12번=Block C, 13~16번=Block D, 17~20번=Block E. `Seat.row`는 구역 구분에 사용하지 않음
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] 상태 전달 방식 결정 문서화: 티어(`?tier=` 쿼리) vs 선택 좌석(`sessionStorage`) 각각의 이유와 스코프를 이 파일 "변경 사항 요약"에 기록
2. [x] `lib/session-storage.ts` 작성: 선택 좌석 정보(좌석 id, row, number, 선택 시각 등 후속 태스크에서 필요한 최소 필드)를 저장/조회하는 타입-세이프 헬퍼
3. [x] `lib/dummy-data.ts`에 구역 그룹핑 헬퍼 함수 추가 (예: `getZoneForSeatNumber(number: number)`, `groupSeatsByZone(seats: SeatSummary[])`) — `lib/types.ts`의 `SeatSummary` 타입을 입력으로 받음
4. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **상태 전달 방식**: 티어는 홈→대기열 단방향 이동에만 필요하고 뒤이은 페이지들은 소비하지 않아 URL 쿼리(`?tier=`)로 충분 — 새로고침해도 자연히 유지됨. 선택 좌석은 좌석선택→예매정보→결제→결과 4개 페이지가 순차 소비하고 새로고침 시에도 남아있어야 해서 `sessionStorage` 채택(라우터 상태나 외부 상태 라이브러리 도입 없이 최소 구현).
- **`lib/session-storage.ts`** (신규): `saveSelectedSeat`/`getSelectedSeat`/`clearSelectedSeat` — 키 `ticket-trainer:selected-seat`에 `{id, row, number, selectedAt}` JSON 저장. `typeof window === "undefined"` 가드로 서버 컴포넌트에서 임포트돼도 안전.
- **`lib/dummy-data.ts`** (수정): `SEAT_ZONES`/`SeatZone`/`ZONE_LABELS`(Block A~E) + `getZoneForSeatNumber`(1~4→A … 17~20→E, `Math.floor((number-1)/4)` 기반) + `groupSeatsByZone(seats: SeatSummary[])` 추가. `Seat.row`는 참조하지 않음 — PRD/CLAUDE.md 규칙 그대로.
- **검증**: `npx tsc --noEmit`, `npm run lint` 모두 통과.
- **2026-08-19 수정 (code-reviewer Major #2 반영)**: `getSelectedSeat()`가 `JSON.parse` 성공 여부만 방어하고 결과 형태(shape)는 검증하지 않아, `selectedAt`이 없거나 날짜로 파싱 불가능한 값이 저장돼 있어도 그대로 반환되는 문제가 있었음 — 이 경우 `BookingView`/`PaymentView`의 `HoldTimer`에 `NaN:NaN`이 그대로 노출됨. `isValidSelectedSeat(value: unknown): value is SelectedSeatStorage` 타입 가드를 추가해 `id`/`row`가 문자열, `number`가 숫자, `selectedAt`이 유효한 날짜로 파싱되는 문자열인지 런타임 검증하고, 실패 시 `null`을 반환해 기존 "No seat selected" 폴백 경로를 그대로 타도록 수정. 검증: `tsc`/`lint` 통과, Playwright MCP로 (1) `{id:"A7"}`(필드 누락) (2) `{..., selectedAt:"hello"}`(파싱 불가) 두 케이스 모두 `/booking`에서 "No seat selected yet." 안내로 정상 폴백함을 확인, 정상 데이터는 기존과 동일하게 렌더됨도 재확인.
