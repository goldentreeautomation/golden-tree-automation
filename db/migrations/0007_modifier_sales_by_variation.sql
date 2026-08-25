-- 0007_modifier_sales_by_variation.sql
--
-- 배경: "오트밀크 판매량을 12oz/16oz로 나눠서" — modifier_sales가 item_name으로만 묶여서
-- 사이즈(variation_name) 구분이 안 됐다. order_items.variation_name에 이미 있는 데이터라
-- 그룹핑 기준에 추가하면 된다.

create or replace function public.analytics_modifier_sales(p_start_date date, p_end_date date, p_modifier_name text, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
with mod_rows as (
  select oi.item_name, oi.variation_name, oi.square_order_id,
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
  select item_name, variation_name,
    sum(mod_qty) as quantity,
    count(distinct square_order_id) as order_count,
    round(sum(mod_revenue),2) as modifier_revenue
  from mod_rows
  group by item_name, variation_name
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
  'by_item_and_size', coalesce((select jsonb_agg(to_jsonb(bi) order by bi.quantity desc) from by_item bi),'[]'::jsonb)
) from totals t;
$function$;
