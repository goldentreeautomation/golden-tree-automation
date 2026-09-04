-- 0018_add_post_ai_visual_description.sql — 포스트 사진/영상 AI 설명 (오너 요청, 2026-09-04)
--
-- 캡션이 애매해서 무슨 메뉴 포스트인지 알기 어려운 경우가 있음. Instagram media_url/
-- thumbnail_url은 서명된 임시 링크라 며칠 지나면 만료된다(실측: 4개월 전 포스트 403) —
-- 그래서 발행 직후(sync/meta) 링크가 살아있을 때 Gemini Vision으로 한 번 설명을 뽑아
-- 영구 저장한다. 이미 지난(링크 죽은) 과거 포스트는 소급 적용 안 함(오너 결정).

alter table public.social_posts add column if not exists ai_visual_description text;

-- CREATE OR REPLACE VIEW은 기존 컬럼 순서 중간에 새 컬럼을 못 끼워 넣는다(42P16) — 끝에 추가.
create or replace view public.social_posts_ingest as
 select platform,
    post_id,
    account_id,
    caption,
    media_type,
    media_url,
    permalink,
    published_at,
    product_tags,
    category_tags,
    raw_data,
    updated_at,
    ai_visual_description
   from social_posts;

create or replace function public.upsert_social_post_from_view()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.social_posts(platform, post_id, account_id, caption, media_type, media_url,
                                  ai_visual_description, permalink,
                                  published_at, product_tags, category_tags, raw_data, updated_at)
  values (new.platform, new.post_id, new.account_id, new.caption, new.media_type, new.media_url,
          new.ai_visual_description, new.permalink,
          new.published_at, coalesce(new.product_tags, '{}'), coalesce(new.category_tags, '{}'),
          coalesce(new.raw_data, '{}'::jsonb), coalesce(new.updated_at, now()))
  on conflict (platform, post_id) do update set
    account_id = excluded.account_id,
    caption = excluded.caption,
    media_type = excluded.media_type,
    media_url = excluded.media_url,
    ai_visual_description = coalesce(excluded.ai_visual_description, public.social_posts.ai_visual_description),
    permalink = excluded.permalink,
    published_at = excluded.published_at,
    raw_data = excluded.raw_data,
    updated_at = excluded.updated_at;
  return new;
end; $function$;
