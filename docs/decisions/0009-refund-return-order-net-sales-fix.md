# 0009. 반품 전용 주문이 매출에서 빠지지 않던 버그 수정

- 날짜: 2026-08-25
- 상태: 채택

## 맥락

`docs/decisions/0001` 버그 #3(할인·환불 중복 차감)이 "미확정"으로 남아 있었다. n8n이 계산한 값을 재현할 수 없어서였는데, Square 동기화를 완전히 새로 구현한 지금은 이 값이 더 이상 n8n 산출물이 아니라 우리 코드가 매번 원본 API로 재계산한 값이라 다시 조사할 수 있었다(오너 요청으로 "잔가지 정리" 중 발견).

## 검증 결과

Square는 환불·반품을 처리할 때 **원래 주문을 고치지 않고 "반품 전용 주문"을 별도로 새로 만든다**. 이 주문은 일반 주문의 `total_money`/`total_tax_money`/`total_tip_money`/`line_items` 필드가 없고, 대신 `net_amounts`(음수)와 `returns`만 있다. `normalizeOrder()`가 `o.total_money` 등을 그대로 읽었기 때문에 `money(undefined)=0`이 되어 이런 주문이 전부 매출 $0으로 저장되고 있었다 — 즉 환불이 매출에서 전혀 빠지지 않고 원래 판매분만 그대로 남아 있었다.

전체 기간(2025-06~2026-08-25) 영향 규모:

| 매장 | 반품 전용 주문 | 누락된 매출 차감분 |
|---|---|---|
| CozyHaus (L7DA0MBKD2X4P) | 85건 | -$872.56 |
| Bon Sushi (LWEFT8C6SXJ7J) | 23건 | -$862.25 |

`docs/decisions/0001`에서 센트 단위로 검증했던 2026-08-08 Bon Sushi는 이 문제가 있는 주문이 하루에 0건이라 그 검증 자체는 영향받지 않는다.

## 결정

1. `sync/square/src/index.ts` `normalizeOrder()`를 `o.total_money ?? o.net_amounts?.total_money` 형태로 수정 — 표준 필드가 없을 때만 `net_amounts`로 대체하므로 정상 주문 동작엔 영향 없음(`square-sync` v10 배포).
2. G4 승인(오너, 대화 중 "진행해") 하에 기존 108건의 저장된 주문을 `raw` JSONB에서 동일한 공식으로 재계산해 소급 수정(SQL UPDATE, Square API 재호출 없이 idempotent하게 처리).

## 근거

- Square API를 다시 호출하지 않고 이미 저장된 `raw`로 재계산 가능해 위험이 낮았고, 재계산 결과가 사전에 미리 계산해 보고한 값(-$872.56 / -$862.25)과 정확히 일치함을 UPDATE 후 재확인함.
- 반품 라인아이템(`returns[].return_line_items`) 단위 상세는 이번엔 반영하지 않음 — `order_items`가 비어 있어 품목별 매출·카테고리 비중에서 반품이 빠지지만, 주문 단위 총매출(대시보드가 보여주는 핵심 숫자)이 우선순위가 높다고 판단해 범위를 좁힘. 필요해지면 별도 작업으로.

## 결과 (사후 기록)

UPDATE 직후 재조회로 -872.56 / -862.25 정확히 일치 확인. `square-sync` v10 배포 후 정상 동기화 확인(48시간 창, 411 orders/1103 items/customers 5).
