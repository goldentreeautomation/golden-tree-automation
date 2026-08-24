-- 0004_add_social_sales_correlation.sql
--
-- 배경: 오너 요청 — 인스타 포스팅과 매출의 "상관관계"를 보고 싶다. 인과관계 증명은 불가능하다고
-- 오너도 인지함(포스트 하나 때문에 매출이 얼마 늘었는지 확정할 방법은 없음). 대신 포스트를
-- 올린 날의 실제 매출을, "같은 요일 최근 4주 평균"과 비교해서 보여준다 — 이 기준은 이미
-- 설계서 W6(이상 감지)에서 "같은 요일 최근 4주 평균 대비 ±25%"로 정한 것을 그대로 재사용한다
-- (docs/golden-tree-design.md W6). 원래 M3 Phase 6("광고와 매출 연결")이었으나 이 부분만
-- 앞당김 — docs/golden-tree-design.md M2~M3 착수 순서 표 참조.

create or replace function public.analytics_social_sales_correlation(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns table(
   post_id text, caption text, published_at timestamptz, business_date date, location_id text,
   likes bigint, comments bigint, shares bigint, saves bigint, total_interactions bigint,
   day_net_sales numeric, day_order_count bigint,
   baseline_avg_net_sales numeric, vs_baseline_pct numeric
 )
 language sql stable security definer set search_path to 'public'
as $function$
with post_days as (
  select p.post_id, p.caption, p.published_at,
    (p.published_at at time zone 'America/Regina')::date as business_date,
    case when p.account_id='17841478338651157' then 'LWEFT8C6SXJ7J'
         when p.account_id='17841472136242619' then 'L7DA0MBKD2X4P'
         else null end as location_id,
    m.likes, m.comments, m.shares, m.saves, m.total_interactions
  from public.social_posts p
  left join lateral (
    select sm.likes, sm.comments, sm.shares, sm.saves, sm.total_interactions
    from public.social_post_metrics sm
    where sm.platform = p.platform and sm.post_id = p.post_id
    order by sm.captured_date desc limit 1
  ) m on true
  where p.published_at::date between p_start_date and p_end_date
),
day_sales as (
  select o.business_date, o.location_id, sum(o.net_sales) as net_sales, count(*) as order_count
  from public.orders_settled o
  group by 1, 2
),
baseline as (
  -- 같은 요일, 발행일 직전 4주 평균 (발행일 당일은 제외 — 기준선이 그날 값에 오염되지 않게)
  select pd.post_id, avg(ds2.net_sales) as baseline_avg
  from post_days pd
  join day_sales ds2
    on ds2.location_id = pd.location_id
   and ds2.business_date between pd.business_date - 28 and pd.business_date - 1
   and extract(dow from ds2.business_date) = extract(dow from pd.business_date)
  group by pd.post_id
)
select
  pd.post_id, pd.caption, pd.published_at, pd.business_date, pd.location_id,
  coalesce(pd.likes,0), coalesce(pd.comments,0), coalesce(pd.shares,0), coalesce(pd.saves,0), coalesce(pd.total_interactions,0),
  coalesce(ds.net_sales,0) as day_net_sales,
  coalesce(ds.order_count,0) as day_order_count,
  round(b.baseline_avg,2) as baseline_avg_net_sales,
  case when b.baseline_avg is null or b.baseline_avg = 0 then null
       else round(100 * (coalesce(ds.net_sales,0) - b.baseline_avg) / b.baseline_avg, 1)
  end as vs_baseline_pct
from post_days pd
left join day_sales ds on ds.business_date = pd.business_date and ds.location_id = pd.location_id
left join baseline b on b.post_id = pd.post_id
where pd.location_id is not null
  and (p_location_id is null or pd.location_id = p_location_id)
order by pd.published_at desc;
$function$;

create or replace function public.analytics_dispatch(p_analysis text, p_start_date date, p_end_date date, p_location_id text default null::text, p_limit integer default 10, p_compare_start date default null::date, p_compare_end date default null::date, p_item_name text default null::text)
 returns jsonb
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_result jsonb;
begin
 if p_start_date is null or p_end_date is null or p_start_date>p_end_date then
   raise exception 'Valid start and end dates are required';
 end if;
 if p_analysis<>'social_campaigns' and p_end_date-p_start_date>730 then raise exception 'Date range cannot exceed 730 days'; end if;
 p_limit:=greatest(1,least(coalesce(p_limit,10),50));
 case p_analysis
 when 'sales_summary' then v_result:=analytics_sales_summary_v2(p_start_date,p_end_date,p_location_id);
 when 'location_sales' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_location_sales_v2(p_start_date,p_end_date)x;
 when 'comparison' then
   v_result:=analytics_compare_periods(p_start_date,p_end_date,p_compare_start,p_compare_end,p_location_id);
 when 'top_items' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_top_items(p_start_date,p_end_date,p_limit,p_location_id,'net_sales')x;
 when 'item_sales' then
   if nullif(trim(p_item_name),'') is null then raise exception 'item_name is required for item_sales'; end if;
   v_result:=analytics_item_sales(p_start_date,p_end_date,p_item_name,p_location_id);
 when 'hourly_sales' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_hourly_sales(p_start_date,p_end_date,p_location_id)x;
 when 'daily_sales' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_daily_sales(p_start_date,p_end_date,p_location_id)x;
 when 'monthly_sales' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_monthly_sales(p_start_date,p_end_date,p_location_id)x;
 when 'customer_retention' then
   v_result:=analytics_customer_retention(p_start_date,p_end_date,p_location_id);
 when 'category_sales' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_category_sales(p_start_date,p_end_date,p_location_id)x;
 when 'social_sales_correlation' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from (
     select * from analytics_social_sales_correlation(p_start_date,p_end_date,p_location_id)
     order by published_at desc limit p_limit
   ) x;
 when 'social_posts' then
   select coalesce(jsonb_agg(to_jsonb(x) order by x.total_interactions desc nulls last),'[]'::jsonb) into v_result
   from (
     select case when p.account_id='17841478338651157' then 'Bon Sushi'
                 when p.account_id='17841472136242619' then 'Cozy House'
                 else p.account_id end as business_name,
            p.post_id,p.caption,p.media_type,p.permalink,p.published_at,
            p.product_tags,p.category_tags,
            m.likes,m.comments,m.shares,m.saves,m.reach,m.views,m.total_interactions
     from social_posts p
     left join lateral (
       select sm.likes,sm.comments,sm.shares,sm.saves,sm.reach,sm.views,sm.total_interactions
       from social_post_metrics sm where sm.platform=p.platform and sm.post_id=p.post_id
       order by sm.captured_date desc limit 1
     ) m on true
     where p.published_at::date between p_start_date and p_end_date
       and (p_location_id is null
            or (p_location_id in ('LWEFT8C6SXJ7J','17841478338651157','Bon Sushi') and p.account_id='17841478338651157')
            or (lower(p_location_id) like '%cozy%' and p.account_id='17841472136242619'))
       and (nullif(trim(p_item_name),'') is null
            or p.caption ilike '%'||p_item_name||'%'
            or p_item_name=any(coalesce(p.product_tags,array[]::text[]))
            or p_item_name=any(coalesce(p.category_tags,array[]::text[])))
     order by m.total_interactions desc nulls last
     limit p_limit
   ) x;
 when 'social_campaigns' then
       v_result:=analytics_social_campaigns(p_start_date,p_end_date,p_location_id,p_limit);
      when 'social_ads' then
   select coalesce(jsonb_agg(to_jsonb(x) order by x.spend desc),'[]'::jsonb) into v_result
   from (
     select c.campaign_id,c.campaign_name,c.objective,c.status,
            round(sum(m.spend),2) spend,sum(m.impressions) impressions,sum(m.reach) reach,
            sum(m.clicks) clicks,sum(m.link_clicks) link_clicks,
            round(sum(m.results),2) results,round(sum(m.conversions),2) conversions,
            round(sum(m.purchase_value),2) purchase_value,
            round(case when sum(m.impressions)>0 then sum(m.clicks)::numeric*100/sum(m.impressions) else 0 end,2) ctr,
            round(case when sum(m.clicks)>0 then sum(m.spend)/sum(m.clicks) else 0 end,2) cpc
     from social_ad_campaigns c join social_ad_metrics m
       on m.platform=c.platform and m.campaign_id=c.campaign_id
     where m.metric_date between p_start_date and p_end_date
       and (nullif(trim(p_item_name),'') is null or c.campaign_name ilike '%'||p_item_name||'%')
       and (p_location_id is null
            or (p_location_id in ('LWEFT8C6SXJ7J','Bon Sushi') and c.campaign_name ilike '%bon%')
            or (lower(p_location_id) like '%cozy%' and c.campaign_name ilike '%cozy%'))
     group by c.campaign_id,c.campaign_name,c.objective,c.status
     order by sum(m.spend) desc limit p_limit
   ) x;
 when 'social_comments' then
   select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into v_result
   from (
     select case when c.account_id='17841478338651157' then 'Bon Sushi'
                 when c.account_id='17841472136242619' then 'Cozy House'
                 else c.account_id end business_name,
            c.comment_id,c.post_id,c.message,c.sentiment,c.topic_summary,c.created_at,c.like_count,c.reply_count
     from social_comments c
     where c.created_at::date between p_start_date and p_end_date
       and (p_location_id is null
            or (p_location_id in ('LWEFT8C6SXJ7J','17841478338651157','Bon Sushi') and c.account_id='17841478338651157')
            or (lower(p_location_id) like '%cozy%' and c.account_id='17841472136242619'))
       and (nullif(trim(p_item_name),'') is null or c.message ilike '%'||p_item_name||'%')
     order by c.created_at desc limit p_limit
   ) x;
 else raise exception 'Unsupported analysis type: %',p_analysis;
 end case;
 return jsonb_build_object('analysis',p_analysis,'start_date',p_start_date,'end_date',p_end_date,'data',v_result);
end
$function$;
