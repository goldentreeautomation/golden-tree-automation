# 0001. 레거시(n8n) Square 데이터·함수 검증

- 날짜: 2026-08-23
- 상태: 채택 (핵심 수정 적용·검증 완료, 잔여 항목 있음)

## 맥락

이 레포(Golden Tree)는 오너가 ChatGPT + n8n으로 진행했던 선행 시도를 대체하기 위해 새로 시작한 것이다 (`docs/golden-tree-design.md` 1.1). 그런데 **같은 Supabase 프로젝트(`stfiazhmznssyfsiaxvw`)를 그대로 물려받았고**, 그 안에는 n8n 시절 만든 테이블 68,161건의 주문 데이터와 20개 이상의 `analytics_*` 함수가 이미 존재한다. `db/migrations/`, `sync/square/`에는 이 데이터를 만든 코드가 하나도 없다 — 전부 n8n 워크플로(JSON) 안에 있었고 지금은 보이지 않는다.

오너가 과거 Discord 봇 사용 중 겪은 오류 16건을 제시했다. "이미 해결됐다고 가정하지 말고 재검증하라"는 지시에 따라 현재 라이브 데이터와 함수 소스를 직접 조회해 하나씩 재현했다.

## 검증 결과

| # | 오류 | 판정 | 근거 |
|---|---|---|---|
| 1 | 지점 매핑 오류 | **부분 확인** | `locations` 매핑 자체(L7DA0MBKD2X4P=CozyHaus, LWEFT8C6SXJ7J=Bon Sushi)는 정상. 단 `analytics_dispatch`의 소셜 광고/게시물 라우팅은 계정ID 대신 캠페인명 문자열(`ilike '%cozy%'`)로 매장을 추론 — 오타·이름변경 시 오배정 위험 있음 |
| 2 | 매출 정의(Gross/Net 혼용) | **완전 확인 — Square API 원본 대조로 종결** | Square Orders API로 2026-08-08 원본 주문을 직접 계산: Bon Sushi net_sales=$5,451.69(오너 참고값 $5,451.73과 일치), CozyHaus **gross**_sales=$1,922.56(오너 참고값 $1,922.52와 일치, net은 $1,908.24로 다름). 즉 두 매장에서 서로 다른 필드를 비교하고 있었던 것 — 시스템 버그가 아니라 과거 대조 기준 자체가 어긋났던 것. `analytics_location_sales_v2`의 `CozyHaus만 gross 사용` 하드코딩은 이 잘못된 대조에 맞춰 끼워 넣은 것으로 확정. 앞으로는 두 매장 모두 규칙 #2(Net Sales=Gross-Discount)로 통일 |
| 3 | 할인·환불 중복 차감 | **미확정** | `orders.net_sales`는 n8n이 계산해 그대로 upsert된 값이라 DB 안에서 산식을 재현할 수 없음. 환불 있는 주문 5건을 샘플링했더니 order_items 자체가 없는 주문들이었음(원인 불명, 별도 확인 필요) |
| 4 | 결제된 OPEN 주문 누락 | **확인, 재현됨 + 부가 원인 발견** | Bon Sushi 2026-08-08: COMPLETED만 집계 시 $4,995.23, OPEN(결제완료) $456.50 누락. 합치면 $5,451.73 — 오너가 Square에서 확인한 값과 정확히 일치. 추가로: Square API로 재조회하니 당시 OPEN이던 주문 7건이 지금은 전부 COMPLETED로 바뀌어 있음 — Square가 사후에 마감 처리했는데 우리 DB는 갱신 안 됨(상태 갱신 로직 부재도 원인). 수정은 "OPEN+결제완료 포함" 필터로 — 상태 새로고침에 의존하지 않는 더 견고한 방식 |
| 5 | 2026-08-08 대조 | **완전 확인, Square API로 종결** | Bon Sushi 차이($456.50)는 OPEN 누락으로 완전히 설명됨(2번 참조). CozyHaus는 그날 OPEN 주문이 0건이라 이 버그와 무관 — 별도 gross/net 대조 기준 문제(2번)였음 |
| 6 | Average Sale 정의 | **잠정 확인** | Square 공식 정의는 "Net Sales ÷ 거래 건수"로 알려져 있음(Square 도움말 기준, 100% 확인은 아님). `analytics_location_sales_v2`가 지금 gross_sales로 나누고 있는 것도 함께 고쳐야 함 |
| 7 | 주문 수 오류(split payment 등) | **확인, 4번과 동일 원인** | `orders` 테이블 자체는 주문 1건=1행으로 정상(중복 없음). 문제는 결제수 기준 집계가 아니라 `state='COMPLETED'` 필터로 OPEN 누락되는 것 |
| 8 | 특정 기간 매출 $0 오류 | **재현 안 됨** | 2025-06~2026-08 전 구간에 CozyHaus/Bon Sushi 데이터 존재, $0 기간 없음. 2025-11 Bon Sushi 주문 1건·$407.96은 데이터 버그 아님 — 오너 확인 결과 **12월 정식 오픈 전 준비 기간**(정상 사업 히스토리) |
| 9 | 페이지네이션 누락 | **검증 불가** | Square API 접근 권한이 없어 원본과 대조 불가. 월별 건수 추이는 자연스러워 보이나 확정 못함 |
| 10 | 상위 10개=전체 오인 | **문제 없음 확인** | `analytics_top_items`(순위·limit)와 `analytics_item_sales`(특정 품목 전체 검색, limit 없음)가 이미 분리되어 있음 |
| 11 | 카테고리 미연결 | **확인 후 해결책 존재 확인** | `order_items.category_id`는 168,368건 전부 NULL(원래 채우지 않는 설계). 대신 `order_items_enriched` 뷰가 `catalog_object_id → variation → item → category` 체인으로 연결, 85.7%(144,305건) 매칭. 나머지 14.3%(24,063건)는 `analytics_category_sales`에서 "Uncategorized"로 처리됨 — 설계상 정상 |
| 12 | 상대 날짜·시간대 오류 | **문제 없음 확인** | 자정 전후 표본 8건 전부 UTC→America/Regina(UTC-6, DST 없음) 변환이 정확함 (`business_date`/`business_hour` 검산 일치) |
| 13 | AI가 과거 숫자 재사용 | **해당 없음(미구현)** | Discord 봇(`runtime/`)이 이 레포에 아직 없음. M2에서 새로 만들 때 반영할 요구사항으로 기록만 함 |
| 14 | Discord 중복 응답 | **부분 확인** | `discord_processed_messages` + `claim_discord_message()` (INSERT ON CONFLICT DO NOTHING 기반 클레임)가 이미 존재 — 올바른 idempotency 패턴. 다만 이걸 실제로 호출하는 봇 코드가 레포에 없어 실사용 여부 확인 불가 |
| 15 | Bon Sushi 세금 집계 오류 | **확인, 4번과 동일 원인** | `monthly_tax_summary`가 `monthly_tax_overrides` 값을 우선 사용하도록 되어 있어 7월 수치가 맞아 보였을 뿐, 실제 계산(COMPLETED만)은 GST -$58.55, Saskatchewan PST -$70.64 틀렸음. OPEN(결제완료) 주문의 세금을 더하면 Saskatchewan PST는 $631.11로 **완전히 일치**, GST도 반올림 수준(오차 $0.30) 오차로 일치. 즉 세금 버그가 아니라 4번과 같은 버그였고, 오버라이드 테이블은 근본 원인을 고치지 않은 임시 땜질이었음 |
| 16 | 검증 원칙 | 이 문서가 그 결과물 | 실제 데이터로 재현. 함수·데이터는 아직 수정하지 않음(G4 대기) |

