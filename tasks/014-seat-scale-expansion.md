# Task 012: 좌석 규모 확장

> 파일명은 `014-`로 시작하지만 ROADMAP.md 기준으로는 **Task 012**다. `012-`/`013-` 번호는 이미
> `tasks/012-result-report-feedback.md`, `tasks/013-integration-regression-testing.md`가 선점하고
> 있어, 같은 선례를 따라 `tasks/` 디렉토리의 다음 순번(014)을 파일명으로 쓰고 제목만 ROADMAP과
> 일치시켰다.

## 상태

- [ ] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 012 항목 업데이트, D-16/D-17/D-18/D-19/D-20/D-21 신규 추가

## 개요

ROADMAP D-15: MEGA `botIntensity`를 `TIER_BENCHMARKS.maxContentionLosses`에 맞춰 역산하는 과정에서
좌석 수가 티어 무관 200석 고정이라는 구조적 한계가 드러났고(음의 초기하분포 특성상, 목표 손실 수에
도달하려면 봇이 첫 tick 안에 풀의 상당 비율을 소진해야 하는 좁고 위험한 구간만 존재), 좌석 수 대신
`botIntensity` 하나로만 티어 간 난이도를 차등화하는 데 한계가 있음이 확인됨. 이를 근거로 좌석 수 자체를
실제 콘서트장 규모로 티어별 차등 확장하기로 결정(전체 근거는 D-15 참조).

**목표 좌석 수** (D-15에서 확정):

| Tier | 좌석 수 | rows × seatsPerRow | Zone 수 | 좌석/zone |
|---|---|---|---|---|
| SMALL | 2,500 | 25 × 100 | 8 | 313 |
| MEDIUM | 7,000 | 70 × 100 | 15 | 467 |
| MEGA | 15,000 | 150 × 100 | 25 | 600 |

**설계 결정 (D-15에서 이미 확정, 여기서는 구현 관점으로 재정리):**

- **좌석 수/행 구성/zone 수를 `SimulationConfig`에 필드로 추가**해 티어 파라미터화한다 — `Seat` 모델
  자체(`row`/`number`)는 변경 불필요, 개수 제약이 없기 때문.
- **행(row) 라벨링을 숫자 기반(1, 2, 3...)으로 전환**한다 — 현재 대문자 알파벳 1글자(A~J, 최대 26행)로는
  MEDIUM 70행/MEGA 150행을 담을 수 없고, 숫자가 기존 "행 번호=무대 거리감" 의미를 그대로 보존하며 실제
  대형 경기장·한국 티케팅 관행("1층 13열")과도 부합.
- **`GET /api/seats`를 zone-scoped 응답으로 전환**한다 — 현재는 zone 분할과 무관하게 매 2초 폴링마다
  전체 좌석 목록을 반환하는 구조라, MEGA 15,000석이면 poll당 ~1MB. zone 파라미터로 스코프하지 않으면
  좌석 수 확장의 의미가 없어짐(DOM은 이미 활성 zone만 마운트하지만 네트워크/DB 비용은 그대로 총 좌석
  수에 비례하기 때문).
- **`SeatCell`에 `React.memo` 적용** — zone당 최대 600석(MEGA)까지 늘어나는 만큼, 매 poll마다 zone 전체가
  무조건 리렌더링되는 현재 방식은 불필요한 비용이 커짐.
- **MEGA `botIntensity` 재실측·재튜닝 필수** — `computeBotClaimCount`의 `claimCount = floor(botIntensity ×
  elapsedSeconds)`는 절대 좌석 수 단위라, 풀이 200→15,000으로 커지는 순간 기존 값(80)은 무효.
  `scripts/tune-bot-intensity.ts`를 그대로 재사용해 15,000석 풀 기준으로 재산정한다.
- **SMALL/MEDIUM의 `botIntensity`는 이번 Task 범위에서 조정하지 않는다** — D-15/2026-08-26 결정 유지.
  좌석 수만 확장하고 봇 강도는 그대로 두어도 두 티어의 "낮은 경합" 특성(평균 contentionLosses ≈ 0,
  `maxContentionLosses` 상한선을 넘지 않음)은 유지될 것으로 판단(D-15 참조). 실측으로 크게 벗어나면
  이 Task 안에서 재검토.

