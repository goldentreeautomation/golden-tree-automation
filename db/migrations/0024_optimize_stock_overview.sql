-- 0024_optimize_stock_overview.sql — analytics_stock_overview 타임아웃 수정.
--
-- velocity CTE가 stock_items(50건) 각각에 대해 order_items를 개별적으로 조인해서 매번
-- 스캔했다 — 먼저 28일치를 (item_name, variation_name)별로 한 번만 집계한 뒤 stock_items에
-- 붙이는 방식으로 바꾼다. order_items(item_name, variation_name) 복합 인덱스도 추가.

create index if not exists order_items_name_variation_idx on public.order_items(item_name, variation_name);

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
-- 먼저 28일치를 품목·맛별로 한 번만 집계(전체 stock_items 개수와 무관하게 1회 스캔),
-- 그 다음 stock_items에 붙인다. stock_items마다 order_items를 개별 조인하던 이전 버전은
-- 50개 품목 × 전체 order_items 규모로 곱해져 타임아웃났다(실측, 2026-09-06).
item_daily_agg as (
  select oi.item_name, oi.variation_name, sum(oi.quantity) as total_units
  from public.order_items oi
  join public.orders_settled o on o.square_order_id = oi.square_order_id
  where o.business_date between (current_date - 28) and (current_date - 1)
  group by oi.item_name, oi.variation_name
),
velocity as (
  select si.id as stock_item_id,
    coalesce(a.total_units, 0) / 28.0 as avg_daily_units
  from public.stock_items si
  left join item_daily_agg a on a.item_name = si.square_item_name
    and a.variation_name is not distinct from si.square_variation_name
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