## 결론 — 근본 원인은 대부분 하나

`analytics_*` 함수 13개 중 9개(daily_sales, location_sales v1, sales_summary v1, top_items, item_sales, hourly_sales, category_sales, compare_periods, customer_retention)가 `state='COMPLETED'`만 필터링해 **결제 완료된 OPEN 주문을 누락**시킨다. 이 하나의 버그가 오류 4·5·7·15를 전부 설명한다. `analytics_dispatch`(실제 봇이 호출하는 라우터)는 `sales_summary`·`location_sales`는 v2(OPEN 포함)로, 나머지는 전부 옛 버전(OPEN 누락)으로 연결돼 있어 **질문 종류에 따라 답이 다른 기준으로 나온다.**

## 오너 확인 항목 — 해결 현황

1. ~~Square 화면 재확인~~ — **해결**. Square Orders API 원본으로 직접 재계산해 확정함 (2번 항목 참조)
2. **Average Sale 정의** — 잠정 확인(Net Sales ÷ 거래건수). 화면에 산식을 명시하고, 여유 있을 때 Square 화면과 육안 대조 권장
3. ~~2025-11 Bon Sushi~~ — 확인 완료. 12월 정식 오픈 전 준비 기간, 정상 데이터

## 결과 (사후 기록)

2026-08-23: Square API 접근 권한 확보(Access Token) 후 2번·5번 항목을 원본 데이터로 완전히 종결.
G4 승인(오너 명시적 확인, 대화 중) 하에 `db/migrations/0001_fix_open_order_inclusion_and_net_sales.sql` 작성·적용 완료. 적용 후 재검증:

- Bon Sushi 2026-08-08 `analytics_location_sales_v2` net_sales = **$5,451.73** — 오너 참고값과 센트 단위까지 완전 일치
- CozyHaus 2026-08-08 net_sales = $1,908.20 — 우리 정의(Gross−Discount)로 정상 산출
- 2026-07 Bon Sushi 세금, `monthly_tax_overrides` 없이 원본 재계산만으로 Saskatchewan PST $631.11 완전 일치, GST/PST는 반올림 수준(≤$0.36) 오차로 일치 — 오버라이드 테이블 없이도 정답이 나옴을 확인

남은 항목: 3번(할인·환불 중복 차감)은 여전히 미확정 — n8n이 계산한 `net_sales`가 환불을 이미 반영했는지 원본 코드가 없어 확인 불가. 9번(페이지네이션 완전성)은 하루치 표본(228건 일치)만 확인, 전체 기간 대조는 아직. 1번(소셜 광고 위치 추론이 문자열 매칭)은 낮은 우선순위로 미수정.

2026-08-24: Square 자동 동기화(`sync/square/`, Edge Function `square-sync`) 구축·배포 완료. n8n 대신 이 레포 코드로 재구현했고, pg_cron이 매일 04:00 UTC(Regina 22:00)에 자동 호출한다(맥북 무관). 동일 구간 3회 실행해 행 수 불변 확인(불변 규칙 #6). 상세: `docs/runbooks/square-sync.md`.

다음 단계: `docs/contracts/query-contract.md` 정식 등록, 회귀 테스트 스크립트 작성, 대시보드 첫 페이지.