## 관련 파일

- `prisma/schema.prisma` — `SimulationConfig`에 `seatRows Int`, `seatsPerRow Int`, `zoneCount Int` 추가 (수정)
- `prisma/migrations/` — 신규 마이그레이션 (기존 3개 row 백필 필요, D-4/D-11 선례처럼 비대화형 환경에서
  `prisma migrate dev`가 막힐 수 있음 — SQL 직접 작성 후 `migrate deploy` 우회 가능성 염두) (신규)
- `prisma/seed.ts` — 티어별 `seatRows`/`seatsPerRow`/`zoneCount` 시드 값 반영 (수정)
- `app/api/session/route.ts` — 하드코딩된 `SEAT_ROWS`/`SEATS_PER_ROW` 상수를 `SimulationConfig`에서
  읽도록 파라미터화, 행 라벨링을 숫자 기반으로 전환 (수정)
- `lib/dummy-data.ts` — `getZoneForSeatNumber`/`groupSeatsByZone`이 `zoneCount`를 파라미터로 받도록 변경 (수정)
- `app/api/seats/route.ts` — `GET`에 `zone` 쿼리 파라미터 추가, zone-scoped 응답으로 전환 (수정)
- `lib/seats.ts` — `listSeatMap`에 zone 필터 옵션 추가 (수정)
- `app/seats/SeatsView.tsx` — 폴링을 활성 zone 기준 zone-scoped fetch로 변경 (수정)
- `app/components/SeatCell.tsx` — `React.memo` 적용 (수정)
- `scripts/tune-bot-intensity.ts` — MEGA 15,000석 풀 기준 재실측에 재사용 (참고, 필요 시 seat-count
  인자 추가 검토)

## 선행 조건

- Task 007(tick 엔진), Task 009(좌석맵·hold 원자성) — 이번 Task가 그 위에 zone 스코프만 얹음
- ROADMAP D-15 (좌석 확장 결정 및 근거)

## 수락 기준

- [x] SMALL/MEDIUM/MEGA 각각 2,500/7,000/15,000석 정확히 생성됨 (25×100, 70×100, 150×100)
- [x] 행 라벨이 숫자 기반으로 표시되고, 좌석 표기가 자연스럽게 이어짐(예: "13행 5번")
- [x] Zone 수가 티어별로 8/15/25로 나뉘고, zone당 좌석 수가 설계 표(313~600)와 일치
- [x] `GET /api/seats`가 zone 파라미터로 스코프된 좌석만 반환(기존 전체 목록 방식 제거)
- [x] MEGA 기준 zone-scoped poll 응답 크기가 개별 zone(~600석) 규모로 감소함을 확인(기존 전체 15,000석
      poll 대비) — 실측 응답 본문 ~51KB/zone(600석), 전체 15,000석 대비 zoneCount(25)분의 1 수준
- [x] `SeatCell`에 `React.memo` 적용 후 불필요한 리렌더링이 감소함을 확인 — 코드 레벨(memo + 안정된
      `onSelect` 참조) 확인. **주의**: 실제 프레임 드랍/버벅임에 대한 정량적 프로파일링은 수행하지
      않음(아래 "리스크" 참고)
- [x] MEGA `botIntensity` 재튜닝 완료 — `scripts/tune-bot-intensity.ts`로 15,000석 풀 기준 평균
      `contentionLosses`가 목표(6) 근처(과도하게 못 미치지도, 항상 매진되지도 않는 수준)로 수렴.
      **D-16으로 최초 재튜닝값(6000)이 실제 elapsed 조건에서 매진되는 결함을 발견해 200으로 재확정**
      (자세한 경위는 `docs/ROADMAP.md` D-16 참고)
- [x] SMALL/MEDIUM 기존 흐름(대기열, 좌석 선택, 결제 등) 회귀 없음 — timewarp 없는 실제 Playwright E2E로
      확인
- [x] 기존 테스트 스위트 전부 통과 + 타입 체크·린트 통과 (Vitest 202/202, `tsc --noEmit` 0 errors,
      `eslint` 0 errors/warnings)

## 구현 단계

