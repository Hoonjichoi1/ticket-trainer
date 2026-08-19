# Task 005-4: 좌석 선택 페이지 (구역 선택 → 좌석맵 2단계)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 005-4 항목 업데이트

## 개요

Task 005 분할 중 가장 복잡한 서브태스크. 전체 200석을 한 번에 보여주지 않고, 구역 선택 → 좌석 선택 2단계로 진행한다. 실제 대형 아이돌 콘서트장(KSPO돔류 원형 다층 아레나)의 구조감을 참고하되 특정 공연장 도면을 그대로 재현하지 않고 자체 스타일로 구현한다. 관련 기능: F005.

## 관련 파일

- `app/seats/page.tsx` — 좌석 선택 라우트 진입점, 서버 컴포넌트 (수정)
- `app/seats/SeatsViewLoader.tsx` — `ssr:false` 클라이언트 전용 로더 (신규, hydration mismatch 회피용)
- `app/seats/SeatsView.tsx` — 구역 선택 뷰 + 좌석맵 뷰 토글 실제 로직 (신규)

## 선행 조건

- Task 005-1 (구역 그룹핑 헬퍼, `sessionStorage` 저장 규칙)

## 수락 기준

- [x] 페이지 진입 시 5개 구역(Block A~E, 무대 기준 좌우 위치로 명명) 미리보기가 먼저 표시됨
- [x] 구역은 무대와의 거리감이 느껴지도록 시각적으로 배치됨 (원형/부채꼴 느낌, CSS transform 활용, 실제 좌표 계산 없이 구현)
- [x] 구역 클릭 시 해당 구역 좌석만 `SeatCell` 그리드로 렌더(3색)
- [x] 좌석 클릭 시 로컬 selected 상태 토글(단일 선택) 및 시각 피드백
- [x] ~~`HoldTimer` 표시~~ → 2026-08-19 수정: 좌석 확정 전에는 hold가 시작되지 않았으므로 `SeatsView`에서 제거, `HoldTimer`는 좌석 확정(Confirm) 이후 진입하는 예매정보/결제 페이지에서만 표시 (아래 "변경 사항 요약" 참조)
- [x] 좌석을 선택했을 때만 "좌석 선택 완료" 버튼 활성화 (미선택 시 비활성)
- [x] 구역 선택 → 좌석 선택 → 뒤로가기(구역 재선택)까지 흐름이 끊김 없이 동작
- [x] 선택한 좌석 정보가 `sessionStorage`에 저장되어 예매정보 페이지로 전달됨
- [x] `StepIndicator`로 현재 단계(좌석 선택) 표시
- [x] 타입 체크·린트 통과

## 구현 단계

1. [x] Task 005-1의 구역 그룹핑 헬퍼로 200석을 5구역으로 분류
2. [x] 구역 미리보기 컴포넌트 구현 (블록 5개, 무대 위치 표시, 클릭 가능, 원형/부채꼴 CSS transform 배치)
3. [x] 구역 클릭 시 좌석맵 뷰로 전환하는 로컬 상태(단계 전환) 구현
4. [x] 좌석맵 뷰: 선택된 구역의 좌석만 `SeatCell` 그리드로 렌더, 클릭 시 로컬 selected 상태 토글(단일 선택)
5. [x] "좌석 선택 완료" 버튼 활성 조건(좌석 선택 시에만) 구현, 클릭 시 Task 005-1 헬퍼로 `sessionStorage`에 저장 후 예매정보 페이지 이동
6. [x] ~~`HoldTimer`~~ + `StepIndicator`(현재 단계: 좌석 선택) 배치 (`HoldTimer`는 2026-08-19 제거 — 아래 "변경 사항 요약" 참조)
7. [x] 뒤로가기(구역 재선택) 버튼/동작 구현
8. [x] Playwright MCP로 구역 선택 → 좌석 선택 → 뒤로가기 흐름 시각 검증
9. [x] 타입 체크·린트 통과 확인

## 변경 사항 요약

