-- 0005_add_post_item_sales_trend.sql
--
-- 배경: 오너 요청 — "마차라떼", "연어 스시"처럼 특정 메뉴를 홍보한 포스트가 있으면, 그 메뉴의
-- 매출이 포스트 발행일(0일차) 이후 1~3일 동안 어떻게 변했는지 보고 싶다. 0004의
-- analytics_social_sales_correlation은 매장 전체 매출 기준이었는데, 이건 특정 품목 단위로
-- 더 좁혀서 본다.
--
-- 매칭 방식: 포스트 캡션/태그에 검색어(영어 메뉴명)가 들어있는 포스트를 찾고, 그 포스트
-- 발행일부터 N일간 해당 품목의 일별 매출을 보여준다. 캡션이 영어라 한글 메뉴명으로는
-- 안 잡힐 수 있음 — 라우터(Gemini)가 실제 영어 메뉴명으로 변환해서 넣도록 안내한다.

create or replace function public.analytics_post_item_sales_trend(
  p_start_date date, p_end_date date, p_item_name text, p_location_id text default null::text, p_days_after integer default 3
)
 returns table(
   post_id text, caption text, published_at timestamptz, post_business_date date, location_id text,
   day_offset integer, business_date date, item_net_sales numeric, item_quantity numeric, item_order_count bigint
 )
 language sql stable security definer set search_path to 'public'
as $function$
with matched_posts as (
  select p.post_id, p.caption, p.published_at,
    (p.published_at at time zone 'America/Regina')::date as post_business_date,
    case when p.account_id='17841478338651157' then 'LWEFT8C6SXJ7J'
         when p.account_id='17841472136242619' then 'L7DA0MBKD2X4P'
         else null end as location_id
  from public.social_posts p
  where p.published_at::date between p_start_date and p_end_date
    and (p.caption ilike '%'||p_item_name||'%'
         or p_item_name = any(coalesce(p.product_tags,array[]::text[]))
         or p_item_name = any(coalesce(p.category_tags,array[]::text[])))
),
offsets as (
  select generate_series(0, greatest(0,least(coalesce(p_days_after,3),14))) as day_offset
),
item_daily as (
  select o.business_date, o.location_id,
    sum(oi.net_sales) as net_sales, sum(oi.quantity) as quantity, count(distinct oi.square_order_id) as order_count
  from public.order_items oi
  join public.orders_settled o on o.square_order_id = oi.square_order_id
  where oi.item_name ilike '%'||p_item_name||'%'
  group by 1,2
)
select mp.post_id, mp.caption, mp.published_at, mp.post_business_date, mp.location_id,
  ofs.day_offset, (mp.post_business_date + ofs.day_offset) as business_date,
  coalesce(d.net_sales,0), coalesce(d.quantity,0), coalesce(d.order_count,0)
from matched_posts mp
cross join offsets ofs
left join item_daily d on d.business_date = mp.post_business_date + ofs.day_offset and d.location_id = mp.location_id
where mp.location_id is not null
  and (p_location_id is null or mp.location_id = p_location_id)
order by mp.published_at desc, ofs.day_offset;
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
 when 'post_item_trend' then
   if nullif(trim(p_item_name),'') is null then raise exception 'item_name is required for post_item_trend'; end if;
   select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result
   from analytics_post_item_sales_trend(p_start_date,p_end_date,p_item_name,p_location_id,3) x;
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