1. [x] `prisma/schema.prisma`: `SimulationConfig`에 `seatRows`/`seatsPerRow`/`zoneCount` 필드 추가
2. [x] 마이그레이션 작성 및 적용 (기존 row 백필)
3. [x] `prisma/seed.ts`: 티어별 값 반영
4. [x] `app/api/session/route.ts`: seat-generation 파라미터화 + 행 라벨링 숫자 기반 전환
5. [x] `lib/dummy-data.ts`: zone 계산 함수를 `zoneCount` 파라미터 기반으로 변경 — **구현 중 `lib/seat-zones.ts`로
      이전(아래 "플랜에서 벗어난 부분" 참고)**
6. [x] `lib/seats.ts`/`app/api/seats/route.ts`: zone-scoped `GET` 구현
7. [x] `app/seats/SeatsView.tsx`: 활성 zone 변경 시 재요청하도록 폴링 로직 변경
8. [x] `app/components/SeatCell.tsx`: `React.memo` 적용
9. [x] MEGA `botIntensity` 재실측·재튜닝 (`scripts/tune-bot-intensity.ts`, 15,000석 풀 기준) 후
      `prisma/seed.ts` + 로컬 dev DB 반영 — **1차 재튜닝(6000)이 실제 elapsed 조건에서 결함(D-16)을
      드러내 스크립트 방법론 수정 후 200으로 재확정**
10. [x] 아래 테스트 체크리스트 전체 수행

## 테스트 체크리스트

### 단위 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `app/api/session/route.ts`: 티어별 `seatRows × seatsPerRow`만큼 정확히 좌석 생성됨
      (SMALL 2,500 / MEDIUM 7,000 / MEGA 15,000)
- [x] 행 라벨이 숫자 기반으로 순서대로 생성됨(1~해당 티어 행 수)
- [x] `getZoneForSeatNumber`/`groupSeatsByZone`(`lib/seat-zones.ts`): `zoneCount`별로 좌석이 설계대로
      그룹핑됨(zone당 좌석 수 검증) — `getZoneNumberRange`(SQL 스코핑용, 신규) round-trip 테스트 포함
- [x] `listSeatMap`(zone 파라미터 지정 시): 해당 zone 좌석만 반환, 다른 zone 좌석 미포함
- [x] `GET /api/seats?zone=X`: 정상 zone 스코프 응답 / zone 파라미터 누락·잘못된 값 시 에러 케이스
- [x] 기존 좌석 클레임/hold 원자성 테스트(Task 009) 회귀 없음 — 좌석 수 확장 후에도 동일 통과
- [x] MEGA `botIntensity` 재튜닝 값에 대한 `scripts/tune-bot-intensity.ts` 실측 결과가 기록됨(평균
      `contentionLosses`가 목표 근처) — D-16 참고, elapsed 스윕 방식으로 재측정

### E2E 테스트 (Playwright MCP)

- [x] SMALL/MEDIUM/MEGA 각 티어로 전체 플로우(홈 → 대기열 → 좌석 선택 → 예매정보) 진행, 좌석맵이 정상
      렌더링되는지 확인 — **결제/결과 단계는 Task 012 변경 범위 밖이라 재확인하지 않음(좌석 확정→
      `/booking` 진입까지만 확인)**
- [x] 좌석 선택 페이지에서 zone 선택 시 해당 zone만 요청되는지 네트워크 응답으로 확인(zone-scoped 응답
      크기가 전체 좌석 수가 아닌 zone 크기와 일치) — `?zone=N` 쿼리 확인, SMALL zone3=325석/MEDIUM
      zone8=490석/MEGA zone5=600석 모두 설계 표와 일치
- [x] MEGA 좌석 선택 화면에서 봇 경합(빠른 좌석 소진)이 체감되는지 확인 — 재튜닝(200) 후 zone 내
      `AVAILABLE`/`HELD` 혼재 확인(1차 재튜닝값 6000에서는 D-16 발견 당시 전체 매진). **눈에 띄는
      프레임 드랍/버벅임 없이 2초 폴링이 매끄러운지"는 정량적으로 프로파일링하지 않음 — 아래 "리스크"
      참고**
