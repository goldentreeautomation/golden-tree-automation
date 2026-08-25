-- 0011_add_market_demand_dow_profile.sql
--
-- "과거 같은 요일·시간대 실적" 신호(-20~+20)를 계산하려면, 오늘 요일의 기준선이 다른
-- 요일들 대비 평소 강한지 약한지를 알아야 한다(예: "화요일의 평소 수요가 낮음"). 요일별
-- 평균을 한 번에 반환한다.

create or replace function public.market_demand_dow_profile(
  p_location_id text, p_period text, p_lookback_weeks integer default 8
)
 returns table(dow integer, avg_net_sales numeric)
 language sql stable security definer set search_path to 'public'
as $function$
with hours as (
  select case p_period
    when 'morning' then int4range(6,11)
    when 'afternoon' then int4range(11,17)
    when 'evening' then int4range(17,24)
  end as hr
),
daily as (
  select o.business_date, extract(dow from o.business_date)::integer as dow, sum(o.net_sales) as net_sales
  from public.orders_settled o, hours h
  where o.location_id = p_location_id
    and o.business_hour <@ h.hr
    and o.business_date between current_date - (p_lookback_weeks * 7) and current_date - 1
  group by o.business_date
)
select dow, round(avg(net_sales),2) from daily group by dow order by dow;
$function$;
