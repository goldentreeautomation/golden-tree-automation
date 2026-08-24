-- 0006_add_modifier_sales.sql
--
-- 배경: 오너 요청 — 오트밀크처럼 modifier(옵션) 단위 주문 건수를 보고 싶다. item_name이
-- 아니라 각 order_item의 raw JSONB 안 modifiers 배열에 들어있는 항목이라 별도 함수가 필요함.
-- Square 원본에 이미 다 들어있음(raw->'modifiers') — "Oat Milk"/"Oat Milk "처럼 트레일링
-- 스페이스 불일치가 있어 trim으로 병합한다.

create or replace function public.analytics_modifier_sales(p_start_date date, p_end_date date, p_modifier_name text, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
with mod_rows as (
  select oi.item_name, oi.square_order_id,
    coalesce((mod->>'quantity')::numeric,1) as mod_qty,
    coalesce((mod#>>'{total_price_money,amount}')::numeric,0)/100 as mod_revenue
  from public.order_items oi
  join public.orders_settled o on o.square_order_id = oi.square_order_id
  cross join lateral jsonb_array_elements(coalesce(oi.raw->'modifiers','[]'::jsonb)) mod
  where o.business_date between p_start_date and p_end_date
    and (p_location_id is null or o.location_id = p_location_id)
    and trim(mod->>'name') ilike trim(p_modifier_name)
),
by_item as (
  select item_name,
    sum(mod_qty) as quantity,
    count(distinct square_order_id) as order_count,
    round(sum(mod_revenue),2) as modifier_revenue
  from mod_rows
  group by item_name
),
totals as (
  select coalesce(sum(quantity),0) as total_quantity,
    coalesce(sum(order_count),0) as total_order_count,
    coalesce(round(sum(modifier_revenue),2),0) as total_modifier_revenue
  from by_item
)
select jsonb_build_object(
  'modifier', p_modifier_name,
  'start_date', p_start_date,
  'end_date', p_end_date,
  'total_quantity', t.total_quantity,
  'total_order_count', t.total_order_count,
  'total_modifier_revenue', t.total_modifier_revenue,
  'by_item', coalesce((select jsonb_agg(to_jsonb(bi) order by bi.quantity desc) from by_item bi),'[]'::jsonb)
) from totals t;
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
 when 'modifier_sales' then
   if nullif(trim(p_item_name),'') is null then raise exception 'item_name is required for modifier_sales (modifier name)'; end if;
   v_result:=analytics_modifier_sales(p_start_date,p_end_date,p_item_name,p_location_id);
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