- [x] SMALL 티어(2,500석) 흐름도 기존과 동일하게 문제없이 동작하는지 회귀 확인
- [x] 에러/엣지 케이스: 존재하지 않는 zone 파라미터로 접근 시 처리(Vitest 단위 테스트로 확인 — zone
      누락/범위 초과 각각 400 `INVALID_ZONE`), 좌석 선택 중 티어 간 전환(다시 도전) 시 새 티어의
      좌석 수/zone 구조로 정상 재생성되는지 확인
- [x] **D-8(SessionResult 리셋) 상호작용**: 같은 브라우저 세션으로 SMALL → MEDIUM → MEGA 순서로 연속
      "다시 도전"하며 각 전환마다 zone 개수(8→15→25)와 zone 크기가 새 티어 값으로 정확히 재생성되고
      이전 티어 구조와 섞이지 않음을 확인(각 단계 스냅샷으로 검증)

## 변경 사항 요약

### 설계 결정 (선택지 + 채택 이유)

- **Seat.row 정렬 방식**: `orderBy: [{row:"asc"}]` 문자열 정렬 대신 `CAST(row AS INTEGER)`로 캐스팅한
  raw SQL 정렬 채택(`lib/seats.ts:listSeatMap`). 대안으로 `Seat.row`를 Int 컬럼으로 바꾸는 방법도
  있었으나, row는 표시용 라벨일 뿐이고 스키마 변경 범위가 커져 이번 Task 범위를 넘어선다고 판단해
  기각(사용자 확정 — D-16과 별개의 인시던트, 상세는 아래 "플랜에서 벗어난 부분" 참고).
- **Zone 선택 화면 UX**: zone별 실시간 잔여석 뱃지 제거, zone 번호만 표시하는 방식 채택. `GET
  /api/seats`가 zone 파라미터를 필수로 요구하고 전체 목록 응답을 완전히 제거하는 이상, 잔여석 뱃지를
  유지하려면 결국 전체 좌석을 다시 조회해야 해서 스코핑의 목적이 무의미해짐(대안이었던 "zone 요약
  엔드포인트 추가"는 사용자 확정으로 기각).
- **Zone 선택 UI 컴포넌트**: 기존 5-wedge SVG 부채꼴(고정 5구역 전용 삼각함수 좌표계)을 zone 개수(8~25)에
  따라 반응형으로 늘어나는 버튼 그리드로 교체. zoneCount가 최대 25까지 늘어나며 부채꼴 방식은 조각이
  너무 얇아져 라벨이 들어갈 공간이 없어짐.
- **MEGA `botIntensity` 최종값 200**: `claimCount = botIntensity × elapsed`가 무한 선형이라 "낮은
  elapsed에서 목표 근처"와 "높은 elapsed에서 매진 방지"를 동시에 만족하는 값은 존재하지 않음(자세한
  경위는 D-16) — saturation elapsed(`pool/botIntensity`=75초)가 실사용 elapsed 범위보다 충분히 위에
  오도록 낮추는 쪽을 선택.

### 플랜에서 벗어난 부분 (deviation)

- **zone 계산 로직을 `lib/dummy-data.ts`가 아닌 신규 `lib/seat-zones.ts`로 구현**: 원래 계획 문서는
  `lib/dummy-data.ts`의 `getZoneForSeatNumber`/`groupSeatsByZone`을 그대로 수정하는 것이었으나, Step 6
  구현 중 `lib/seats.ts`(실제 백엔드 로직)가 zone 범위 계산을 SQL 스코핑에 그대로 재사용해야 함을
  발견 — `dummy-data.ts`는 파일 상단 주석부터 "UI-only fixture data, not part of the deterministic
  simulation core"로 명시된 placeholder 파일이라, 실제 백엔드가 여기 의존하는 건 레이어링 위반이라
  판단해 별도 모듈로 분리(기계적 이동, 동작 변경 없음).
