# 0013. Discord 봇을 단일 함수 호출 → 멀티스텝 도구 호출(Gemini function calling)로 재구성

- 날짜: 2026-09-04
- 상태: 채택

## 맥락

세 가지 문제가 동시에 보고됨:

1. **인스타 포스트 날짜가 하루 밀림** — "8월 11일 릴스"라고 답했는데 실제로는 8/10 저녁(Regina) 게시물. `published_at`(UTC)의 날짜를 그대로 읽어서 자정 근처 게시물이 하루 밀렸다.
2. **매니저가 복잡한 질문을 못 함** — "5,6,7,8월 매출 비교 + 월별 최고/최저 매출일 + 날짜별 평균 + SNS 업로드 현황과 연관 분석" 같은 질문은 데이터 여러 종류(매출 + 소셜)를 조합해야 하는데, 기존 구조는 "질문 → JSON 플랜 1개 → `analytics_dispatch` 1번 호출 → 답변"으로 고정돼 있어 한 번에 하나의 조회만 가능했다.
3. **Gemini 무료 티어가 503(High demand)을 자주 반환** — 질문마다 실패해서 쓰기 어려움.

## 결정

### 1) 포스트/댓글 날짜 — Square와 같은 패턴으로 통일 (`0016`, `0017`)
`social_posts.published_date`, `social_comments.created_date`를 **generated column**(`(published_at at time zone 'America/Regina')::date`)으로 추가. 동기화 코드가 몰라도 DB가 항상 자동 계산 — Square의 `business_date` 변환과 동일한 철학. `analytics_dispatch`의 `social_posts`/`social_comments` 케이스가 이 필드로 필터링·반환하도록 수정.

### 2) 단일 호출 → 멀티스텝 도구 호출로 재구성
기존: `routerSystemPrompt`(JSON 모드, analysis 1개 선택) → `analytics_dispatch` 1번 → `answerSystemPrompt`(텍스트 생성) — 총 Gemini 호출 2번, DB 호출 1번, 고정.

신규: Gemini function calling(`tools: [{functionDeclarations: [query_data]}]`)으로 재구성. `query_data` 도구 하나만 노출하고, Gemini가 필요하다고 판단하는 만큼 **반복 호출**한다(최대 `MAX_TOOL_CALLS=5`). 예: 위 매니저 질문이면 `daily_sales`를 5~8월로 한 번, `social_posts`를 같은 범위로 한 번 호출해 두 결과를 모은 뒤 최종 텍스트로 종합.

**Query Contract는 그대로 지켜진다** — Gemini가 호출할 수 있는 도구는 `query_data` 하나뿐이고, 그 내부에서도 `analysis`는 `ALLOWED_ANALYSIS` 화이트리스트로 서버가 재검증한다(스키마의 enum과 별개로 실행 직전 재검증). 여러 번 호출을 허용해도 `analytics_dispatch` 밖으로는 못 나간다 — raw SQL 금지(CLAUDE.md 불변 규칙 #1)는 그대로.

### 3) Gemini 503 재시도
`callGeminiRaw()`에 503 전용 지수 백오프 재시도(최대 2회, 800ms→1600ms) 추가. 멀티스텝 호출로 Gemini 호출 횟수 자체가 늘어나므로(질문당 최대 5번) 재시도 없이는 실패율이 더 올라갈 위험이 있어 함께 처리.

## 근거

- 멀티스텝 도구 호출은 CLAUDE.md 2.0의 역할 분리("자연어 질문 → 호출할 함수 선택"은 원래도 LLM 몫)를 위반하지 않는다 — "한 번만 선택"이라는 제약이 없었을 뿐, 여러 번 선택하는 것도 같은 역할의 확장.
- raw SQL을 열어주는 대신 "이미 화이트리스트된 함수를 여러 번 조합해서 부르게" 하는 선택 — 비용·안전 통제(Query Contract)는 그대로 두고 표현력만 높였다.
- 무료 티어라 호출 횟수가 늘어도 금전 비용은 없음(설계 문서 제약 "런타임 비용 월 $20 이하"와 상충 안 함). 다만 503 빈도가 늘 수 있어 재시도를 필수로 같이 넣음.
- `published_date`를 generated column으로 만든 이유: 일반 컬럼이면 동기화 코드가 매번 채워야 하고, 빠뜨리면 같은 버그가 재발한다. DB가 항상 자동 계산하면 이 클래스의 버그가 구조적으로 불가능해진다.

## 결과 (사후 기록)

`discord-bot` v10 배포 완료. Gemini API 실제 키를 가져올 수 없어(Management API 시크릿 조회는 마스킹된 값만 반환) 로컬에서 end-to-end 테스트는 못 했고, 코드 리뷰와 공식 문서 스펙 대조로 검증함. **오너가 실제 Discord에서 원래 질문(매니저의 5~8월 비교+SNS 연관 분석)으로 테스트 필요** — 문제 있으면 바로 대응.
