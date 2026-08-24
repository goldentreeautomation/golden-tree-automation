# 0002. 대시보드를 Next.js 대신 정적 HTML + Edge Function으로

- 날짜: 2026-08-24
- 상태: 채택

## 맥락

`docs/golden-tree-design.md` 3.2는 `web/app/`에 Next.js로 INTERFACE 레이어를 만드는 것을 전제로 한다. 그런데 이 개발 환경(맥북)에 Node.js/npm이 설치돼 있지 않다 (`node`, `npx`, `brew` 전부 없음). Next.js는 빌드·배포 파이프라인이 필요해 지금 당장은 만들 수 없다.

## 검토한 선택지

| 선택지 | 장점 | 단점 |
|---|---|---|
| Next.js (원래 계획) | 설계서와 일치, 추후 확장 용이 | Node.js 설치 전까지 착수 불가 |
| 정적 HTML + Supabase Edge Function | 빌드 도구 불필요, 지금 바로 배포 가능, 서버리스 원칙에 더 부합 | 화면이 늘어나면 직접 짠 JS가 번거로워질 수 있음 |

## 결정

M1 범위(첫 대시보드 페이지)는 정적 HTML(순수 JS, 빌드 없음)로 만들고, Supabase Edge Function으로 서빙한다. Query Contract 원칙은 그대로 지킨다 — 브라우저가 DB에 직접 붙지 않고, `web/dashboard-api` Edge Function이 `analytics_*` 함수만 호출해 JSON을 내려준다 (service role key는 서버 쪽에만 있음, 브라우저에 노출 안 됨).

## 근거

- 지금 바로 오너가 쓸 수 있는 게 우선이다. Node.js 설치를 기다릴 이유가 없다
- "실행 주체는 Supabase, 맥북은 개발 전용" 원칙에 오히려 더 잘 맞는다 — 빌드 산출물 없이 소스가 곧 배포물이다
- 화면 수가 늘어나 정적 HTML이 부담되면 그때 Next.js로 옮긴다 (`docs/golden-tree-design.md` 4부 미결 사항에 추가)

## 결과 (사후 기록)

`web/dashboard-api`(JSON), `web/dashboard`(HTML) 두 Edge Function으로 M1 첫 대시보드 페이지 구현.
