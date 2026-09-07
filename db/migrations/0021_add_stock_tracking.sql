-- 0021_add_stock_tracking.sql — 재고(완제품) 트래킹 (오너 요청, 2026-09-06)
--
-- 목적: "지금 뭘 만들어야 하나" / "2호점에 뭘 보내야 하나" 판단용. 재료 원가와 무관,
-- 완제품(마카롱 등) 통 단위 재고. 정확한 개수 대신 "통" 단위(1.5통 등 소수 허용)로 빠르게
-- 기록하고, 그 사이 실제 판매량(Square)을 자동으로 차감해 매번 세지 않아도 현재 재고를
-- 추정한다.
--
-- 메커니즘: 'count'(그날 실제로 센 통 수, 기준점 리셋) / 'production'(방금 만든 통 수, 기준점에
-- 더해짐) 두 이벤트만 기록. 현재 추정 재고 = 마지막 count 이후 생산분 합 − 그 이후 Square
-- 판매량. 다음 count가 오면 그동안 쌓인 오차(폐기·서비스 등 기록 안 된 것)가 자동으로 보정됨.

create table if not exists public.stock_items (
  id bigint generated always as identity primary key,
  name text not null,                        -- 사람이 보는 이름, 예: "마카롱 - 피스타치오"
  location_id text not null,                  -- Square location_id
  square_item_name text not null,             -- order_items.item_name과 매칭
  square_variation_name text,                 -- order_items.variation_name과 매칭. null이면 품목 전체(맛 구분 없음) 합산
  units_per_container numeric not null default 1,  -- 한 통(또는 트레이 등)에 몇 개
  container_label text not null default '통',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (location_id, name)
);
comment on table public.stock_items is '완제품 재고 추적 대상. 재료(ingredients)와 다름 — 판매 가능한 완성품 단위.';

create table if not exists public.stock_events (
  id bigint generated always as identity primary key,
  stock_item_id bigint not null references public.stock_items(id),
  event_type text not null check (event_type in ('count','production')),
  container_count numeric not null check (container_count >= 0),  -- 1.5통 등 소수 허용
  occurred_at timestamptz not null default now(),
  note text,
  created_by text,                            -- discord 사용자명/ID
  created_at timestamptz not null default now()
);
comment on table public.stock_events is 'count=그때 실제로 센 통 수(기준점 리셋). production=방금 만든 통 수(기준점에 더해짐).';

create index if not exists stock_events_item_time_idx on public.stock_events(stock_item_id, occurred_at desc);

alter table public.stock_items enable row level security;
alter table public.stock_events enable row level security;

create or replace function public.analytics_stock_overview(p_location_id text default null)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
with last_count as (
  select distinct on (stock_item_id) stock_item_id, container_count as counted_containers, occurred_at as counted_at
  from public.stock_events
  where event_type = 'count'
  order by stock_item_id, occurred_at desc
),
production_since as (
  select se.stock_item_id, coalesce(sum(se.container_count), 0) as produced_containers
  from public.stock_events se
  join last_count lc on lc.stock_item_id = se.stock_item_id
  where se.event_type = 'production' and se.occurred_at > lc.counted_at
  group by se.stock_item_id
),
sold_since as (
  select si.id as stock_item_id,
    coalesce(sum(oi.quantity), 0) as sold_units
  from public.stock_items si
  join last_count lc on lc.stock_item_id = si.id
  left join public.order_items oi on oi.item_name = si.square_item_name
    and (si.square_variation_name is null or oi.variation_name = si.square_variation_name)
  left join public.orders_settled o on o.square_order_id = oi.square_order_id
    and o.location_id = si.location_id and o.created_at > lc.counted_at
  where o.square_order_id is not null
  group by si.id
),
velocity as (
  -- 최근 28일 평균 일일 판매량 (재고 없는 신제품은 0으로 방어)
  select si.id as stock_item_id,
    coalesce(sum(oi.quantity), 0) / 28.0 as avg_daily_units
  from public.stock_items si
  left join public.order_items oi on oi.item_name = si.square_item_name
    and (si.square_variation_name is null or oi.variation_name = si.square_variation_name)
  left join public.orders_settled o on o.square_order_id = oi.square_order_id
    and o.location_id = si.location_id
    and o.business_date between (current_date - 28) and (current_date - 1)
  group by si.id
)
select coalesce(jsonb_agg(jsonb_build_object(
  'stock_item_id', si.id,
  'name', si.name,
  'location_id', si.location_id,
  'container_label', si.container_label,
  'units_per_container', si.units_per_container,
  'last_count_at', lc.counted_at,
  'last_count_containers', lc.counted_containers,
  'produced_since_count', coalesce(ps.produced_containers, 0),
  'sold_units_since_count', coalesce(ss.sold_units, 0),
  'estimated_units', case when lc.counted_at is null then null else
    round((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0), 1)
  end,
  'estimated_containers', case when lc.counted_at is null then null else
    round(((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) / nullif(si.units_per_container,0), 2)
  end,
  'avg_daily_units', round(coalesce(v.avg_daily_units,0), 1),
  'days_left', case when lc.counted_at is null or coalesce(v.avg_daily_units,0) = 0 then null else
    round((((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) / v.avg_daily_units)::numeric, 1)
  end,
  'status', case
    when lc.counted_at is null then '기록없음'
    when ((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) <= 0 then '없음'
    when coalesce(v.avg_daily_units,0) = 0 then '알수없음'
    when (((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) / v.avg_daily_units) < 0.5 then '거의없음'
    when (((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) / v.avg_daily_units) < 1 then '조금여유'
    when (((coalesce(lc.counted_containers,0) + coalesce(ps.produced_containers,0)) * si.units_per_container - coalesce(ss.sold_units,0)) / v.avg_daily_units) < 2 then '보통'
    else '충분'
  end
) order by si.name), '[]'::jsonb)
from public.stock_items si
left join last_count lc on lc.stock_item_id = si.id
left join production_since ps on ps.stock_item_id = si.id
left join sold_since ss on ss.stock_item_id = si.id
left join velocity v on v.stock_item_id = si.id
where si.active and (p_location_id is null or si.location_id = p_location_id);
$function$;
comment on function public.analytics_stock_overview is 'Discord/대시보드용 현재 재고 추정치+상태. Query Contract 등록.';
