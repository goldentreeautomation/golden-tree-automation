-- 0026_weekly_okr_and_external_metrics.sql — 주간 경영 회의 OKR 스냅샷 + 외부(웹사이트/GBP)
-- 지표 수신 테이블 (오너 요청, 2026-09-08).
--
-- 설계 방향:
-- 1) 대시보드는 매번 계산하지 않고, 일요일 밤 11시(Regina)에 한 번 계산된 스냅샷을 읽기만
--    한다 — 회의 전에 숫자가 안정적으로 고정되어야 하고("지난주" 기준으로 봐야 함), 매번
--    무거운 계산(AI 해석 포함)을 반복할 필요가 없다.
-- 2) 웹사이트·GBP는 이 프로젝트가 직접 수집하지 않는다(0005) — 대신 코덱스 프로젝트가
--    이 표로 숫자를 밀어넣을 수 있는 창구만 만든다. 저장소는 분리 유지, 데이터만 한 곳에.

create table if not exists public.weekly_okr_snapshots (
  id bigint generated always as identity primary key,
  location_id text not null,
  week_start date not null,  -- 월요일
  week_end date not null,    -- 일요일
  net_sales numeric not null,
  net_sales_floor numeric not null,
  net_sales_target numeric,
  net_sales_status text not null check (net_sales_status in ('red','yellow','green')),
  cake_order_count integer,
  cake_order_target integer,
  cake_status text check (cake_status in ('red','yellow','green')),
  social_summary jsonb not null default '{}'::jsonb,
  anomaly_note text,
  calculated_at timestamptz not null default now(),
  unique (location_id, week_start)
);
comment on table public.weekly_okr_snapshots is '일요일 밤 cron이 계산해 저장. 대시보드는 이 표를 읽기만 함(매번 재계산 안 함).';

alter table public.weekly_okr_snapshots enable row level security;

-- 외부(웹사이트/GBP) 지표 수신 — 코덱스 프로젝트가 이 창구로 밀어넣는다. 저장소는 안 합침.
create table if not exists public.external_web_metrics (
  id bigint generated always as identity primary key,
  source text not null check (source in ('website','gbp')),
  metric_date date not null,
  metric_name text not null,  -- 예: 'sessions','clicks','gbp_views','gbp_calls','gbp_direction_requests','gbp_reviews_count'
  metric_value numeric not null,
  location_id text,           -- null이면 사이트 전체
  raw jsonb not null default '{}'::jsonb,
  ingested_at timestamptz not null default now(),
  unique (source, metric_date, metric_name, location_id)
);
comment on table public.external_web_metrics is '코덱스(웹사이트/GBP) 프로젝트가 밀어넣는 외부 지표. Golden Tree는 수집 안 함(0005).';

alter table public.external_web_metrics enable row level security;

create or replace function public.analytics_weekly_okr(p_location_id text default null)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.week_start desc), '[]'::jsonb)
  from (
    select * from public.weekly_okr_snapshots
    where (p_location_id is null or location_id = p_location_id)
    order by week_start desc
    limit 4
  ) s;
$function$;
comment on function public.analytics_weekly_okr is '최근 4주 OKR 스냅샷. 대시보드/Discord가 이걸로 조회(Query Contract 등록).';
