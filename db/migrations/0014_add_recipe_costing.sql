-- 0014_add_recipe_costing.sql — 레시피 원가율 감시 시스템 (오너 요청, 2026-08-25)
--
-- 목적: 레시피(재료+수량+생산량+제조시간)를 데이터화하고, 영수증으로 재료 단가를
-- 갱신하면서 "재료원가 ÷ 판매가"가 품목별 기준(기본 25%, 인건비 많이 드는 품목은
-- 오너가 개별로 낮춤, 예: 마카롱 20%)을 연속 30일 초과하면 Discord로 알린다.
--
-- 북키핑(QuickBooks)과 무관 — 순수 단가 갱신·원가율 감시 용도. 인건비(prep_time_minutes)는
-- 자동 계산에 안 쓰고 참고 기록만 한다 — 오너가 그 정보를 보고 품목별 target_cost_ratio를
-- 직접 낮추는 방식으로 반영(오너 명시적 결정, 2026-08-25).

create table if not exists public.ingredients (
  id bigint generated always as identity primary key,
  name text not null unique,
  unit text not null, -- 표준 단위: 'g', 'ml', 'each' 등. 레시피는 반드시 이 단위로 수량을 적는다
  current_unit_price numeric not null default 0, -- $/unit (CAD)
  last_updated_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
comment on table public.ingredients is '재료 마스터 + 현재 단가. 영수증 확정 시 current_unit_price가 갱신된다.';

create table if not exists public.receipts (
  id bigint generated always as identity primary key,
  vendor text,
  purchased_at date,
  total_amount numeric,
  image_storage_path text,
  raw_ocr jsonb not null default '{}'::jsonb,
  status text not null default 'pending_review' check (status in ('pending_review','confirmed','rejected')),
  uploaded_by text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
comment on table public.receipts is 'Discord로 올린 영수증 원본. OCR 결과는 raw_ocr에 감사용으로 보관.';

create table if not exists public.ingredient_price_history (
  id bigint generated always as identity primary key,
  ingredient_id bigint not null references public.ingredients(id),
  unit_price numeric not null,
  source_receipt_id bigint references public.receipts(id),
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
comment on table public.ingredient_price_history is '재료 단가 변경 이력 — 최신 구매가가 항상 current_unit_price가 된다(스무딩 없음, 오너 결정).';

create table if not exists public.receipt_line_items (
  id bigint generated always as identity primary key,
  receipt_id bigint not null references public.receipts(id) on delete cascade,
  raw_item_name text not null,
  matched_ingredient_id bigint references public.ingredients(id),
  quantity numeric,
  unit text,
  unit_price numeric,
  line_total numeric,
  match_confidence text check (match_confidence in ('high','medium','low','none')),
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
comment on table public.receipt_line_items is 'Gemini가 영수증 이미지에서 추출한 품목. confirmed=true가 되기 전까진 단가에 반영 안 됨.';

create table if not exists public.recipes (
  id bigint generated always as identity primary key,
  name text not null,
  location_id text, -- Square location_id. 특정 매장 전용 메뉴면 채움, 공통이면 null
  selling_price numeric not null,
  target_cost_ratio numeric not null default 0.25, -- 품목별로 오너가 낮출 수 있음(예: 마카롱 0.20)
  yield_quantity numeric not null default 1, -- 한 배치에 몇 개 나오는지
  prep_time_minutes numeric, -- 참고용 — 자동 알림 계산엔 안 씀
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.recipes is '메뉴 품목별 레시피. selling_price는 오너가 알려준 현재 판매가.';

create table if not exists public.recipe_ingredients (
  id bigint generated always as identity primary key,
  recipe_id bigint not null references public.recipes(id) on delete cascade,
  ingredient_id bigint not null references public.ingredients(id),
  quantity_per_batch numeric not null, -- ingredients.unit과 반드시 같은 단위
  unit text not null,
  unique (recipe_id, ingredient_id)
);

create table if not exists public.recipe_cost_daily_snapshots (
  id bigint generated always as identity primary key,
  recipe_id bigint not null references public.recipes(id),
  snapshot_date date not null,
  ingredient_cost_per_unit numeric not null,
  cost_ratio numeric not null,
  target_cost_ratio numeric not null,
  over_threshold boolean not null,
  created_at timestamptz not null default now(),
  unique (recipe_id, snapshot_date)
);
comment on table public.recipe_cost_daily_snapshots is '매일 1행 적재 — 연속 30일 초과 판단의 근거(오너 결정: 연속 기준).';

create table if not exists public.recipe_cost_alerts (
  id bigint generated always as identity primary key,
  recipe_id bigint not null references public.recipes(id),
  streak_start_date date not null,
  alerted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.recipe_cost_alerts is '한 레시피당 미해결(resolved_at is null) 알림은 최대 1건 — 같은 초과 구간에 중복 알림 방지.';

alter table public.ingredients enable row level security;
alter table public.receipts enable row level security;
alter table public.ingredient_price_history enable row level security;
alter table public.receipt_line_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_cost_daily_snapshots enable row level security;
alter table public.recipe_cost_alerts enable row level security;

create or replace view public.recipe_cost_current as
select
  r.id as recipe_id,
  r.name,
  r.location_id,
  r.selling_price,
  r.target_cost_ratio,
  r.yield_quantity,
  r.prep_time_minutes,
  r.active,
  coalesce(sum(ri.quantity_per_batch * i.current_unit_price), 0) as ingredient_cost_per_batch,
  round(coalesce(sum(ri.quantity_per_batch * i.current_unit_price), 0) / nullif(r.yield_quantity, 0), 4) as ingredient_cost_per_unit,
  round(
    (coalesce(sum(ri.quantity_per_batch * i.current_unit_price), 0) / nullif(r.yield_quantity, 0))
    / nullif(r.selling_price, 0), 4
  ) as cost_ratio
from public.recipes r
left join public.recipe_ingredients ri on ri.recipe_id = r.id
left join public.ingredients i on i.id = ri.ingredient_id
group by r.id;
comment on view public.recipe_cost_current is '현재 재료 단가 기준 실시간 원가율. 재료 단가가 바뀌면 이 뷰도 즉시 바뀐다.';

create or replace function public.recipe_cost_current_streak(p_recipe_id bigint, p_as_of date default current_date)
 returns integer
 language plpgsql stable
as $function$
declare
  v_streak integer := 0;
  v_date date := p_as_of;
  v_over boolean;
begin
  loop
    select over_threshold into v_over from public.recipe_cost_daily_snapshots
    where recipe_id = p_recipe_id and snapshot_date = v_date;
    exit when v_over is not true;
    v_streak := v_streak + 1;
    v_date := v_date - 1;
  end loop;
  return v_streak;
end;
$function$;

create or replace function public.analytics_recipe_cost_overview(p_location_id text default null)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'recipe_id', c.recipe_id,
    'name', c.name,
    'location_id', c.location_id,
    'selling_price', c.selling_price,
    'target_cost_ratio', c.target_cost_ratio,
    'ingredient_cost_per_unit', c.ingredient_cost_per_unit,
    'cost_ratio', c.cost_ratio,
    'over_threshold', c.cost_ratio > c.target_cost_ratio,
    'current_streak_days', recipe_cost_current_streak(c.recipe_id)
  ) order by c.cost_ratio desc nulls last), '[]'::jsonb)
  from public.recipe_cost_current c
  where c.active and (p_location_id is null or c.location_id = p_location_id or c.location_id is null);
$function$;
comment on function public.analytics_recipe_cost_overview is 'Discord/대시보드가 원가율 현황을 조회할 때 쓰는 함수. Query Contract에 등록.';
