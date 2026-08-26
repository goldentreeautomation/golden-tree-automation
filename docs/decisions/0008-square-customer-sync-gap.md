# 0008. Square 고객(Customers) 동기화 공백 복구

- 날짜: 2026-08-25
- 상태: 채택

## 맥락

설계상 "고객 | Square Customers API | 매일 22:00 | M2"로 잡혀 있었는데(`docs/golden-tree-design.md` 1.4), Square 동기화를 n8n에서 Edge Function(`sync/square/`)으로 재구현할 때 주문·결제·환불만 옮기고 Customers API 호출은 빠뜨렸다. `ingest_square_batch` RPC는 `p_customers` 파라미터를 이미 지원했지만 코드에서 항상 `[]`로 호출하고 있었다.

그 결과 `customers` 테이블이 2026-08-17 이후 갱신이 멈춰 있었고, Discord `/ask`의 단골 고객(`customer_retention`) 질문이 이 테이블을 참조하므로 시간이 갈수록 부정확해지고 있었다. 오너에게 발견 사실을 보고하고 우선순위 확인 후 진행.

## 결정

`sync/square/src/index.ts`에 `fetchAllCustomers()`/`normalizeCustomer()` 추가 — Square `/v2/customers/search`를 `updated_at` 범위로 조회해 매시간 동기화에 포함시켰다. DB 쪽 인프라(`ingest_square_batch`의 customers upsert, `on conflict` + `coalesce`로 병합)는 이미 완성돼 있어 코드만 추가하면 됐다.

8/17~8/24 공백은 2일 단위로 나눠 수동 백필했다(한 번에 9일치를 요청하니 `statement timeout`으로 실패 — 주문·아이템 upsert 부하 때문으로 보임, 2일 단위론 문제없음).

## 근거

- Query Contract·idempotent upsert 인프라가 이미 있어 위험이 낮고, 실제로 매시간 동작 중인 파이프라인의 빈 구멍을 메우는 일이라 우선순위가 높다고 판단.
- 오너에게 "다른 거 연결"이 이 뜻이었는지 먼저 확인 후 진행(발견한 버그를 임의로 큰 작업으로 확장하지 않기 위해).

## 결과 (사후 기록)

- `customers` 1337 → 1357건, `ingested_at` 최신화 확인.
- 남은 orphan 4건은 버그가 아니라 Square 자체의 고객 병합(customer merge) 특성 — 오래된 주문의 `customer_id`가 이후 Square에서 다른 고객과 병합(`creation_source: MERGE`)되면서 예전 ID로는 프로필이 안 잡힌다. Square API로 직접 확인해 원인 규명함. 별도 조치 안 함(영구적 특성이라 "고치는" 개념이 아님).
- `square-sync` v9로 배포, 매시간 동기화에 고객 동기화 포함해 계속 최신 유지.