- **`Seat.row` 정렬 버그 발견 및 즉시 수정(계획에 없던 항목)**: Step 4에서 행 라벨을 알파벳(1글자)에서
  숫자 문자열로 바꾸면서, 기존 `listSeatMap`의 `orderBy: [{row:"asc"}]`(문자열 사전식 정렬)이 두 자리
  이상 행에서 깨지는 걸 구현 중 발견해 사용자 승인 하에 Step 6과 같은 범위에서 수정(위 "설계 결정"
  참고). 회귀 테스트 1건 추가(`lib/seats.test.ts`: row 9/10/11이 섞인 zone에서 숫자 순 반환 검증).
- **MEGA `botIntensity` 2단계 재튜닝**: 계획 문서는 "재실측 1회"만 상정했으나, 1차 결과(6000)를
  Playwright E2E로 검증하던 중 실제 elapsed 조건에서 100% 매진되는 것을 발견(D-16) — 튜닝 스크립트
  자체의 방법론 결함으로 판명돼 스크립트를 수정하고 200으로 재확정. SMALL/MEDIUM도 (코드 변경 없이)
  동일 방법론으로 재검증.
- **zone 선택 UI 재설계(SVG 부채꼴 → 버튼 그리드)**: 계획 문서에 명시적으로 없던 항목이나, zoneCount가
  8~25로 가변화되면서 기존 5-zone 전용 SVG 레이아웃이 구조적으로 대응 불가능해 불가피하게 포함(위
  "설계 결정" 참고).

### 다음 Task로 미룬 것 (deferred)

- `Seat.row`를 Int 컬럼으로 전환하는 근본적 정리(현재는 String 라벨 + SQL 캐스팅 정렬로 우회).
- MEGA 15,000석 규모에서의 실제 렌더링 성능/프레임 드랍 정량 프로파일링(아래 "리스크" 참고).
- 결제/결과 단계(Task 012 변경 범위 밖)의 재회귀 테스트 — 이번 E2E는 좌석 확정→`/booking` 진입까지만
  확인.

### 스스로 리스크가 있다고 판단하는 지점

- **`SeatCell`의 `React.memo` 효과를 정량적으로 검증하지 않음**: `onSelect`를 `useCallback`으로
  안정화해 이론적으로는 memo가 동작해야 하나, 실제 리렌더 횟수 감소를 React DevTools Profiler 등으로
  측정하지 않았음. MEGA 600석/zone 규모에서 체감 버벅임이 있다면 후속 확인 필요.
- **`claimCount = botIntensity × elapsed` 선형 모델 자체의 구조적 한계**: D-16에서 드러났듯, 이 공식은
  elapsed가 커질수록 무조건 매진되는 "절벽"이 존재함(캡이나 감쇠가 없음). 이번엔 MEGA의 saturation
  elapsed를 실사용 범위보다 충분히 위로 옮기는 방식으로 완화했지만, 근본적으로 "이상치로 아주 느리게
  들어온 사용자"는 여전히 매진을 만날 수 있음 — 공식 자체를 캡이 있는 형태로 바꾸는 건 이번 Task
  범위를 넘어선다고 판단해 다루지 않음.
- ~~`runSeatMapTick`이 봇 클레임을 순차적(seat-by-seat) DB 트랜잭션으로 처리~~ — **D-20에서 해결됨**
  (`claimSeatsBatch`, `FOR UPDATE SKIP LOCKED` 기반 단일 왕복 배치 UPDATE로 전환, 23.6초 → 1.7~3.2초).
- **`prisma.$queryRaw`로 SQL 인젝션 표면이 늘어남**: `lib/seats.ts:listSeatMap`이 raw SQL을 새로 도입
  (`row`를 정수로 캐스팅하기 위함). 값은 모두 Prisma의 태그드 템플릿 파라미터 바인딩으로 전달되고
  문자열 접합이 없어 인젝션 위험은 없다고 판단하나, raw SQL 사용 자체가 늘었다는 점은 기록해 둠.

## 완료 보고 이후 추가 수정 (D-17~D-20)

실제 브라우저 플레이(MEGA 티어) 중 사용자가 발견한 3건(D-17~D-19)과, 그 검증 과정에서 드러난
`GET /api/seats` 지연 문제(D-20)를 처리. 각 건의 발견 경위·원인·결정은 `docs/ROADMAP.md`
D-17~D-20 참고. 여기서는 요약만 기록.

