# 0012. Discord 봇 "cost per follow" 질문 오답 수정

- 날짜: 2026-08-31
- 상태: 채택

## 맥락

오너가 "cost per follow가 $0.31인데 다른 광고 대비 퍼포먼스 어때?"라고 물었더니 봇이 "제공된 데이터에 상세 성과 지표가 없어 비교 불가능"이라며 캠페인 개수 집계만 보여주고 끝냈다. 오너는 "cost per follower가 없을리 없다"고 정확히 지적했고, 더 나아가 "방문자수는 어떻게 되는데요?" 같은 대안 제안형 대화를 원한다고 요청.

## 원인

1. **라우터가 잘못된 함수를 골랐다** — `social_campaigns`(`analytics_social_campaigns`)는 캠페인 목록·개수 집계만 반환하고 금액 데이터가 전혀 없는데, 라우터 프롬프트 설명이 "광고 캠페인 요약 (기간별 지출 대비 성과)"라고 되어 있어 실제 성과 함수인 `social_ads`와 구분이 안 됐다.
2. **`social_ads`조차 정확한 필드가 없었다** — spend·results는 있어도 "결과 1건당 비용"을 미리 계산해두지 않아, 설령 올바르게 라우팅됐어도 LLM이 직접 나눗셈해야 했다(신뢰 불가).
3. **답변 프롬프트가 너무 쉽게 포기했다** — 정확한 지표가 없으면 바로 "알 수 없다"로 끝냈고, 데이터 안의 가까운 대안(예: reach, 클릭)을 스스로 계산해서 제시하지 않았다.

## 결정

1. `analytics_dispatch`의 `social_ads` 케이스에 `cost_per_result`(spend/results) 필드 추가(`db/migrations/0015`). PAGE_LIKES 목적 캠페인은 results=페이지 좋아요(팔로우) 수라 이게 곧 "팔로우당 비용".
2. 라우터 프롬프트(`runtime/discord/src/index.ts`)에서 `social_campaigns`엔 "금액 데이터 없음"을 명시하고, `social_ads`엔 "cost per X 비교는 전부 이거"라고 명확히 구분.
3. 답변 프롬프트에 "정확한 지표가 없어도 대화를 끊지 말고, 데이터 안의 가까운 숫자로 직접 계산하거나, 없으면 구체적인 대안 지표를 먼저 제안하라"는 지시 추가.

## 결과 (사후 기록)

수정 후 `analytics_dispatch('social_ads', ...)`로 직접 확인: PAGE_LIKES 캠페인 5건의 실제 cost_per_result가 $0.3607~$0.7286 — 오늘 시작한 $0.31은 역대 최저(가장 효율적)다. `discord-bot` v9 배포 완료.
