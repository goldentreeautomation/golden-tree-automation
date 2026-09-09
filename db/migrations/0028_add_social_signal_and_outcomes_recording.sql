-- 0028_add_social_signal_and_outcomes_recording.sql — 시장 수요 예상에 소셜미디어 신호 추가
-- + 실제 매출(outcomes) 기록 시작 준비 (오너 요청, 2026-09-09)
--
-- 배경: 라이더스 홈경기 가중치를 백테스트해보니 손으로 정한 규칙(+20)이 실제 데이터와 반대
-- 방향이었음 — 감이 아니라 데이터로 판단하려면 (1) 예측과 실제를 계속 기록해서 나중에 진짜
-- 가중치를 학습할 재료를 쌓고, (2) 오너가 강하게 체감하는 신호(소셜미디어 포스팅 퍼포먼스 →
-- 다음날 매출)도 같이 기록에 포함시켜야 한다. 지금 넣는 소셜 가중치는 기존 상관관계 로직
-- (0008)의 day_offset 개념을 재사용한 잠정치이지 확정 아님 — 학습 데이터가 쌓이면 교체된다.

alter table public.market_demand_features
  add column if not exists social_recent_post_count integer,
  add column if not exists social_recent_total_interactions integer,
  add column if not exists social_recent_high_performer boolean;

alter table public.market_demand_snapshots
  add column if not exists social_impact numeric;

comment on column public.market_demand_snapshots.social_impact is '최근 1~3일 SNS 포스팅 퍼포먼스 기반 잠정 가중치(오너 요청, 2026-09-09) — 학습 데이터 쌓이기 전까지는 규칙 기반 추정치.';
comment on column public.market_demand_features.social_recent_high_performer is '최근 1~3일 내 발행된 포스팅 중 해당 계정 평소 반응(트레일링 8주 평균) 대비 크게 초과한 게 있는지.';