1. **D-17 (zone 2D 밴딩)**: zone 분할이 number(좌우) 1차원 기준이라 MEGA에서 zone당 4열×150행짜리 세로
   스트립이 되던 문제. `lib/seat-zones.ts`를 row+number 2차원(거리대 band × 좌우 split)으로 재작성,
   zoneCount를 정사각형에 가장 가까운 bands×splits로 인수분해(SMALL 2×4, MEDIUM 3×5, MEGA 5×5).
   스키마/마이그레이션 변경 없음, `GET /api/seats` 응답 shape 변경 없음.
2. **D-18 (MEGA botIntensity 재재확정, 200→220)**: D-16에서 "매진 안 됨"만 검증하고 평균
   `contentionLosses`가 목표(6)에 근접하는지는 검증하지 않았던 gap을 실사용 피드백으로 발견. N=30,
   elapsed 0~60초 스윕으로 재측정해 220으로 재확정(60초 지점 평균 4.87, 매진 0%). "평균 6 근접"과
   "매진 0%"가 이 선형 모델 하에서 동시에 만족 불가능함을 수학적으로 확인(수락 기준 재검토 시
   참고할 것).
3. **D-19 (좌석 라벨 구분자)**: `${row}${number}` 무구분자 concat이 서로 다른 좌석을 같은 라벨로
   표시하던 버그. `SeatCell`은 `row-number`, `BookingView`/`PaymentView`는 `Row {row}, Seat {number}`로
   수정. 회귀 테스트 `app/components/SeatCell.test.tsx` 신규.
4. **D-20 (봇 클레임 배치 UPDATE 전환)**: D-18 검증 중 `GET /api/seats`가 elapsed=60s·MEGA
   `botIntensity=220` 조건에서 23.6초 걸리는 걸 실측 — `runSeatMapTick`이 봇 클레임(claimCount, 최대
   13,200)을 `claimSeat()` 순차 호출로 하나씩 처리하던 게 원인. `claimSeatsBatch()` 신설
   (`SELECT ... FOR UPDATE SKIP LOCKED` + 단일 `UPDATE ... RETURNING`, Hold도 `createMany`로 일괄
   INSERT)로 DB 왕복을 claimCount번 → 1번으로 축소. 사용자 개별 클릭 경로(`claimSeat`, F006)는
   변경 없음 — 기존 "bot-vs-user contention" 동시성 회귀 테스트가 SKIP LOCKED의 안전성을 그대로 검증.
   **동일 시나리오 재측정: 23.6초 → 1.7~3.2초(약 10배 개선)**.
   - **`POST /api/session`의 P2028 타임아웃도 같은 뿌리인지 재확인**: 유휴 상태에서 MEGA 세션 생성만
     10회 반복 실측 → 1.1~2.3초(평균 1.4초), 5초 타임아웃 대비 여유 충분. `createMany` 자체가 느린 게
     아니라 **진짜 동시 DB 부하(dev 서버+테스트+스크립트가 로컬 Postgres 커넥션을 동시 점유)에서만
     발생**하는 별개 현상임을 확인 — 이번엔 이 결론만 재확인하고 커넥션 풀 크기 조정 등은 범위 밖이라
     손대지 않음(`lib/prisma-adapter.ts`가 `pg.Pool` 기본값(max=10)을 그대로 사용 중이라는 점은 기록).
5. **D-21 (봇 클레임 모델을 선형 → 프론트로딩형 지수 곡선으로 전면 재설계)**: "zone이 매진되면 안
   된다"는 기존 전제를 뒤집는 결정 — 실제 티케팅은 오픈 직후 몇 초가 가장 치열하고 이후 완만해지는데
   기존 선형 모델은 정반대였음. `computeBotClaimCount`를 `targetClaimed(t)=floor(poolSize×(1-e^(-k×t)))`
   (t=`queueOpenAt` 기준 경과초) 절대 목표 곡선으로 교체, `botIntensity`→`botCurveK`로 rename(마이그레이션).
   `lib/tick.ts`의 `lastTickAt` carry-forward 메커니즘 전면 제거(더 이상 필요 없음 — 절대 목표 모델은
   tick 이력과 무관하게 결정론이 성립). 티어별 곡선 기울기(k)도 별도 튜닝: SMALL 0.0027/MEDIUM
   0.0085/MEGA 0.034(1차 제안값, 사용자 확정 대기). 상세 실측표·테스트 재작성 내역·E2E 검증 결과는
   `docs/ROADMAP.md` D-21 참고.

