-- 0013_add_sales_asof_timestamp.sql — 정확한 시각 기준 매출 비교.
--
-- 문제: 대시보드 "이번 주 vs 지난주" 비교가 business_date(날짜) 단위로만 잘랐다.
-- 예) 지금이 화요일 새벽 1시면 이번 주는 "월요일 전체 + 화요일 거의 0시간"인데,
-- 지난주는 "월요일 전체 + 화요일 전체"와 비교돼 항상 불공정하게 낮게 나온다.
-- (오너 지적, 2026-08-25)
--
-- 해결: created_at(실제 타임스탬프)을 기준으로 정확한 구간을 잘라 비교한다.
-- business_date/business_hour는 created_at을 America/Regina로 변환해 만든 값이므로
-- (sync/square/src/index.ts reginaParts()), created_at을 쓰면 일관성이 유지된다.

create or replace function public.analytics_location_sales_by_timestamp(
  p_start_ts timestamptz,
  p_end_ts timestamptz,
  p_location_id text default null
)
 returns table(location_id text, location_name text, net_sales numeric, order_count bigint, average_order_value numeric, tip numeric, refund_total numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  select
    o.location_id,
    coalesce(l.location_name, o.location_id) as location_name,
    round(sum(o.net_sales),2) as net_sales,
    count(*) as order_count,
    round(sum(o.net_sales) / nullif(count(*),0), 2) as average_order_value,
    round(sum(o.tip),2) as tip,
    round(coalesce(sum(r.refund_amt),0),2) as refund_total
  from public.orders_settled o
  left join public.locations l on l.square_location_id = o.location_id
  left join lateral (
    select sum(amount) as refund_amt
    from public.square_refunds r
    where r.order_id = o.square_order_id and r.status = 'COMPLETED'
  ) r on true
  where o.created_at >= p_start_ts and o.created_at < p_end_ts
    and (p_location_id is null or o.location_id = p_location_id)
  group by o.location_id, l.location_name
  order by l.location_name;
$function$;
