# Task 001: 프로젝트 구조 · 라우팅 · 테스트 환경 설정

## 상태

- [x] 진행 중
- [x] 완료 — See: `docs/ROADMAP.md` Task 001 항목 업데이트

## 개요

Phase 1(애플리케이션 골격 구축)의 첫 작업. 홈 → 대기열 → 좌석 → 예매정보 → 결제 → 결과로 이어지는 선형 플로우의 라우트 껍데기와 API 라우트 구조, Vitest 테스트 환경을 만든다. 전 기능(F001~F014)의 선행 인프라.

## 관련 파일

- `app/page.tsx` — 홈 (신규 수정)
- `app/queue/page.tsx` — 대기열 (신규)
- `app/seats/page.tsx` — 좌석 선택 (신규)
- `app/booking/page.tsx` — 예매 정보 (신규)
- `app/payment/page.tsx` — 결제 (신규)
- `app/result/page.tsx` — 결과 리포트 (신규)
- `app/api/session/route.ts` — 세션 (신규, 빈 핸들러)
- `app/api/queue/route.ts` — 대기열 (신규, 빈 핸들러)
- `app/api/seats/route.ts` — 좌석 (신규, 빈 핸들러)
- `app/api/booking/route.ts` — 예매 (신규, 빈 핸들러)
- `app/api/payment/route.ts` — 결제 (신규, 빈 핸들러)
- `app/layout.tsx` — 루트 레이아웃 (메타데이터 포함, 수정)
- `vitest.config.ts` — Vitest 설정 (신규)
- `package.json` — `test` 스크립트 추가 (수정)

## 선행 조건

없음 (Phase 1 최초 작업)

## 수락 기준

- [x] 선형 플로우 6개 페이지(`/`, `/queue`, `/seats`, `/booking`, `/payment`, `/result`)가 각각 빈 껍데기로 라우팅되고 서로 이동 가능
- [x] API 라우트 5개(`session`, `queue`, `seats`, `booking`, `payment`)가 빈 핸들러로 존재하고 Next.js 16 route handler 시그니처를 따름
- [x] `app/layout.tsx`에 기본 메타데이터가 설정됨
- [x] `npm run test` 실행 시 Vitest가 정상 동작 (샘플 테스트 1개 통과)
- [x] 테스트 DB 연결 헬퍼가 준비되어 있음 (Task 006 이후 실제 연결 정보만 채우면 되는 상태)

## 구현 단계

1. [x] Next.js 16 route handler 시그니처를 `node_modules/next/dist/docs/`에서 확인
2. [x] 페이지 라우트 6개 생성 (빈 껍데기, 다음 단계로 이동하는 네비게이션 링크만 포함)
3. [x] API 라우트 5개 생성 (빈 핸들러, TODO 주석으로 향후 구현 지점 표시)
4. [x] `app/layout.tsx`에 메타데이터(title, description) 추가
5. [x] Vitest 설치 및 `vitest.config.ts` 작성
6. [x] 테스트 DB 연결 헬퍼 스텁 작성 (연결 정보는 Task 002/006에서 채움)
7. [x] `package.json`에 `npm run test` 스크립트 추가
8. [x] 샘플 테스트 1개 작성 후 통과 확인

## 변경 사항 요약

> 6개 선형 플로우 페이지(`/`, `/queue`, `/seats`, `/booking`, `/payment`, `/result`)와 5개 API 라우트 빈 핸들러(`session`, `queue`, `seats`, `booking`, `payment`, 모두 `501 not_implemented` 응답)를 생성했다. 각 페이지는 공유 컴포넌트 없이 독립적인 서버 컴포넌트로 작성 — 세션/상태가 아직 없어 공유 레이아웃의 형태를 지금 추측하지 않기 위함. `app/layout.tsx` 메타데이터를 프로젝트명으로 교체했다. Vitest(`jsdom` + `globals: true`)를 설치하고 `lib/test-db.ts` 스텁(Task 002/006 전까지 호출 시 throw)과 샘플 테스트 2건을 작성해 `npm run test`, `npm run lint`, `npm run build`가 모두 통과함을 확인했다. `package.json`은 전역 권한 설정상 직접 Edit이 금지되어 있어 `npm pkg set`으로 `test` 스크립트를 추가했다.