- **파일 분리 (계획에 없던 범위 편차)**: 원래 `app/seats/page.tsx` 하나만 수정할 계획이었으나, `getDummySeatMap()`이 좌석마다 `Math.random()`을 호출해 SSR 렌더와 클라이언트 hydration이 서로 다른 좌석 상태를 계산 → hydration mismatch 에러 발생. `useEffect`+`setState`로 클라이언트 이후 생성하는 방식은 이 레포의 eslint `react-hooks/set-state-in-effect` 규칙에 걸려 불가. Next.js 16 공식 문서(`node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`)에 따라 `ssr:false`는 Client Component 안에서만 허용되므로, 3개 파일로 분리: `app/seats/page.tsx`(순수 서버 컴포넌트, `SeatsViewLoader` 렌더만) → `app/seats/SeatsViewLoader.tsx`("use client", `next/dynamic(..., {ssr:false})`로 `SeatsView`를 클라이언트 전용 로드 + 로딩 폴백) → `app/seats/SeatsView.tsx`("use client", 실제 구역/좌석 선택 로직 전부).
- **구역 미리보기 (3차례 리디자인)**: 1차(`rotate + translateY`로 살짝 기울인 흰색 카드 5개) → "도형을 그냥 배치한 것처럼 보인다" 피드백 → 2차(개별 `<button>` 카드 + CSS `rotate`) → "카드가 흩어져 있고 옆면이 안 맞닿는다" 피드백 → 3차, **SVG `<polygon>` 기반 부채꼴**로 전면 재작업. 이후 "스테이지가 부채꼴 중앙 허브에 오도록, 그라데이션 없이 차콜 단색으로" 피드백을 받아 4차 조정:
  - 스테이지는 공통 정점(`ARC_PIVOT`) 위치에 그대로 그리는 `<circle>`, 단일 차콜색(`var(--color-ink)`, 그라데이션 없음) — 부채꼴들이 이 원을 허브 삼아 사방으로 감싸는 구조(무대가 부채꼴 바깥이 아니라 한가운데 위치).
  - 5개 구역은 그 정점을 기준으로 한 극좌표(`polar(angleDeg, radius)`, `Math.sin`/`Math.cos`)로 wedge 꼭짓점을 계산. 인접 구역은 동일한 정점에서 뻗어나가는 연속 각도 구간을 잘라 쓰므로 옆면(방사형 변)이 수학적으로 완전히 맞닿음(갭/겹침 없음) — 카드를 따로 놓고 회전시키는 방식이 아니라 "한 도형을 각도만 바꿔 복제"하는 방식이라 자연스럽게 맞닿는다는 원리. 스테이지 반지름보다 큰 `INNER_RADIUS`로 살짝 띄워 참고 사진의 스테이지 둘레 여백 링을 재현.
  - **5차 조정**: "스테이지를 더 키우고, 사다리꼴 위/아랫변을 스테이지 원형을 따라 둥글게" 피드백을 받아 `STAGE_RADIUS`를 64→92로 확대(`INNER_RADIUS`도 82→112, `OUTER_RADIUS`도 232→252로 비례 확장)하고, wedge를 `<polygon>`(직선 변 4개)에서 `<path>` + SVG 타원호 명령(`A`)으로 교체: 안쪽 변은 `INNER_RADIUS` 반지름의 호, 바깥쪽 변은 `OUTER_RADIUS` 반지름의 호로 그려 스테이지의 둥근 형태를 그대로 따라가게 하고, 양옆 방사형 변만 직선으로 유지(맞닿음 속성 보존). 호의 방향을 정하는 `sweep-flag`를 처음엔 잘못 지정해 부채꼴이 별 모양처럼 안쪽으로 뾰족하게 찌그러지는 문제가 있었음 — 안쪽 호 `sweep-flag=0`, 바깥쪽 호 `sweep-flag=1`로 바꿔 스테이지 원과 일치하는 방향으로 수정.
  - 색상은 참고 사진에 맞춰 `--color-seat-available`(브랜드 보라)로 채우고 구역 사이는 `--color-page` 흰 stroke로 구분선만 표시, 라벨은 흰 텍스트(`fill-white`).
  - 좌석 수 표시는 "26/40 open" 형태에서 "몇 석 남았는지만, 라벨과 같은 방향으로" 피드백에 맞춰 남은 좌석 수만 작은 흰 원형 배지로 단순화. 최초엔 라벨/배지를 방사형 위치(`polar` 반지름만 다르게)에 배치했더니 양 끝 구역(A, E)처럼 부채꼴이 수평에 가깝게 누운 곳에서 라벨과 배지가 옆으로 겹치는 문제 발견 → 방사형 대신 화면 기준 고정 수직 오프셋(라벨 y-10, 배지 y+18)으로 변경해 모든 구역에서 항상 "라벨 위, 배지 아래"로 겹침 없이 정렬.
  - `Math.random()`을 쓰지 않는 순수 삼각함수 상수 조합이라 "실제 좌표 계산 없이" 요구사항(실제 KSPO돔 도면 좌표를 가져오지 않음)은 유지하면서도, 자체적으로 정의한 단순 기하 규칙은 사용.
  - **6차 조정**: "무대는 그대로 두고, 부채꼴 범위를 정확히 180도(왼쪽 끝 9시 방향, 오른쪽 끝 3시 방향)로 제한, 아래쪽 반원에만 5개 블록 분포" 피드백을 받아 `TOTAL_SPAN_DEG`를 230→180으로 축소(각도 0=정확히 아래쪽 6시 방향인 기존 좌표계 그대로이므로 `-90..90`이 곧 9시~3시). 스테이지 크기(`STAGE_RADIUS`)는 이전 값 유지. 반원만 쓰면서 생긴 위쪽 빈 여백을 줄이기 위해 `VIEWBOX_HEIGHT`(490→400)와 `ARC_PIVOT.y`(210→130)도 함께 축소 — 시각적 크롭일 뿐 구역 지오메트리 자체는 변경 없음.
  - 클릭 영역은 `<g role="button" tabIndex onClick/onKeyDown>`으로 키보드 접근성 최소 확보.
