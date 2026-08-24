# Square 동기화 (W1) 운영 가이드

## 구성

| 구성 요소 | 위치 |
|---|---|
| 소스 코드 | `sync/square/src/index.ts` |
| 배포 위치 | Supabase Edge Function `square-sync` (project `stfiazhmznssyfsiaxvw`) |
| 스케줄 | pg_cron job `square-daily-sync`, `0 4 * * *` (UTC) = 매일 Regina 22:00 |
| 트리거 방식 | pg_cron → pg_net(`net.http_post`)이 Edge Function을 호출 |
| 인증 | 요청 헤더 `x-sync-secret`을 Supabase 시크릿 `SYNC_SHARED_SECRET`과 비교 |
| Square 인증 | Supabase 시크릿 `SQUARE_ACCESS_TOKEN` (developer.squareup.com 발급, 프로덕션) |

맥북과 무관하게 Supabase 클라우드에서 실행된다 (`docs/golden-tree-design.md` 1.5).

## 동작 방식

1. `sync_log`에서 `sync_key='square_orders:daily'`의 마지막 성공 `window_end` 조회
2. 조회 시작점 = 마지막 성공 − 48시간 (Square 주문 사후 수정 대응, `docs/golden-tree-design.md` W1)
3. Square Orders Search API를 **상태 필터 없이** 전량 조회 (COMPLETED/OPEN/CANCELED/DRAFT 모두 저장) — "무엇을 매출로 볼지"는 저장 시점이 아니라 조회 시점에 `orders_settled` 뷰가 결정한다
4. Payments·Refunds API도 같은 구간으로 조회
5. `ingest_square_batch` / `ingest_square_payments` RPC로 upsert (idempotent)
6. `sync_log`에 결과 기록

## 수동 실행

```bash
curl -X POST "https://stfiazhmznssyfsiaxvw.supabase.co/functions/v1/square-sync" \
  -H "x-sync-secret: <SYNC_SHARED_SECRET 값>" \
  -H "Content-Type: application/json" \
  --data '{}'
```

특정 구간만 다시 돌리려면 `{"since":"2026-08-01T00:00:00Z","until":"2026-08-08T00:00:00Z"}` 형식으로 body를 채운다.

## 코드 수정 후 재배포

```bash
# db-architect/integration-builder가 Management API로 배포한다 (CLI 없이도 가능 — Deno 소스 그대로 body에 담아 PATCH)
curl -X PATCH "https://api.supabase.com/v1/projects/stfiazhmznssyfsiaxvw/functions/square-sync" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"square-sync\",\"verify_jwt\":false,\"body\":$(python3 -c "import json;print(json.dumps(open('sync/square/src/index.ts').read()))")}"
```

## 알려진 제약 (2026-08-24 기준)

- 대형 백필(수개월 단위)은 함수 실행 시간 제한에 걸릴 수 있다 — 현재는 구간을 나눠 여러 번 호출해야 한다. 자동 청크 분할은 미구현 (필요해지면 추가)
- Catalog(품목/카테고리) 동기화는 이 함수에 없다 — `ingest_square_catalog` RPC는 존재하지만 아직 자동 호출 경로가 없음. 카테고리는 자주 안 바뀌므로 우선순위 낮음
- 실패 시 Discord/대시보드 알림 없음 (W6 이상 감지는 M2 대상) — 현재는 `sync_log.status='error'`만 남는다. 확인하려면 `select * from sync_log where sync_key='square_orders:daily'`

## 장애 시 확인 순서

1. `select * from sync_log where sync_key='square_orders:daily' order by updated_at desc limit 1;` — 마지막 실행 상태 확인
2. `select * from cron.job_run_details where jobid=1 order by start_time desc limit 5;` — pg_cron 실행 이력(성공/실패, HTTP 응답)
3. Square 자격증명 만료 여부 — developer.squareup.com에서 확인, 만료 시 `SQUARE_ACCESS_TOKEN` 시크릿 갱신 후 재배포 불필요(시크릿만 교체하면 즉시 반영)
