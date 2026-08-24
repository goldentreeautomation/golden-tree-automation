# 0004. Meta(Instagram·광고) 동기화 (Phase 5, M2)

- 날짜: 2026-08-24
- 상태: 채택, 1차 배포 완료

## 맥락

M2 착수 순서(`docs/decisions/0003` 이전, `golden-tree-design.md` M2~M3 착수 순서 표) 2번째 단계. 오너가 System User 토큰(만료 없음, `expires_at: 0`)을 발급해 제공함.

레거시(n8n) 스키마가 이미 존재했다 — `social_posts`, `social_post_metrics`, `social_comments`, `social_ad_campaigns`, `social_ad_metrics` 등 정규화 테이블과, 그 앞단의 `_ingest` **뷰**(VIEW, INSTEAD OF INSERT 트리거로 upsert 처리). 이 구조를 그대로 재사용했다.

## 결정

`sync/meta/` Edge Function 신규:
1. 인스타그램 포스트(캡션·미디어) + 포스트별 인사이트(좋아요·댓글·공유·저장·도달, FEED/REELS 메트릭 차이 처리) + 댓글 원문
2. 광고 캠페인 목록 + 캠페인×일 단위 성과(지출·노출·도달·클릭·CTR·CPC·CPM)
3. `social_*_ingest` 뷰에 upsert (idempotent, 불변 규칙 #6)
4. `social_sync_log`에 sync_key별 기록

매일 04:10 UTC(Regina 22:10, Square 동기화 10분 뒤) pg_cron 자동 실행.

## 결과 (사후 기록)

- 첫 배포 때 캠페인 테이블에 `platform` 값을 `meta_ads`로 새로 만들어서 레거시 값(`meta`)과 어긋나 69건이 중복 생성됨 — 즉시 발견해 코드 수정 + 중복 데이터 삭제(해당 배포에서 생긴 것만, 기존 데이터는 미접촉). **교훈: 기존 스키마 재사용 시 `platform` 등 키로 쓰이는 문자열 값도 레거시와 정확히 일치시켜야 한다**
- 30일 백필 → 오너 요청으로 전체 기간(2025-03-05~) 백필로 확장. 게시물이 많아(272건) 순차 처리로는
  Edge Function 유휴 타임아웃(150초)에 걸림 — 계정 내 게시물 동시 처리(동시 8개) + 배치마다 즉시
  저장으로 수정 후 성공. 전체 백필 결과: 포스트 272건(Bon Sushi 89 + CozyHaus 183), 댓글 605건,
  광고 지표 342건, 캠페인 69건
- 전체 백필 중 `social_ad_metrics`에 FK(campaign_id → social_ad_campaigns) 위반 발견 — Meta
  `/campaigns` 목록 API가 이유 불명으로 캠페인 3개(ARCHIVED 추정)를 안 돌려줘서, 그 캠페인들의
  광고 지표를 못 넣음. 알려진 캠페인 것만 넣고 나머지는 스킵하도록 처리(`skipped_campaign_ids`로
  응답에 남김) — 이 3개 캠페인의 과거 지출 데이터는 현재 못 가져옴
- 같은 배포에서 레거시 트리거(`upsert_social_ad_metric_from_view`)가 목표(objective)를 못 찾으면
  `results`가 NULL이 되어 NOT NULL 제약 위반으로 배치 전체가 롤백되는 버그 발견·수정
  (마이그레이션 0003) — 목표를 못 찾으면 0으로 대체
- Discord `/ask` 봇의 허용 analysis에 `social_posts`, `social_campaigns`, `social_ads`, `social_comments` 추가 — 이제 소셜 성과도 물어볼 수 있음
- 광고 캠페인의 매장 구분은 캠페인 이름 문자열 매칭(`cozy`/`bon` 포함 여부) — `docs/decisions/0001` 항목 1에서 이미 지적한 약한 지점, 아직 안 고침. 이름에 매장명이 없는 캠페인이 생기면 재발 가능
