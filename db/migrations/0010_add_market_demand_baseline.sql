-- 0010_add_market_demand_baseline.sql
--
-- "시장 수요 예상"의 과거 실적 신호(-20~+20) 계산에 쓸 함수. 같은 요일·같은 시간대(period)의
-- 최근 8주 평균과, 그 시간대 실적을 비교한다. period → business_hour 매핑은 두 매장 실제
-- 영업시간(오전 8:30~/11:30~, 저녁 21~22시 마감)에 맞춤.

create or replace function public.market_demand_baseline(
  p_location_id text, p_period text, p_target_date date, p_lookback_weeks integer default 8
)
 returns table(avg_net_sales numeric, avg_order_count numeric, sample_weeks integer)
 language sql stable security definer set search_path to 'public'
as $function$
with hours as (
  select case p_period
    when 'morning' then int4range(6,11)
    when 'afternoon' then int4range(11,17)
    when 'evening' then int4range(17,24)
  end as hr
),
weekly as (
  select o.business_date, sum(o.net_sales) as net_sales, count(*) as order_count
  from public.orders_settled o, hours h
  where o.location_id = p_location_id
    and o.business_hour <@ h.hr
    and o.business_date between p_target_date - (p_lookback_weeks * 7) and p_target_date - 1
    and extract(dow from o.business_date) = extract(dow from p_target_date)
  group by o.business_date
)
select round(avg(net_sales),2), round(avg(order_count),2), count(*)::integer from weekly;
$function$;
