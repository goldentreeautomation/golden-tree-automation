# 0003. Discord 봇 — Gemini 기반 질문 응답 (M2 W4 착수)

- 날짜: 2026-08-24
- 상태: 채택, 1차 배포 완료

## 맥락

오너가 Discord에서 자연어로 매출·품목을 물어보고 싶어함. AI API는 무료 티어인 Gemini를 쓰기로 함(런타임 비용 월 $20 이하 제약, `docs/golden-tree-design.md` 1.5).

## 결정

`runtime/discord/` Edge Function 하나로 W4(`docs/golden-tree-design.md`) 전체를 구현:

1. Discord Interaction 수신 → Ed25519 서명 검증 → `claim_discord_message`로 중복 처리 방지(오류 14번, `docs/decisions/0001`)
2. 즉시 DEFERRED 응답(type 5) 후 백그라운드에서 처리 — Discord 3초 제한 대응
3. Gemini(`gemini-3.6-flash`)가 질문을 `analytics_dispatch` 파라미터로 변환 — 허용된 analysis 종류만 화이트리스트(`ALLOWED_ANALYSIS`)로 제한, raw SQL 없음(불변 규칙 #1)
4. `analytics_dispatch` 실행(코드, LLM 아님)
5. Gemini가 결과 숫자만으로 한국어 답변 생성, 사용한 analysis 종류를 답변에 표기(설계서 "답변에 함수명 붙이는 이유")

슬래시 명령은 `/ask question:<자유 텍스트>` 하나만 — 여러 개 만들지 않고 LLM 라우팅에 맡김.

## 결과 (사후 기록)

- 2026-08-24 실제 사용자 질문 "지금까지 제일 매출 높은 달이 언제고 얼마였어?"가 기존 함수로 답 불가 확인 → `analytics_monthly_sales` 신규 추가(마이그레이션 0002), `analytics_dispatch`에 등록, 봇 화이트리스트에 반영
- `runtime/personas/`, `runtime/router/`는 아직 별도 파일로 안 나눔 — 봇 1종(analyst 역할)뿐이라 `runtime/discord/`에 다 있음. marketing/seo/bookkeeper 페르소나 추가 시(M3+) 분리 검토
- `output/unanswered.jsonl` 로깅은 아직 미구현 — 현재는 "지원 범위 밖" 답변만 하고 기록은 안 남음. 반복되면 추가