**이번 라운드에서 새로 발견했지만 범위 밖이라 미해결로 남긴 것**:

- Playwright의 `browser_take_screenshot`/`element screenshot`이 이번 세션 환경에서 "waiting for fonts
  to load" 단계에서 무한 대기하는 도구 자체 버그를 발견(빈 페이지에서도 재현, 앱 코드와 무관). Claude
  in Chrome도 미연결이라 대체 불가 — 이번 라운드의 시각적 검증은 스크린샷 대신 접근성 스냅샷의 픽셀
  bounding box 실측치로 대체함.
- `lib/prisma-adapter.ts`가 커넥션 풀 크기를 명시하지 않아 `pg.Pool` 기본값(max=10)을 그대로 사용 —
  동시 부하 상황(개발 중 여러 프로세스가 동시에 로컬 Postgres를 쓰는 경우)에서 커넥션 경합이 재발할
  여지가 남아 있음. 프로덕션은 Neon pooled connection을 쓰므로 영향이 다를 수 있으나 별도 검증 필요.
  지금은 로컬 동시 부하에서만 재현됐지만, 프로덕션 Vercel serverless 환경에서도 짧은 시간에 여러
  요청이 같은 풀을 공유하는 유사 패턴이 발생할 수 있음 — **Task 013(Vercel 배포, Neon pooled
  connection 프로덕션 부하 검증)에서 반드시 재검토 필요**. 자세한 내용은 `docs/ROADMAP.md` D-20 참고.
- ~~D-21로 동시성 보장이 약화됨(알려진 트레이드오프)~~ → **D-22에서 실측 후 수정 완료.** "영향
  제한적"이라던 판단은 실측 없이 내린 추정이었음이 확인됨(사용자 지적) — 실제로는 React Strict Mode
  이중 호출만으로 zone 진입마다 재현되는 흔한 경로였고, MEGA 실측 결과 최대 2배(elapsed=20s: 목표
  7,400 vs 실제 14,800) 초과 클레임 확인. D-13과 같은 락 패턴을 적용(`advanceTick`+`claimSeatsBatch`를
  하나의 트랜잭션으로 합쳐 SimulationRun 락이 전 구간을 커밋까지 물게 함)해 수정, 재실측으로 초과
  클레임 0 확인. 상세는 `docs/ROADMAP.md` D-22 참고.
- `SimulationRun.lastTickAt`이 D-21 이후 계산에서 전혀 읽히지 않아 사실상 죽은 컬럼이 됨 — 스키마
  제거는 이번 요청 범위(계산식 변경) 밖이라 미루고 필드만 남겨둠. 향후 스키마 정리 과제 후보.
- ~~`lib/result.ts`의 `TIER_BENCHMARKS.maxContentionLosses`가 D-21 이후 재검토되지 않음~~ →
  **D-22에서 실측 완료.** 실제 사용자 클레임 시도 기준(폴링 간 경쟁 재현)으로 elapsed 0~500초 전
  구간 실측한 결과 contentionLosses는 거의 항상 0, 드물게 1이었고 현재 임계값(1/3/6)을 넘은 사례
  없음 — 발동될 때 보여주는 숫자 자체가 오도되진 않으므로 후속 작업 등록 없이 확인 완료로 종료. 상세는
  `docs/ROADMAP.md` D-22 참고.
- 이번 대화에서 제안한 `botCurveK` 값(SMALL 0.0027/MEDIUM 0.0085/MEGA 0.034)은 방향에 맞춘 1차
  제안값으로, 사용자가 실측표를 보고 최종 확정하지 않았다면 아직 잠정치임.
- D-22 검증용 임시 스크립트(`scripts/_concurrency-probe-tmp.ts`,
  `scripts/_contention-losses-probe-tmp.ts`)는 `_perf-probe-tmp.ts`와 동일하게 사용자가 직접 정리할
  예정이라 그대로 남겨둠.
