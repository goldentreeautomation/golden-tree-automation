-- 0012_add_market_demand_query.sql — 대시보드/Discord가 쓸 조회 함수.
-- 오늘 각 period의 최신 스냅샷 + 어제 같은 period 대비 변화.

create or replace function public.analytics_market_demand_latest(p_location_id text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
with today_latest as (
  select distinct on (period) *
  from public.market_demand_snapshots
  where brand_id = p_location_id
    and forecast_for = (now() at time zone 'America/Regina')::date
  order by period, calculated_at desc
),
yesterday_latest as (
  select distinct on (period) period, score
  from public.market_demand_snapshots
  where brand_id = p_location_id
    and forecast_for = ((now() at time zone 'America/Regina')::date - 1)
  order by period, calculated_at desc
)
select jsonb_build_object(
  'location_id', p_location_id,
  'forecast_for', (now() at time zone 'America/Regina')::date,
  'periods', coalesce((
    select jsonb_agg(jsonb_build_object(
      'period', t.period,
      'score', t.score,
      'demand_band', t.demand_band,
      'confidence', t.confidence,
      'weather_impact', t.weather_impact,
      'event_impact', t.event_impact,
      'calendar_impact', t.calendar_impact,
      'search_impact', t.search_impact,
      'operations_impact', t.operations_impact,
      'reasons', t.reasons,
      'source_status', t.source_status,
      'calculated_at', t.calculated_at,
      'vs_yesterday', case when y.score is not null then t.score - y.score else null end
    ) order by case t.period when 'morning' then 1 when 'afternoon' then 2 else 3 end)
    from today_latest t
    left join yesterday_latest y on y.period = t.period
  ), '[]'::jsonb)
);
$function$;
