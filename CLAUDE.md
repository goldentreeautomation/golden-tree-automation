# Golden Tree

82 Bakeshop Ltd. 경영 데이터·AI 에이전트 시스템. 전체 설계는 `docs/golden-tree-design.md`. 이 파일은 항상 로드되므로 100줄 이내로 유지한다.

## 사업

| | |
|---|---|
| 법인 | 82 Bakeshop Ltd. (Regina, SK) |
| CozyHaus Desserts & Coffee | `LOC_001` / Square `L7DA0MBKD2X4P` |
| Bon Sushi | `LOC_002` / Square `LWEFT8C6SXJ7J` |
| 시스템 계정 | ops@cozyhaus.ca |
| Supabase | project `stfiazhmznssyfsiaxvw` |

## 오너 (Peter)

- 코드를 직접 쓰지 않는다. 모든 작업은 한국어 존댓말 대화로 진행한다
- 큰 틀과 이유를 먼저 설명하고 진행한다. 단계별로 찔끔찔끔 진행하지 않는다
- 새 용어가 나오면 그 자리에서 설명하고, 방향을 바꿀 땐 이유를 말하고 바꾼다 (말없이 바꾸지 않는다)

## 시스템

```
INTERFACE   Discord 봇 │ 대시보드 │ 정기 리포트
CONTRACT    Query 함수 — 데이터의 유일한 출입구
DATA        Supabase — 정규화 테이블 + 원본 JSONB
INGESTION   Square │ Meta │ Notion │ GSC │ GBP │ 영수증
```

실행 주체는 Supabase(서버리스)다. 맥북은 개발 전용이며 시스템은 맥북과 무관하게 돈다.

## 불변 규칙

1. **Query Contract 우회 금지** — 런타임 봇은 `docs/contracts/`에 등재된 함수만 호출한다. raw SQL 금지
2. **매출 = Net Sales** — Gross − Discount. 세금·팁 제외. 다른 정의를 쓸 땐 명시한다
3. **금액은 CAD, 달러 단위 소수점 2자리**
4. **시간은 Regina 기준** — Square는 UTC로 준다. `business_date`는 반드시 변환해 저장한다
5. **모든 조회는 매장 구분 가능해야 한다** — 테이블·함수·화면에 location 차원 필수
6. **모든 동기화는 idempotent** — 3회 실행해도 행 수가 변하지 않아야 한다
7. **모바일 우선** — 모든 화면은 휴대폰에서 먼저 확인한다
8. **문서를 먼저 고친다** — 설계가 틀렸으면 코드보다 `docs/golden-tree-design.md`를 먼저 수정한다

## 승인 게이트

승인 없이 실행하지 않는다. 상세는 설계서 W8.

| | 대상 | 상태 |
|---|---|---|
| G1 | 외부 공개 콘텐츠 (소셜 포스팅. 블로그·GBP는 코덱스 사이드 프로젝트 소관) | M3부터 |
| G2 | 지출 (발주·지불·광고 예산) | M3부터 |
| G3 | 회계·세금 확정 | M4부터 |
| G4 | **DB 구조 변경·데이터 일괄 수정 및 삭제** | **활성** |

## 빌더 에이전트 (참고용, 미사용)

`.claude/agents/`에 4개(db-architect·integration-builder·frontend-builder·verifier) 스텁 존재. 위임하지 않고 메인이 직접 처리하는 걸로 확정(오너 결정, 2026-08-25) — 소규모라 위임보다 직접 처리가 더 빠르고 투명함. 스텁은 나중에 필요해지면 참고용으로 남겨둔다.

## 스킬

| 스킬 | 트리거 |
|---|---|
| `verify-sync` | 동기화 후 / 숫자 확인 요청 / 마일스톤 판정 |
| `add-connector` | 새 외부 서비스 연결 |
| `add-query-function` | 새 조회 요구 / `output/unanswered.jsonl` 검토 |
| `add-dashboard-page` | 화면 추가 |
| `run-migration` | 마이그레이션 실행 (항상 G4 경유) |

## 금지

- 운영 DB 직접 수정 (G4 없이 마이그레이션·TRUNCATE·DELETE 실행)
- Query Contract에 없는 데이터 접근을 런타임 봇에 허용
- 세무·법률 판단 (자료 생성까지만. 확정은 CPA·변호사)
- 임계값·비밀키 하드코딩

## 현재 상태

**M1 — 데이터 기반** (완료: 맥북 꺼도 익일 자동수집 + Square 차이 $0.00). 오너의 선행 시도(ChatGPT+n8n)와 같은 Supabase를 물려받아, 그때 만든 데이터·함수는 라이브 DB에 있으나 만든 코드는 없다(n8n 안에 갇힘). 아래는 실제 DB 재조사 결과 — 근거: `docs/decisions/0001-legacy-square-data-verification.md`

| # | 작업 | 상태 |
|---|---|---|
| 1 | 레포·CLAUDE.md | 완료 |
| 2 | 빌더 에이전트 4개 정의 | 보류 — 오너 결정으로 메인이 직접 처리, 스텁만 유지 |
| 3 | 스키마 확정 | 부분 — 테이블 존재(주문 68,161건)하나 마이그레이션 파일 없음 |
| 4 | Square 동기화 | 완료 — `sync/square/` Edge Function으로 재구현(n8n 미사용). 고객(Customers API) 동기화 누락분 발견·복구(`0008`) |
| 5 | 재실행 안전성 검증 | 완료 — 동일 구간 3회 실행, 행 수 불변 확인 |
| 6 | Square Dashboard 대조 | 완료 — 오류 16건 전부 확인·해결(1번 저우선순위 미수정 제외). 환불 중복(3번)·페이지네이션(9번) 해결(`0009`,`0010`) |
| 7 | Query 함수 5개 | 완료 — `docs/contracts/query-contract.md`에 실사용 함수(A. Discord 라우팅 / B. 대시보드 직접호출) 및 고아 함수 정리 |
| 8 | 대시보드 첫 페이지 | 완료 — 정적 HTML+Edge Function(Next.js 아님, `docs/decisions/0002`). 오너 휴대폰 확인 대기 |
| 9 | 과거 데이터 백필 | 완료 — 전체 기간(70,013건) Square API 원본과 주문 ID 단위 대조, 8/13 공백(35건) 발견·복구(`0010`) |
| 10 | 스케줄 등록 | 완료 — Square 동기화 매시간 5분(`square-hourly-sync`)로 전환(2026-08-25, 시장 수요 예상 최신성 위해). 맥북 무관 |

**M2 착수** — Discord `/ask` 봇(`0003`), Meta 소셜·광고 동기화(`0004`), Notion 결정기록 신규(`0006`, DB 5개, 동기화 코드는 다음), Regina 시장 수요 예상(`0007`) — 대시보드 왼쪽 패널, 매시간 15분 재계산. Discord 봇을 단일 함수 호출 → Gemini function calling 멀티스텝 도구 호출로 재구성(`0013`, 2026-09-04) — 복잡한 질문(매출+SNS 연관 분석 등)에 여러 번 조회해 답함. 작업 끝날 때마다 표 갱신.

**M3 조기 착수** — 레시피 원가율 감시(`0011`, 오너 요청으로 순서 당김). 스키마 완료(`0014`), 베스트셀러부터 레시피 대화 입력 진행 중. 영수증 OCR 파이프라인·연속 30일 초과 알림 cron 미착수.
