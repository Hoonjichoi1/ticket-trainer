# Task 011: 대기열 초기 순번 동적 산정 (ROADMAP D-4)

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` D-4 항목 업데이트

## 개요

ROADMAP D-4: 대기열 초기 순번이 티어별 고정값(`SimulationConfig.virtualQueueSize`)이라 "오픈 정각에 얼마나
빨리 눌렀는지"가 전혀 반영되지 않는 문제 발견 → 오픈 시각 이후 경과 시간에 가상 유저 도착률
(`arrivalRatePerSec`, 신규 필드)을 곱한 동적 값으로 변경. 감소(admission) 로직은 `admissionRatePerSec`
그대로 유지. Task 007/008로 이미 완료·병합된 코드를 수정하는 post-hoc 변경.

**범위 경계**: `lib/simulation.ts`의 tick 계산 순수 함수(`computeQueuePosition` 등)와 `lib/tick.ts`의
`advanceTick`은 `initialPosition`을 완전히 불투명한 숫자로만 다룬다 — 어떻게 산정됐는지 전혀 모른다.
따라서 이 Task는 **`lib/queue.ts`의 `joinQueue` 한 곳**만 수정한다.

**설계 결정:**

- **`SimulationConfig.virtualQueueSize`를 완전히 제거**(유지하지 않음): 이 변경 후 앱 코드 어디서도 읽지
  않는 완전히 죽은 필드가 되기 때문. 아직 실 서비스 배포 전(시드 데이터만 존재)이라 컬럼 제거로 인한
  실사용자 데이터 리스크 없음. 사용자 승인 후 진행.
- **ROADMAP D-4 원문의 "영향 범위: `lib/types.ts`(`SimulationConfig` 타입)"는 부정확했음** — `lib/types.ts`에는
  `SimulationConfig`를 나타내는 손으로 작성한 타입이 애초에 존재하지 않는다. 모든 실사용처(`lib/queue.ts`,
  `lib/tick.ts`)는 `prisma.simulationConfig.findUniqueOrThrow(...)`로 Prisma 생성 타입을 그대로 쓰므로,
  `schema.prisma` 수정 + `prisma generate`만으로 타입이 모든 호출부에 자동 전파된다. `lib/types.ts`는
  수정하지 않았다.
- **경과시간 계산은 기존 `computeElapsedTime`(`lib/simulation.ts`) 재사용**, 신규 로직 없음 —
  `lib/queue.ts`가 이미 이 함수를 import하고 있었다. `computeElapsedTime({ since: run.concert.openAt, now })`
  는 음수 경과를 0으로 clamp하므로, `joinQueue`가 이미 `now < openAt`이면 `SALE_NOT_OPEN`으로 막고 있는
  것과 별개로 방어적으로 안전하다.
- **`QueueEntry.position`(`Int`)에 맞춰 `Math.round()`로 반올림** —
  `Math.round(config.arrivalRatePerSec * elapsedSinceOpen.seconds)`.
- **시드 데이터의 `arrivalRatePerSec`을 각 티어의 `admissionRatePerSec`과 동일 값(SMALL 5, MEDIUM 20,
  MEGA 50)으로 설정** — 순전히 테스트 편의 목적. 이렇게 하면 기존 테스트가 전제하던 "오픈 100초 뒤 조인 →
  SMALL 순번 500" 같은 깔끔한 숫자를 fixture의 `openAt`만 조정해서 그대로 재사용할 수 있었다. 실 서비스
  튜닝값이 아닌 placeholder라는 점은 기존 시드 값들과 동일.
- **`prisma/seed.ts`의 `Concert.openAt`을 고정 과거 날짜에서 시딩 시점 기준 상대 시각
  (`Date.now() + 5분`)으로 변경** — D-4 적용 후 고정 과거 `openAt`을 그대로 두면 실제 `npm run dev`로
  수동 테스트할 때 초기 순번이 "경과 시간(수 주) × arrivalRatePerSec" 규모로 천문학적으로 커져 대기열이
  사실상 영원히 안 풀리는 상태가 된다. 매번 시드를 새로 돌릴 때마다 합리적인 크기의 초기 순번이 나오도록
  수정. (D-7의 `POST /api/dev/timewarp`의 `openInMs`로도 우회 가능하지만, 시드 자체를 고쳐두는 편이 매번
  수동 호출이 필요 없어 더 근본적.)

## 관련 파일

- `prisma/schema.prisma` — `SimulationConfig`에 `arrivalRatePerSec Float` 추가, `virtualQueueSize Int` 제거 (수정)
- `prisma/migrations/20260823041701_simulation_config_arrival_rate/migration.sql` — 신규 마이그레이션.
  기존 3개 row에 `NOT NULL` 컬럼을 기본값 없이 추가할 수 없어(`prisma migrate dev`가 비대화형 환경에서
  중단됨), `--create-only`로 마이그레이션 파일만 만드는 표준 우회 대신 직접 SQL 작성: 컬럼을 nullable로
  추가 → `admissionRatePerSec` 값으로 백필(UPDATE) → `NOT NULL` 설정 → `virtualQueueSize` 컬럼 제거 (신규)
- `prisma/seed.ts` — `SimulationConfig.createMany`의 `virtualQueueSize` → `arrivalRatePerSec`, `Concert.openAt`을
  상대 시각으로 변경 (수정)
- `lib/queue.ts` — `joinQueue`: `position: config.virtualQueueSize` → `computeElapsedTime` +
  `Math.round(arrivalRatePerSec * elapsed.seconds)`로 계산한 `initialPosition` (수정)
- `lib/simulation.ts`, `lib/tick.ts` — 참고용(수정 없음): `initialPosition`을 불투명하게만 다룸, 확인 완료
- `lib/types.ts` — 참고용(수정 없음): `SimulationConfig` 타입이 애초에 존재하지 않음
- `lib/queue.test.ts` — `createRun()` 기본 `openAt`을 공통 `t0` 100초 전으로 변경(기존 assertion 값 보존),
  rejoin 테스트의 새 엔트리 초기 순번 값(500→550, 오픈 후 더 늦게 조인했으므로) 수정, D-4 핵심 동작(오픈
  직후 조인 시 순번 ≈0, 늦게 조인할수록 순번이 큼)을 직접 검증하는 신규 테스트 2건 추가 (수정)
- `app/api/queue/route.test.ts` — `createActiveRun()` 기본 `openAt`을 호출 시점 기준 100초 전으로 변경,
  실제 벽시계 오차를 감안한 근사 assertion으로 조정, "늦게 조인할수록 순번이 크다" 신규 테스트 1건 추가 (수정)
- `app/api/dev/timewarp/route.test.ts` — `virtualQueueSize`를 언급하던 stale 주석 정리, 동작 변경 없음
  (`joinQueueDirectly`가 `joinQueue`를 거치지 않고 `position`을 직접 지정하므로 이 변경과 무관) (수정)
- `docs/ROADMAP.md` — D-4 체크박스 갱신 + 원문의 부정확한 "영향 범위" 서술 정정 메모 추가 (수정)
- `docs/PRD.md` — **수정하지 않음**: Task 009/D-6 때 확립된 선례(원본 스펙 문서는 그대로 두고 ROADMAP의
  D-항목에 사후 결정을 레이어링)를 따름. `SimulationConfig` 필드 표의 `virtualQueueSize` 행은 이제 stale
  상태이나 의도적으로 손대지 않음.

## 선행 조건

- Task 007(tick 계산), Task 008(`joinQueue`/`pollQueue`), Task 010(D-7 dev-timewarp 유틸 — 실제 수동 검증에 활용)

## 수락 기준

- [x] `SimulationConfig`에 `arrivalRatePerSec` 추가, `virtualQueueSize` 제거 — 마이그레이션 적용 및
      Prisma Client 재생성 완료
- [x] `joinQueue`: 오픈 직후(경과 ≈0초) 조인 시 초기 순번 ≈0
- [x] `joinQueue`: 오픈 후 더 늦게 조인할수록 초기 순번이 비례해 커짐(같은 티어 내 두 세션 비교로 확인)
- [x] `joinQueue`: 조인 이후의 순번 감소(`admissionRatePerSec` 기반 decay)는 기존과 동일하게 동작
      (`pollQueue`/rejoin 테스트로 확인)
- [x] `lib/simulation.ts`/`lib/tick.ts` 무수정 확인 (git diff로 검증)
- [x] `lib/types.ts` 무수정 확인
- [x] 기존 테스트 스위트 전부 통과 + 신규 테스트 3건(단위 2건, 라우트 1건) 통과
- [x] 타입 체크·린트 통과
- [x] 로컬 dev DB 재시딩까지 완료해 새 스키마/시드가 실제로 반영됨을 확인 (파괴적 작업이라 사용자에게
      명시적 동의를 구한 뒤 `prisma migrate reset --force` 실행)

## 구현 단계

1. [x] `prisma/schema.prisma`: `arrivalRatePerSec Float` 추가, `virtualQueueSize Int` 제거
2. [x] `npx prisma migrate dev`가 비대화형 환경에서 기존 row 때문에 중단됨을 확인 → 마이그레이션 폴더/SQL을
      직접 작성(nullable 추가 → 백필 UPDATE → NOT NULL → DROP COLUMN) → `npx prisma migrate deploy`로 적용
3. [x] `npx prisma generate`로 Prisma Client 재생성 → `virtualQueueSize` 참조하던 호출부(`lib/queue.ts`,
      `prisma/seed.ts`)가 타입 에러로 드러남을 확인
4. [x] `prisma/seed.ts`: `arrivalRatePerSec` 값 추가, `Concert.openAt`을 상대 시각으로 변경
5. [x] `lib/queue.ts`: `joinQueue`에 `computeElapsedTime` + `Math.round` 기반 `initialPosition` 계산 추가
6. [x] `lib/queue.test.ts`, `app/api/queue/route.test.ts` fixture 조정 + 신규 테스트 추가
7. [x] `app/api/dev/timewarp/route.test.ts`의 stale 주석 정리
8. [x] 로컬 dev DB 초기화 — 사용자에게 명시적 동의를 구한 뒤(Prisma CLI 자체가 AI 에이전트의 `migrate reset`
      실행에 사용자 동의를 강제함) `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` 환경변수로 동의 텍스트를
      전달해 `prisma migrate reset --force` 실행, 이어서 `npx prisma db seed`로 재시딩
9. [x] 타입 체크·린트·전체 테스트 스위트 통과 확인 (타이밍에 민감한 대기열 테스트는 3회 연속 재실행해
      안정성 확인)
10. [x] `docs/ROADMAP.md` D-4 체크박스 갱신

## 테스트 체크리스트

### 단위/통합 테스트 (Vitest, 실제 테스트 DB 사용 — 모킹 금지)

- [x] `joinQueue`: 오픈 정각에 조인 시 초기 순번이 0
- [x] `joinQueue`: 오픈 5초 후 조인 vs 300초 후 조인 — 후자의 초기 순번이 더 큼(정확한 비례 값도 확인:
      SMALL 5/sec × 5s=25, × 300s=1500)
- [x] `joinQueue`: 재조인(rejoin) 시 새 엔트리의 초기 순번도 재조인 시점 기준 경과시간으로 다시 산정됨
      (이전 500 고정값이 아니라 550으로 변경됨을 확인 — 재조인이 10초 늦게 일어났으므로)
- [x] `joinQueue`/`pollQueue`: 조인 이후 decay(`admissionRatePerSec`)는 기존 그대로 동작
- [x] `POST /api/queue`: 라우트 레벨에서도 늦게 조인한 세션이 더 큰 초기 순번을 받음(두 세션 비교)
- [x] `GET /api/queue`: 조인 후 폴링 시 근사치로나마 기대한 초기 순번 근처에서 decay가 관찰됨

## 변경 사항 요약

- **플랜 대비 편차**: 플랜에서 예상했던 `npx prisma migrate dev`(대화형) 대신, 비대화형 셸에서 그
  명령이 즉시 거부되는 것을 발견해 마이그레이션 SQL을 직접 작성 후 `prisma migrate deploy`로 적용하는
  방식으로 전환했다(플랜에도 이미 이 우회 가능성을 대비해 SQL 백필 전략을 적어 뒀던 것과 동일한 접근).
- **파괴적 작업에 대한 사용자 승인 절차**: `prisma migrate reset --force`(로컬 dev DB 전체 삭제 후
  재적용+재시딩)를 실행하기 전 `AskUserQuestion`으로 명시적 동의를 구했다 — Prisma CLI 자체가 AI 에이전트의
  이런 파괴적 명령 실행에 사용자 동의를 요구하도록 설계돼 있었고(`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
  환경변수 메커니즘), 이 프로젝트의 안전 원칙과도 일치해 그대로 따랐다.
- **다음 Task로 미룬 것**: 없음 — 자기완결적인 변경.
- **리스크**:
  1. `arrivalRatePerSec`을 `admissionRatePerSec`과 동일 값으로 시딩한 것은 테스트 편의를 위한 임의
     선택이며, 실제 "도착이 입장 처리보다 빠르다"는 현실적 취켓팅 시나리오를 반영한 값은 아니다 —
     실제 서비스 튜닝 시(PRD가 명시하지 않은 placeholder 영역) 재검토 필요.
  2. `Math.round()`로 인해 극히 드물게(테스트 실행 환경이 매우 느려 실제 경과시간이 의도한 값보다
     0.1초 이상 밀리는 경우) 라우트 테스트의 근사 assertion 범위를 벗어날 이론적 가능성이 있다 — 3회
     연속 재실행으로 안정성은 확인했으나 완전히 배제된 것은 아니다.
  3. 시드 `Concert.openAt`을 "시딩 5분 뒤"로 바꿔, 시드 직후 바로 큐에 진입하면 아직 `SALE_NOT_OPEN`
     상태다 — 수동 테스트 시 D-7의 `POST /api/dev/timewarp`(`openInMs`)로 오픈 시각을 앞당겨야 함을
     인지할 것.
