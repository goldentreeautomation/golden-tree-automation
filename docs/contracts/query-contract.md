# Query Contract

런타임 봇(Discord `/ask`, 대시보드, 시장 수요 예상 동기화)이 호출할 수 있는 DB 함수의 **전체 목록**이다. 이 목록에 없는 데이터 접근(raw SQL 등)은 금지된다 (CLAUDE.md 불변 규칙 #1).

## 규칙

1. 모든 함수는 읽기 전용(`STABLE`), `SECURITY DEFINER`로 실행되며 함수 밖에서 RLS를 우회하지 않는다
2. 대부분 `p_location_id` 파라미터를 받는다 (`NULL` = 전체 매장 합산). 예외는 표에 명시
3. 금액은 CAD, 소수점 2자리. "매출"은 별도 언급 없는 한 Net Sales(Gross−Discount, 세금·팁 제외) — CLAUDE.md 불변 규칙 #2·#3
4. 함수를 추가/변경할 때 이 문서와 실제 호출부(`runtime/discord/`, `web/dashboard-api/`)를 **동시에** 갱신한다
5. 새 함수는 상상해서 만들지 않는다. `output/unanswered.jsonl`에 쌓인 실제 질문 또는 대시보드 요구사항을 근거로 추가한다

## 호출 경로 2가지

| 경로 | 호출자 | 방식 |
|---|---|---|
| A. LLM 라우팅 | Discord `/ask` (`runtime/discord/`) | 자연어 질문 → Gemini가 `p_analysis` 값 선택 → **`analytics_dispatch` 하나만 호출** |
| B. 직접 호출 | `web/dashboard-api/`, `sync/market-demand/` | 코드가 필요한 `analytics_*` 함수를 이름으로 직접 호출(라우팅 없음) |

## A. `analytics_dispatch(p_analysis, p_start_date, p_end_date, p_location_id, p_limit, p_compare_start, p_compare_end, p_item_name)`

Discord 봇의 유일한 진입점. `p_analysis` 값에 따라 내부적으로 아래 함수 중 하나로 라우팅한다. 날짜 범위는 최대 730일(단, `social_campaigns`는 예외 없음).

| p_analysis | 내부 함수 | 용도 | 필수 파라미터 |
|---|---|---|---|
| `sales_summary` | `analytics_sales_summary_v2` | 기간·매장별 순매출 요약 | - |
| `location_sales` | `analytics_location_sales_v2` | 매장별 순매출(양쪽 매장 비교용) | - |
| `comparison` | `analytics_compare_periods` | 두 기간 비교(A vs B) | `p_compare_start`, `p_compare_end` |
| `top_items` | `analytics_top_items` | 판매 상위 품목 (맛/옵션별 순위) | - |
| `item_sales` | `analytics_item_sales` | 특정 **품목**(메뉴) 판매 추이 | `p_item_name` = 품목명 |
| `modifier_sales` | `analytics_modifier_sales` | 특정 **모디파이어**(오트밀크 등 추가옵션) 판매 추이, 사이즈별 분리 | `p_item_name` = 모디파이어명 |
| `hourly_sales` | `analytics_hourly_sales` | 시간대별 매출 | - |
| `daily_sales` | `analytics_daily_sales` | 일별 매출 | - |
| `monthly_sales` | `analytics_monthly_sales` | 월별 매출 | - |
| `customer_retention` | `analytics_customer_retention` | 재방문 고객 비율 | - |
| `category_sales` | `analytics_category_sales` | 카테고리별 매출 비중 | - |
| `social_sales_correlation` | `analytics_social_sales_correlation`(4-arg, `p_days_after=3` 고정) | 포스팅↔매출 상관관계, 발행일+1~3일 각각 같은 요일 4주 평균과 비교 | - |
| `post_item_trend` | `analytics_post_item_sales_trend`(`p_days_after=3` 고정) | 특정 포스팅 태그/캡션과 매칭되는 품목의 발행 후 판매 추이 | `p_item_name` |
| `social_posts` | (dispatch 내부 인라인 쿼리) | 포스팅 목록 + 최신 인게이지먼트 지표 | - |
| `social_campaigns` | `analytics_social_campaigns` | 광고 캠페인 목록·개수 집계 **(금액 데이터 없음)** | - |
| `social_ads` | (dispatch 내부 인라인 쿼리) | 캠페인별 집행 성과(지출·클릭·전환·CTR·CPC·**cost_per_result**) | - |
| `social_comments` | (dispatch 내부 인라인 쿼리) | 댓글 목록 + 감정 분류 | - |

**주의 — `p_location_id` 매칭 방식이 함수마다 다르다**: `location_sales`/`daily_sales` 등 매출 계열은 정확한 Square `location_id`(`LWEFT8C6SXJ7J`/`L7DA0MBKD2X4P`)만 받는다. 반면 `social_posts`/`social_ads`/`social_comments`는 **문자열 매칭**으로 매장을 추론한다(`p_location_id`가 `LWEFT8C6SXJ7J`/Instagram 계정ID/`"Bon Sushi"`면 Bon Sushi, `lower(p_location_id)`에 `"cozy"`가 들어 있으면 CozyHaus로 매칭) — 오타나 이름 변경 시 오배정 위험이 있음(`docs/decisions/0001` 버그 #1, 낮은 우선순위로 미수정 상태). 라우터 프롬프트(`runtime/discord/src/index.ts`)가 이 값을 정확한 Square location_id로 채우도록 유지해야 한다.

## B. 대시보드·동기화가 직접 호출하는 함수

Discord를 거치지 않고 백엔드 코드가 이름으로 직접 부른다.

| 함수 | 호출자 | 용도 |
|---|---|---|
| `analytics_location_sales_v2(p_start, p_end)` | `dashboard-api` | 완결된 과거 주 비교 |
| `analytics_location_sales_by_timestamp(p_start_ts, p_end_ts, p_location_id)` | `dashboard-api` | 진행 중인 주를 "저번주 같은 시각까지"와 정확히 비교(`docs/decisions/*` 2026-08-25) |
| `analytics_daily_sales`, `analytics_category_sales`, `analytics_top_items` | `dashboard-api` | 대시보드 카드 구성 |
| `analytics_market_demand_latest(p_location_id)` | `dashboard-api` | 오늘 시장 수요 예상 3구간 |
| `market_demand_baseline`, `market_demand_dow_profile` | `sync/market-demand` | 수요 예상 점수의 "과거 실적" 신호 계산 |

## C. 레시피 원가율 감시 (M3 조기 착수, 2026-08-25)

| 함수 | 용도 |
|---|---|
| `analytics_recipe_cost_overview(p_location_id)` | 활성 레시피별 현재 재료원가율·기준초과 여부·연속초과일수 |

`recipe_cost_current`(뷰)가 재료 단가 변경 시 실시간으로 원가율을 재계산한다. 상세 설계는 `docs/decisions/0011`(예정).

## 사용되지 않는(고아) 함수 — 계약에서 제외

아래는 DB엔 존재하지만 `analytics_dispatch`도, 대시보드도 호출하지 않는다. 레거시 또는 상위 버전으로 대체된 것들 — **새 코드에서 쓰지 말 것**. 정리(DROP)는 G4 대상이라 별도 승인 시 진행.

| 함수 | 대체된 것 |
|---|---|
| `analytics_location_sales(p_start_date, p_end_date)` | `analytics_location_sales_v2` (location 필터·refund_total 추가) |
| `analytics_sales_summary(p_start_date, p_end_date, p_location_id)` | `analytics_sales_summary_v2` |
| `analytics_social_sales_correlation(p_start_date, p_end_date, p_location_id)` (3-arg) | 4-arg 버전(`p_days_after`, `docs/decisions/0008`) |

## 명세 서식 (신규 함수 추가 시)

```
### 함수명

용도       한 줄 설명 (LLM이 이 설명을 보고 함수를 고른다)
파라미터   이름 · 타입 · 필수 여부 · 기본값
반환       필드명 · 타입 · 단위 · 세금/팁 포함 여부
주의       알아야 할 제약이나 함정
```
