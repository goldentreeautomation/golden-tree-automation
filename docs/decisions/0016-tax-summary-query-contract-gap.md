# 0016. Discord 봇에 세금 조회(tax_summary) 누락 등록

- 날짜: 2026-09-08
- 상태: 채택

## 맥락

오너가 GST/PST 신고를 위해 Discord로 8월 세금을 물었는데 봇이 "GST, PST, LCT 세금 내역은 조회되지 않습니다"라고 답함. 실제로는 `monthly_tax_summary(p_start, p_end)` 함수가 이미 존재하고 `docs/decisions/0001` 때 버그까지 수정해둔 상태였다 — Discord 봇을 여러 차례 개편(멀티스텝 도구 호출 등)하는 과정에서 이 함수를 `ALLOWED_ANALYSIS`/`analytics_dispatch`에 등록하는 걸 빠뜨림.

## 결정

`analytics_dispatch`에 `tax_summary` 케이스 추가(`monthly_tax_summary` 호출), Discord 봇 `ALLOWED_ANALYSIS`·도구 설명에 등록(`0025`). location_id는 이 analysis에서 무시되고 항상 양쪽 매장이 다 나옴(함수 자체가 location 파라미터를 안 받음).

## 근거

Query Contract에 이미 등록된 함수라도 런타임 봇(Discord)의 화이트리스트에 실제로 연결돼 있는지는 별개 문제 — 이번처럼 "DB엔 있는데 봇은 모른다"는 간극이 생길 수 있음을 확인. 새 analysis를 추가할 때뿐 아니라, 기존 함수를 살펴볼 때도 "봇이 실제로 쓸 수 있는가"를 같이 점검할 필요가 있음(향후 체크리스트 항목).

## 결과 (사후 기록)

`discord-bot` v20 배포. 이 문제를 조사하던 중 더 중요한 매출 계산 버그(기프트카드, `0015`)도 함께 발견함.
