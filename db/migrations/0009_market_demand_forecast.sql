-- 0009_market_demand_forecast.sql
--
-- 배경: 오너 요청 — "Regina 시장 수요 예상" 대시보드 위젯. 실제 혼잡도가 아니라 시장 신호
-- 기반 예상치임을 항상 명시한다. 규칙 기반 점수로 시작하고, 데이터가 쌓이면(8주/200건 이상)
-- 나중에 회귀 모델로 보정하는 걸 전제로 스키마를 설계한다 — 지금은 규칙 기반 계산만 구현.
--
-- 브랜드 구분: brand_id = location_id (LWEFT8C6SXJ7J/L7DA0MBKD2X4P) 재사용 — 이미 쓰던 값과
-- 통일해서 나중에 조인하기 쉽게 한다.

create table if not exists public.market_demand_snapshots (
  id bigint generated always as identity primary key,
  brand_id text not null,
  forecast_for date not null,
  period text not null check (period in ('morning','afternoon','evening')),
  score integer not null check (score between 0 and 100),
  demand_band text not null check (demand_band in ('quiet','normal','busy','very_busy')),
  confidence text not null check (confidence in ('low','medium','high')),
  model_version text not null default 'rule-v1',
  weather_impact numeric not null default 0,
  event_impact numeric not null default 0,
  calendar_impact numeric not null default 0,
  search_impact numeric not null default 0,
  operations_impact numeric not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  source_status jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  unique (brand_id, forecast_for, period, calculated_at)
);
create index if not exists market_demand_snapshots_lookup_idx
  on public.market_demand_snapshots (brand_id, forecast_for, period, calculated_at desc);

create table if not exists public.market_demand_features (
  id bigint generated always as identity primary key,
  brand_id text not null,
  observed_at timestamptz not null,
  temperature_c numeric,
  feels_like_c numeric,
  precip_probability_pct numeric,
  precip_mm numeric,
  snow_cm numeric,
  wind_kph numeric,
  weather_alert boolean not null default false,
  weather_alert_text text,
  sunrise timestamptz,
  sunset timestamptz,
  nearby_event_count integer not null default 0,
  weighted_event_score numeric not null default 0,
  events_confirmed boolean not null default false,
  is_weekend boolean not null default false,
  is_holiday boolean not null default false,
  holiday_name text,
  is_school_break boolean not null default false,
  is_month_start boolean not null default false,
  is_month_end boolean not null default false,
  special_date text,
  season text,
  search_trend_pct numeric,
  road_alert boolean not null default false,
  transit_alert boolean not null default false,
  air_quality_index numeric,
  same_weekday_baseline_net_sales numeric,
  same_weekday_baseline_order_count numeric,
  raw jsonb not null default '{}'::jsonb,
  unique (brand_id, observed_at)
);

create table if not exists public.market_demand_outcomes (
  id bigint generated always as identity primary key,
  brand_id text not null,
  period_start timestamptz not null,
  order_count integer not null default 0,
  revenue_total numeric not null default 0,
  delivery_order_count integer not null default 0,
  source text not null default 'square',
  imported_at timestamptz not null default now(),
  unique (brand_id, period_start, source)
);

comment on table public.market_demand_snapshots is '시간대별 시장 수요 예상 점수 기록 — 실제 혼잡도 아님, 시장 신호 기반 추정치';
comment on table public.market_demand_features is '예측에 쓰인 원본 입력값(날씨·행사·캘린더 등) — 나중에 회귀 모델 학습용';
comment on table public.market_demand_outcomes is '실제 매출 실적(개인정보 없음, 시간대별 합계만) — 예측 정확도 검증·모델 학습용';

alter table public.market_demand_snapshots enable row level security;
alter table public.market_demand_features enable row level security;
alter table public.market_demand_outcomes enable row level security;
