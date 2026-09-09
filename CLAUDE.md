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
2. **매출 = Net Sales** — Gross − Discount. 세금·팁·기프트카드 판매(선수금) 제외. 다른 정의를 쓸 땐 명시한다
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

## Business OS 협업 워크플로우 (2026-09-09, Phase 0에서 미리 반영 — 사촌·Codex 협업 대비)

- **main에서 직접 작업 금지** — feature branch(또는 worktree)에서 작업 후 PR
- 작업 시작 전 기존 shared package·Query Contract를 먼저 확인 — 중복 구현 금지
- DB 변경은 항상 migration 파일로(직접 ALTER 금지, G4와 동일 원칙)
- 관련 테스트가 있으면 실행하고 커밋
- architecture·policy·source-of-truth를 바꿀 땐 관련 문서/ADR도 같이 갱신
- 완료 후 commit + PR 준비까지. **human 승인 없이 main merge·production 배포 금지**

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

**M1 — 데이터 기반**: 완료(맥북 꺼도 익일 자동수집 + Square 차이 $0.00). 레포·스키마·Square 동기화(`sync/square/`, n8n 미사용)·재실행 안전성·Query 함수·정적 대시보드·전체 기간 백필·매시간 동기화 전부 완료. 상세 근거는 `docs/decisions/0001` 등.

**M2 착수** — Discord `/ask` 봇(`0003`), Meta 소셜·광고 동기화(`0004`), Notion 결정기록 신규(`0006`, DB 5개, 동기화 코드는 다음), Regina 시장 수요 예상(`0007`) — 대시보드 왼쪽 패널, 매시간 15분 재계산. Discord 봇을 단일 함수 호출 → function calling 멀티스텝 도구 호출로 재구성(`0013`, 2026-09-04) — 복잡한 질문(매출+SNS 연관 분석 등)에 여러 번 조회해 답함. 오너가 세금 신고 중 Square 공식 리포트와 직접 대조해 기프트카드 판매가 매출에 잘못 포함되던 버그 발견·전체 기간 소급 수정, Discord 봇의 세금 조회(`tax_summary`) 등록 누락도 같이 해결(`0015`,`0016`). **AI 제공자 Gemini→OpenAI 전환**(`0019`, 2026-09-09, 오너 결정 — 무료 티어 일일 한도·wire-format 버그, 유료 GPT 계정 보유) — Discord 봇·주간 특이사항·Meta 포스팅 사진 설명 전부 `gpt-5.6-luna`로 이전. 작업 끝날 때마다 표 갱신.

**M3 조기 착수** — 레시피 원가율 감시(`0011`, 오너 요청으로 순서 당김). 스키마 완료, 실제 데이터 입력은 재고 트래킹 작업으로 잠시 보류. 완제품 재고 트래킹(`0014`) — `/stock` 명령어 + 웹 입력 화면(`docs/stock.html`), Square 판매량 자동 차감. 통당 개수는 오너 확인 대기. 주간 경영 회의 OKR(`0018`, 2026-09-08 개정) — 매출 기준선/목표(오너 확정: 본스시 $23,750/$30,000, 코지하우스 $13,750/$17,500, 주간)·홀케이크 주문 수·소셜 오가닉/광고 지표를 "지난주(완결)" 기준으로 일요일 밤 11시(Regina) 계산해 저장(`weekly_okr_snapshots`, 실시간 재계산 안 함), AI 특이사항 문장은 발행 후 1~7일(한 주)/주말 지연 반응 반영(0029, 오너 지적으로 3일→7일 확장). 대시보드 최상단 OKR→매출→시장수요 순 재배치. 웹사이트/GBP는 코덱스 저장소 소관 유지하되 `external-metrics-ingest` 수신 창구만 신설(대시보드 표시는 다음 단계). 지역행사 신호는 Ticketmaster Discovery API로 연결 완료(`0020`, 2026-09-09 — 라이더스 홈경기 최고 가중치, 이후 백테스트 결과 실제론 마이너스로 확인). 소셜미디어 신호(최근 7일 포스팅 퍼포먼스 + 광고 집행 중 여부 계속 체크) + `market_demand_outcomes` 실측 기록 + `regina_weather_history` 과거 날씨(둘 다 449일 소급 적재, 매일 자동 갱신) 추가(`0021`) — 감이 아닌 데이터 기반 학습 인프라 구축 착수. 지역행사 과거 기록은 API 한계로 소급 불가(오늘부터 축적). 남은 것: 시장수요 3일 추세 UI, 실제 학습(회귀) 루프.
