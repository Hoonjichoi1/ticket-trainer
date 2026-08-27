# Task 012: 좌석 규모 확장

> 파일명은 `014-`로 시작하지만 ROADMAP.md 기준으로는 **Task 012**다. `012-`/`013-` 번호는 이미
> `tasks/012-result-report-feedback.md`, `tasks/013-integration-regression-testing.md`가 선점하고
> 있어, 같은 선례를 따라 `tasks/` 디렉토리의 다음 순번(014)을 파일명으로 쓰고 제목만 ROADMAP과
> 일치시켰다.

## 상태

- [ ] 진행 중
- [ ] 완료 — See: `docs/ROADMAP.md` Task 012 항목 업데이트

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

- [ ] SMALL/MEDIUM/MEGA 각각 2,500/7,000/15,000석 정확히 생성됨 (25×100, 70×100, 150×100)
- [ ] 행 라벨이 숫자 기반으로 표시되고, 좌석 표기가 자연스럽게 이어짐(예: "13행 5번")
- [ ] Zone 수가 티어별로 8/15/25로 나뉘고, zone당 좌석 수가 설계 표(313~600)와 일치
- [ ] `GET /api/seats`가 zone 파라미터로 스코프된 좌석만 반환(기존 전체 목록 방식 제거)
- [ ] MEGA 기준 zone-scoped poll 응답 크기가 개별 zone(~600석) 규모로 감소함을 확인(기존 전체 15,000석
      poll 대비)
- [ ] `SeatCell`에 `React.memo` 적용 후 불필요한 리렌더링이 감소함을 확인
- [ ] MEGA `botIntensity` 재튜닝 완료 — `scripts/tune-bot-intensity.ts`로 15,000석 풀 기준 평균
      `contentionLosses`가 목표(6) 근처(과도하게 못 미치지도, 항상 매진되지도 않는 수준)로 수렴
- [ ] SMALL/MEDIUM 기존 흐름(대기열, 좌석 선택, 결제 등) 회귀 없음
- [ ] 기존 테스트 스위트 전부 통과 + 타입 체크·린트 통과

## 구현 단계

1. [ ] `prisma/schema.prisma`: `SimulationConfig`에 `seatRows`/`seatsPerRow`/`zoneCount` 필드 추가
2. [ ] 마이그레이션 작성 및 적용 (기존 row 백필)
3. [ ] `prisma/seed.ts`: 티어별 값 반영
4. [ ] `app/api/session/route.ts`: seat-generation 파라미터화 + 행 라벨링 숫자 기반 전환
5. [ ] `lib/dummy-data.ts`: zone 계산 함수를 `zoneCount` 파라미터 기반으로 변경
6. [ ] `lib/seats.ts`/`app/api/seats/route.ts`: zone-scoped `GET` 구현
7. [ ] `app/seats/SeatsView.tsx`: 활성 zone 변경 시 재요청하도록 폴링 로직 변경
8. [ ] `app/components/SeatCell.tsx`: `React.memo` 적용
9. [ ] MEGA `botIntensity` 재실측·재튜닝 (`scripts/tune-bot-intensity.ts`, 15,000석 풀 기준) 후
      `prisma/seed.ts` + 로컬 dev DB 반영
10. [ ] 아래 테스트 체크리스트 전체 수행

## 테스트 체크리스트

### 단위 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [ ] `app/api/session/route.ts`: 티어별 `seatRows × seatsPerRow`만큼 정확히 좌석 생성됨
      (SMALL 2,500 / MEDIUM 7,000 / MEGA 15,000)
- [ ] 행 라벨이 숫자 기반으로 순서대로 생성됨(1~해당 티어 행 수)
- [ ] `getZoneForSeatNumber`/`groupSeatsByZone`: `zoneCount`별로 좌석이 설계대로 그룹핑됨(zone당
      좌석 수 검증)
- [ ] `listSeatMap`(zone 파라미터 지정 시): 해당 zone 좌석만 반환, 다른 zone 좌석 미포함
- [ ] `GET /api/seats?zone=X`: 정상 zone 스코프 응답 / zone 파라미터 누락·잘못된 값 시 에러 케이스
- [ ] 기존 좌석 클레임/hold 원자성 테스트(Task 009) 회귀 없음 — 좌석 수 확장 후에도 동일 통과
- [ ] MEGA `botIntensity` 재튜닝 값에 대한 `scripts/tune-bot-intensity.ts` 실측 결과가 기록됨(평균
      `contentionLosses`가 목표 근처)

### E2E 테스트 (Playwright MCP)

- [ ] SMALL/MEDIUM/MEGA 각 티어로 전체 플로우(홈 → 대기열 → 좌석 선택 → 예매정보 → 결제 → 결과) 진행,
      좌석맵이 정상 렌더링되는지 확인
- [ ] 좌석 선택 페이지에서 zone 선택 시 해당 zone만 요청되는지 네트워크 응답으로 확인(zone-scoped 응답
      크기가 전체 좌석 수가 아닌 zone 크기와 일치)
- [ ] MEGA 좌석 선택 화면에서 봇 경합(빠른 좌석 소진)이 체감되는지, 눈에 띄는 프레임 드랍/버벅임 없이
      2초 폴링이 매끄러운지 수동 확인
- [ ] SMALL 티어(2,500석) 흐름도 기존과 동일하게 문제없이 동작하는지 회귀 확인
- [ ] 에러/엣지 케이스: 존재하지 않는 zone 파라미터로 접근 시 처리, 좌석 선택 중 티어 간 전환(다시
      도전) 시 새 티어의 좌석 수/zone 구조로 정상 재생성되는지 확인

## 변경 사항 요약

> 작업 완료 후 작성. 신규 작성 시에는 비워둔다.
