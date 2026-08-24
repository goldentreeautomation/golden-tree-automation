-- 0003_fix_ad_metric_trigger_null_results.sql
--
-- 배경: Meta 전체 백필 중 발견 — campaign_id=120216568718830646(ARCHIVED, LINK_CLICKS)이
-- Meta의 /campaigns 목록 API에 아예 안 잡혀서(원인 미상, effective_status 필터로도 못 찾음)
-- social_ad_campaigns에 해당 캠페인 행이 없는 상태에서 그 캠페인의 광고 지표가 들어왔다.
-- upsert_social_ad_metric_from_view가 campaign 목표(objective)를 못 찾으면 v_objective가
-- null이 되고, CASE 어느 분기에도 안 걸려 results가 null로 나가 NOT NULL 제약을 위반해
-- 배치 전체(social_ad_metrics 200건)가 롤백됐다.
--
-- 수정: 목표를 못 찾으면(v_objective is null) 0으로 대체 — 크래시 대신 "결과 미상" 취급.

create or replace function public.upsert_social_ad_metric_from_view()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
 v_objective text;
 v_results numeric;
begin
 select objective into v_objective
 from public.social_ad_campaigns
 where platform=new.platform and campaign_id=new.campaign_id;

 v_results := coalesce(case v_objective
  when 'PAGE_LIKES' then coalesce((select sum((a->>'value')::numeric) from jsonb_array_elements(coalesce(new.raw_data->'actions','[]'::jsonb)) a where a->>'action_type'='like'),0)
  when 'LINK_CLICKS' then coalesce(new.link_clicks,0)
  when 'POST_ENGAGEMENT' then coalesce((select sum((a->>'value')::numeric) from jsonb_array_elements(coalesce(new.raw_data->'actions','[]'::jsonb)) a where a->>'action_type'='post_engagement'),0)
  when 'OUTCOME_ENGAGEMENT' then coalesce((select sum((a->>'value')::numeric) from jsonb_array_elements(coalesce(new.raw_data->'actions','[]'::jsonb)) a where a->>'action_type'='post_engagement'),0)
  when 'VIDEO_VIEWS' then coalesce((select sum((a->>'value')::numeric) from jsonb_array_elements(coalesce(new.raw_data->'actions','[]'::jsonb)) a where a->>'action_type'='video_view'),0)
  when 'REACH' then coalesce(new.reach,0)
  when 'OUTCOME_AWARENESS' then coalesce(new.reach,0)
  when 'MESSAGES' then coalesce((select sum((a->>'value')::numeric) from jsonb_array_elements(coalesce(new.raw_data->'actions','[]'::jsonb)) a where a->>'action_type' in ('onsite_conversion.messaging_conversation_started_7d','onsite_conversion.messaging_first_reply')),0)
  else null
 end, 0);

 insert into public.social_ad_metrics(
  platform,campaign_id,metric_date,spend,impressions,reach,clicks,link_clicks,results,
  conversions,purchase_value,ctr,cpc,cpm,raw_data,captured_at
 ) values(
  new.platform,new.campaign_id,new.metric_date,coalesce(new.spend,0),coalesce(new.impressions,0),
  coalesce(new.reach,0),coalesce(new.clicks,0),coalesce(new.link_clicks,0),v_results,
  coalesce(new.conversions,0),coalesce(new.purchase_value,0),coalesce(new.ctr,0),
  coalesce(new.cpc,0),coalesce(new.cpm,0),coalesce(new.raw_data,'{}'::jsonb),coalesce(new.captured_at,now())
 )
 on conflict(platform,campaign_id,metric_date) do update set
  spend=excluded.spend,impressions=excluded.impressions,reach=excluded.reach,clicks=excluded.clicks,
  link_clicks=excluded.link_clicks,results=excluded.results,conversions=excluded.conversions,
  purchase_value=excluded.purchase_value,ctr=excluded.ctr,cpc=excluded.cpc,cpm=excluded.cpm,
  raw_data=excluded.raw_data,captured_at=excluded.captured_at;
 return new;
end;
$function$;
