-- 0017_social_dates_as_generated_columns.sql — published_date/created_date를 generated
-- column으로 전환. 0016에서는 일반 컬럼이라 sync/meta 코드가 매번 채워줘야 하는데, 빠뜨리면
-- 같은 버그가 재발한다. DB가 published_at/created_at으로부터 항상 자동 계산하게 하면
-- 동기화 코드가 이 필드를 몰라도(신경 안 써도) 항상 정확하다.

alter table public.social_posts drop column published_date;
alter table public.social_posts add column published_date date
  generated always as ((published_at at time zone 'America/Regina')::date) stored;

alter table public.social_comments drop column created_date;
alter table public.social_comments add column created_date date
  generated always as ((created_at at time zone 'America/Regina')::date) stored;
