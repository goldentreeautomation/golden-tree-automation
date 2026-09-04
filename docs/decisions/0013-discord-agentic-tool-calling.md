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

`discord-bot` v10 배포 후 오너 실제 테스트로 오류 2건을 순차 발견·수정(둘 다 문서화 안 된 `gemini-3.6-flash` thinking 모델 고유 동작이라 실제 호출해보고서야 알 수 있었음):

1. `400 INVALID_ARGUMENT — Role 'function' is not supported`. 유효 role에 `FUNCTION`이 없고 `USER`만 있음 — function response 턴 role을 `"user"`로 수정(v11).
2. `400 — Function call is missing a thought_signature`. thinking 모델은 functionCall part에 `thought_signature`를 같이 실어 보내는데, `functionCall` 필드만 뽑아 대화 기록을 재구성하면서 유실시켰음 — 모델이 준 content를 통째로 그대로 돌려주도록 수정(v12).

이후 재테스트 결과는 오너 확인 대기.

2026-09-04, 자체 시행착오 능력 추가(오너 요청 — "문제발생→해결→재시도가 챗봇 안에서 되면 좋겠다"):
도구 호출이 실패해도(잘못된 파라미터, 유효성 검사 실패 등) 대화를 바로 끊지 않고, 실패 이유를
`error` 필드로 Gemini에게 그대로 돌려준다. 시스템 프롬프트에 "에러를 보고 파라미터를 고쳐서
다시 시도하라"는 지시를 추가해, 사람 개입 없이 대화 한 번 안에서 스스로 시행착오를 겪을 수 있게
했다(v13). `MAX_TOOL_CALLS`도 5→6으로 늘려 재시도 여유분 확보.

**한계를 오너에게 명확히 설명함**: 이건 "대화 중 판단 실수"만 해결한다. 이번에 겪은 role/
thought_signature 같은 "내 코드 자체의 프로토콜 오류"는 챗봇이 스스로 자기 서버 코드를 고쳐
쓸 방법이 없어(그렇게 설계하지 않음 — 안전상 의도적) 여전히 사람(Claude Code)이 코드를 고치고
재배포해야 한다. 파인튜닝도 이런 문법 오류엔 도움이 안 됨(판단력 문제가 아니라 순수 형식 오류라서).

## 세 번째 발견: 포스트 내용 환각(hallucination) — 2026-09-04

오너가 "코지하우스 5~8월 매출 비교 + SNS 연관성 분석"을 실제로 물었더니 매출 숫자는 정확했는데
**포스트 내용(캡션·주제)이 전부 지어낸 것**이었다 — 5/10 "어버이날 타르트"(실제: Mother's Day
티라미수 컵, 타르트 언급 없음), 6/18 "말차 라떼"(실제: 홍콩 파인애플 번), 7/9 "크루아상"(실제:
쿠키퍼프 — 크루아상은 7/10), 7/28 "빙수"(실제: 드링크 포스팅, 빙수 언급 자체 없음), 8/14 "크로플
BOGO 50% 할인 포스트"(**그날 게시물 자체가 DB에 없음 — 완전 fabrication**).

DB를 직접 조회해 확인: `social_posts` 테이블의 캡션·날짜는 전부 정확했다. 즉 데이터 파이프라인
버그가 아니라, Gemini가 "최고 매출일을 설명하는 그럴듯한 이야기"를 최종 답변 작성 단계에서
지어낸 것 — 도구가 준 실제 caption을 무시하고 서사에 맞게 내용을 재구성했다.

**결정**: 시스템 프롬프트에 강한 그라운딩 규칙 추가(v14, v15) —
1. 포스트 내용은 반드시 도구가 돌려준 caption 원문에서만 인용/요약. 지어내거나 각색 금지
2. 해당 날짜에 post_id가 없으면 "게시물 없었다"고 명확히 말하기 — 있었다고 지어내는 게 최악
3. 포스트를 언급할 땐 반드시 post_id를 괄호로 병기 — 스스로 검증하게 만드는 장치, 오너도 바로 대조 가능
4. 포스팅 이후 매출 추이 질문엔 항상 day_offset 0~3 전부 표시(당일만 보여주지 않기, 오너 요청)

프롬프트 지시만으로 환각을 100% 막을 수 있다는 보장은 없다 — 반복 사용하면서 계속 확인 필요.
post_id 병기 요구가 사후 검증(오너가 캡션 대조)을 쉽게 만드는 게 실질적인 안전판.

## 네 번째 발견: 포스트 사진/영상 AI 설명 추가 + CozyHaus 소셜 조회 무응답 버그

오너가 "캡션이 애매하면 사진을 직접 보고 판단할 수 없냐"고 질문. 확인 결과 `social_posts.media_url`은
Instagram의 서명된 임시 링크라 며칠 지나면 만료됨(실측: 4개월 전 포스트 403). 결정(오너, "앞으로
그렇게 하고 이미 지난거는 놔둬"): 과거 포스트는 소급 안 하고, 앞으로 올라오는 포스트만 발행 직후
Gemini Vision으로 설명을 뽑아 영구 저장.

구현: `social_posts.ai_visual_description`(text) 추가(`0018`) — REELS는 `thumbnail_url`(정지
이미지), FEED는 `media_url`을 Gemini Vision에 보내 한국어 설명 생성, `sync/meta`가 매 실행 시
이미 설명이 있는 포스트는 재분석 안 함(idempotent). `analytics_dispatch`/상관관계 함수들에
필드 노출, 봇 프롬프트엔 "캡션이 우선, 이건 보조"로 명시(`0019`).

이 작업 중 **완전히 별개인 실제 버그를 발견**: `social_posts`/`social_ads`/`social_comments`가
CozyHaus를 `lower(p_location_id) like '%cozy%'`로 판단하는데, 이건 캠페인명이 아니라 **호출자가
넘긴 파라미터 자체**에 "cozy"가 들어있는지를 보는 조건이었다. Discord 봇은 실제 Square
location_id(`L7DA0MBKD2X4P`)를 넘기므로 이 문자열엔 "cozy"가 없어 **CozyHaus를 지정한 모든
소셜/광고 질문이 처음부터 조용히 빈 결과를 주고 있었다**(0001 버그 #1, 낮은 우선순위로 방치돼
있던 것이 실제로 재현·확인됨). Bon Sushi와 같은 패턴(실제 location_id/계정ID/이름 명시 목록)으로
수정(`0020`), 테스트로 CozyHaus 포스트/광고가 정상 반환됨을 확인.

`meta-sync` v6, `discord-bot` v16 배포. 3일치로 실사용 테스트 — 이미지 포스트 3건 중 2건 정상
설명 생성 확인(1건은 thumbnail 없음 등으로 null, 안전하게 저하).