- **좌석맵 뷰**: `groupSeatsByZone`로 나눈 구역별 40석을 4개씩(A~J행 × 4열) 청크해 그리드 렌더 — 좌석 생성이 행 우선(row-major) 순서라 4개씩 자르면 자연히 한 행이 됨. ~~`HoldTimer`는 구역 진입이 아니라 `SeatsView` 최초 마운트 시각 기준 5분 고정(뒤로가기 후 재진입해도 유지 — 실제 hold 세션 흉내).~~
- **2026-08-19 수정 (code-reviewer 지적 반영)**: 위 `HoldTimer` 마운트-시각 기준 설계가 버그였음이 드러남 — 좌석을 아직 확정(Confirm)하지 않았는데도 페이지 진입 즉시 5분 카운트다운이 시작되고, 정작 좌석 확정 후 `BookingView.tsx`는 `selectedAt`(확정 시각) 기준으로 다시 5분을 계산해 두 값이 어긋남(구역을 3분 둘러보다 확정하면 예매정보 페이지에서 타이머가 이어지지 않고 다시 5:00으로 리셋). PRD의 "선점 성공 시 5분 hold 시작" 원칙 위반이라 `SeatsView`에서 `HoldTimer`/`holdExpiresAt` state를 완전히 제거 — hold는 `saveSelectedSeat()`가 `selectedAt`을 기록하는 Confirm 클릭 시점에만 시작되고, 그 값을 `BookingView`/`PaymentView`가 그대로 소비하는 것이 유일한 기준점이 됨. 검증: `tsc`/`lint` 통과, Playwright MCP로 좌석맵 진입 시 타이머 미표시 → Confirm → `/booking`에서 `04:57`로 타이머가 새로 시작함을 확인, 콘솔 에러/경고 없음.
- **`Confirm Seat Selection`**: `selectedSeatId`가 있을 때만 활성화, 클릭 시 `lib/session-storage.ts`의 `saveSelectedSeat`로 저장 후 `/booking`으로 이동.
- **검증**: `npx tsc --noEmit`, `npm run lint` 통과. Playwright MCP로 `/seats` 시각 검증 — 구역 5개 부채꼴 배치 스크린샷 확인, Block C 진입 시 40석 3색 그리드+HoldTimer 렌더, 좌석 클릭 시 `pressed` 상태+"Confirm" 버튼 활성화, 뒤로가기 시 구역 선택으로 복귀(선택 상태 초기화), 재진입 후 좌석 선택→확인 클릭 시 `/booking`으로 이동 및 `sessionStorage["ticket-trainer:selected-seat"]`에 `{id:"A-3", row:"A", number:3, selectedAt:...}` 저장 확인. 콘솔 에러/경고 없음(최초 hydration mismatch는 파일 분리로 해결). 구역 미리보기 재작업 후에도 스크린샷으로 겹침 없는 배치·좌석맵 전환(Block B) 재확인.
- **후속 참고**: 검증 과정에서 생성된 스크린샷 4개(`seats-*.png`)와 `.playwright-mcp/` 디렉토리가 저장소 루트에 untracked 상태로 남아 있음 — 이 세션의 `rm` 권한이 거부되어 자동 정리하지 못했으므로, 커밋 전 수동 삭제 필요.
