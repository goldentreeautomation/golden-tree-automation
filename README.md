# Golden Tree

82 Bakeshop Ltd. (CozyHaus · Bon Sushi) 경영 데이터 및 AI 에이전트 시스템.

## 어디에 뭐가 있나

| 폴더 | 내용 |
|---|---|
| `CLAUDE.md` | 메인 지침. Claude Code가 매번 읽는다. 100줄 이내 유지 |
| `docs/golden-tree-design.md` | **전체 설계서.** 막히면 여기부터 본다 |
| `docs/contracts/` | Query Contract — 봇이 호출 가능한 함수 목록 |
| `docs/decisions/` | 왜 그렇게 정했는지 기록 |
| `docs/workflows/` | 워크플로우별 상세 (구현 시 설계서 2부에서 분리) |
| `docs/runbooks/` | 장애 대응 절차 |
| `.claude/agents/` | 빌더 에이전트 — 개발할 때만 동작 |
| `.claude/skills/` | 빌더가 쓰는 도구 |
| `db/` | 스키마·마이그레이션·Query 함수 |
| `sync/` | 외부 데이터 수집 (Supabase Edge Functions) |
| `runtime/` | 런타임 봇 — 클라우드에서 24시간 동작 |
| `web/` | 대시보드 (Next.js) |
| `output/` | 검증 리포트, 승인 대기 항목 (git 추적 안 함) |

## 에이전트 두 종류

헷갈리기 쉬우니 구분한다.

| | 빌더 에이전트 | 런타임 봇 |
|---|---|---|
| 위치 | `.claude/agents/` | `runtime/personas/` |
| 실행 | Claude Code (맥북) | Supabase (클라우드) |
| 시점 | 개발할 때만 | 24시간 |
| 하는 일 | 코드를 만든다 | 질문에 답한다 |

## 시작하기

VS Code로 이 폴더를 열고 터미널에서 `claude` 실행.

현재 진행 상황은 `CLAUDE.md` 맨 아래 "현재 상태" 표에 있다.

## 지금 상태

M1(데이터 기반) 1단계 완료 — 레포와 설계서 준비됨. 다음은 빌더 에이전트 정의.
