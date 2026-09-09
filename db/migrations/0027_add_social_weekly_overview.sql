-- 0027_add_social_weekly_overview.sql — 주간 회의 OKR용 소셜 지표 집계 함수 (오너 요청, 2026-09-08)
--
-- 오너 요구사항: "회의에서 볼 소셜미디어 지표"를 오가닉(포스팅 수·조회수·좋아요/공유/댓글
-- 참여율)과 광고(집행했으면 클릭당 비용 + 팔로우당/결과당 비용)로 나눠서 보되, 광고를 돌린
-- 포스팅은 "오가닉으로 잘된 것"처럼 착시가 생기지 않도록 구분해야 한다.
--
-- 이 함수는 광고 캠페인명이 "Instagram post: ..." 로 시작하는(부스트된 포스트) 경우를 별도
-- 카테고리로 분리한다 — Meta가 "게시물 홍보하기(Boost post)"로 만든 캠페인은 이 접두사로
-- 자동 명명된다는 걸 실제 데이터로 확인함(social_ad_campaigns.raw_data). 완전한 post_id 단위
-- 연결(effective_object_story_id)은 아직 sync/meta에 없어 캠페인명 매칭까지만 한다 — 알려진 한계.

create or replace function public.analytics_social_weekly_overview(p_start_date date, p_end_date date, p_location_id text default null)
 returns jsonb
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_organic jsonb;
  v_boosted jsonb;
  v_other_ads jsonb;
begin
  select jsonb_build_object(
    'post_count', count(*),
    'total_views', coalesce(sum(m.views), 0),
    'total_likes', coalesce(sum(m.likes), 0),
    'total_comments', coalesce(sum(m.comments), 0),
    'total_shares', coalesce(sum(m.shares), 0),
    'engagement_rate_pct', case when sum(m.views) > 0
      then round((sum(m.likes) + sum(m.comments) + sum(m.shares))::numeric * 100 / sum(m.views), 2)
      else null end
  ) into v_organic
  from social_posts p
  left join lateral (
    select sm.likes, sm.comments, sm.shares, sm.views
    from social_post_metrics sm where sm.platform = p.platform and sm.post_id = p.post_id
    order by sm.captured_date desc limit 1
  ) m on true
  where p.published_date between p_start_date and p_end_date
    and (p_location_id is null
         or (p_location_id in ('LWEFT8C6SXJ7J','17841478338651157','Bon Sushi') and p.account_id = '17841478338651157')
         or (p_location_id in ('L7DA0MBKD2X4P','17841472136242619','Cozy House','CozyHaus','Cozyhaus') and p.account_id = '17841472136242619'));

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_boosted
  from (
    select c.campaign_name, c.objective,
           round(sum(m.spend), 2) spend, sum(m.clicks) clicks,
           round(case when sum(m.clicks) > 0 then sum(m.spend) / sum(m.clicks) else null end, 2) cpc,
           round(case when sum(m.results) > 0 then sum(m.spend) / sum(m.results) else null end, 2) cost_per_result
    from social_ad_campaigns c
    join social_ad_metrics m on m.platform = c.platform and m.campaign_id = c.campaign_id
    where m.metric_date between p_start_date and p_end_date
      and c.campaign_name ilike 'Instagram post:%'
      and (p_location_id is null
           or (p_location_id in ('LWEFT8C6SXJ7J','Bon Sushi') and c.campaign_name ilike '%bon%')
           or (p_location_id in ('L7DA0MBKD2X4P','Cozy House','CozyHaus','Cozyhaus') and c.campaign_name ilike '%cozy%'))
    group by c.campaign_id, c.campaign_name, c.objective
  ) x;

  select jsonb_build_object(
    'spend', coalesce(round(sum(m.spend), 2), 0),
    'clicks', coalesce(sum(m.clicks), 0),
    'cpc', case when sum(m.clicks) > 0 then round(sum(m.spend) / sum(m.clicks), 2) else null end,
    'cost_per_result', case when sum(m.results) > 0 then round(sum(m.spend) / sum(m.results), 2) else null end
  ) into v_other_ads
  from social_ad_campaigns c
  join social_ad_metrics m on m.platform = c.platform and m.campaign_id = c.campaign_id
  where m.metric_date between p_start_date and p_end_date
    and c.campaign_name not ilike 'Instagram post:%'
    and (p_location_id is null
         or (p_location_id in ('LWEFT8C6SXJ7J','Bon Sushi') and c.campaign_name ilike '%bon%')
         or (p_location_id in ('L7DA0MBKD2X4P','Cozy House','CozyHaus','Cozyhaus') and c.campaign_name ilike '%cozy%'));

  return jsonb_build_object('organic', v_organic, 'boosted_posts', v_boosted, 'other_ads', v_other_ads);
end
$function$;
comment on function public.analytics_social_weekly_overview is '주간 회의용 소셜 지표: 오가닉(포스팅수·조회수·참여율) vs 부스트된 포스트 광고(캠페인명 "Instagram post:" 접두사로 식별) vs 기타 광고. post_id 직접 연결 아님 — 캠페인명 매칭 한계 있음.';
