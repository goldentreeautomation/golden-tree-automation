# ⚠️ GitHub Pages 프론트엔드 — 리다이렉트 전용으로 전환됨 (2026-09-11)

`docs/index.html`(매출 대시보드)과 `docs/stock.html`(재고 입력)은 **더 이상 실제 화면을
서빙하지 않는다.** Business OS의 canonical Edge Function으로 즉시 리다이렉트하는
얇은 페이지로 교체됐다(Business OS Stabilization Pass, `business-os` 저장소 참고).

- **매출 대시보드 canonical 주소:** `https://stfiazhmznssyfsiaxvw.supabase.co/functions/v1/dashboard`
  (소스: `business-os/supabase/functions/dashboard/`)
- **재고 입력 canonical 주소:** `https://stfiazhmznssyfsiaxvw.supabase.co/functions/v1/stock-entry`
  (소스: `business-os/supabase/functions/stock-entry/`)

## 왜 지금 바꿨나

1. **golden-tree-automation GitHub Pages가 production의 유일하게 남은 의존 지점**이었다 —
   Edge Function 자체는 이미 2026-09-10에 Business OS로 이전됐지만(`web/dashboard/MIGRATED.md`,
   `web/stock-entry/MIGRATED.md`), 그 함수를 **호출하는 정적 프론트엔드**는 여전히 이 공개
   GitHub Pages(`docs/`)에 이전 시점(9/6~9/8) 그대로 얼어 있었다.
2. **실제 보안 문제 발견**: `docs/stock.html`의 얼어붙은 버전은 공유 비밀번호
   (`STOCK_ENTRY_PASSCODE`)가 HTML 소스에 그대로 박혀 있었다 — 이 저장소는 공개
   저장소라(`private: false`) 누구나 페이지 소스 보기로 비밀번호를 볼 수 있는 상태였다.
   Business OS의 canonical 버전은 이미 서명 토큰 방식으로 전환됐지만(비밀번호가 HTML에
   없음), 이 GitHub Pages 사본만 옛날 방식 그대로 계속 공개돼 있었다.
3. 두 API(`dashboard-api`/`stock-entry-api`) 모두 이미 같은 Supabase 프로젝트
   (`stfiazhmznssyfsiaxvw`)를 가리키고 있어 백엔드는 문제 없었다 — 프론트엔드 호스팅만
   따로 놀고 있던 상태였다.

## 지금 상태

- `docs/index.html`, `docs/stock.html` 둘 다 **리다이렉트 전용**(meta refresh + 링크)으로
  교체됐다 — 기존 북마크/공유 링크는 계속 동작하지만 항상 최신 canonical 화면으로 보낸다.
- 예전 정적 HTML 전체(디자인·로직 포함)는 **이 커밋 이전의 git history에 그대로 남아있다**
  — rollback이 필요하면 `git show <이 커밋 이전 SHA>:docs/index.html` 등으로 복원 가능.
- **`golden-tree-automation` 저장소는 이제 rollback/reference 전용이다.** 새 개발은
  `/Users/petersong/business-os`에서만 진행한다(CLAUDE.md "Business OS로 이전 완료된 함수"
  섹션과 동일 원칙, 이번에 GitHub Pages까지 적용 범위를 넓혔다).

## 남은 보안 백로그(이번엔 처리 안 함, 별도 판단 필요)

`STOCK_ENTRY_PASSCODE` 값 자체는 위 발견 시점까지 공개돼 있었으므로 **원칙적으로는
노출된 값**이다. 다만 이 값은 현재 매장 직원이 근무 중 실시간으로 쓰고 있을 가능성이
있어, 사전 조율 없이 즉시 교체(rotate)하면 근무 중 접근이 끊길 수 있다 — 이번 pass에서는
리다이렉트로 유출 경로만 우선 차단했고, 실제 값 교체는 Peter의 판단(교체 시점/직원 공지)이
필요해 별도로 보고한다.
