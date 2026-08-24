-- 0001_fix_open_order_inclusion_and_net_sales.sql
--
-- 배경: docs/decisions/0001-legacy-square-data-verification.md
-- 오너가 제보한 16개 레거시(n8n) 오류를 실제 데이터로 재검증한 결과, 근본 원인은
-- 대부분 하나로 좁혀졌다 — analytics_* 함수 13개 중 9개가 `state='COMPLETED'`만
-- 필터링해 "결제는 끝났지만 상태가 아직 OPEN인 주문"을 누락시켰다 (Square가 사후에
-- 주문을 마감 처리해도 우리 DB의 orders.state는 갱신되지 않기 때문에 상시 발생 가능).
-- Square Orders API 원본과 대조해 이 하나의 버그가 매출·주문수·세금 오류를 동시에
-- 설명함을 확인했다 (Bon Sushi 2026-08-08, 2026-07 세금 사례로 재현·검증 완료).
--
-- 추가로 analytics_location_sales_v2에서 매장별로 gross_sales/net_sales를 다르게
-- 계산해 둘 다 "net_sales"라는 이름으로 내보내는 하드코딩을 발견했다. Square Orders
-- API로 두 매장을 동일 기준(net_sales = gross_sales - discount)으로 재계산해보니
-- 오너가 과거 Square 화면에서 읽은 두 값은 서로 다른 필드(하나는 gross, 하나는 net)
-- 였던 것으로 확인됐다 — 이 레포의 불변 규칙 #2(매출 = Net Sales)를 두 매장 모두
-- 동일하게 적용하는 것이 맞다.
--
-- 이 마이그레이션은:
--   1. orders_settled 뷰를 만든다 — "실제 매출로 잡아야 하는 주문"의 단일 정의
--      (state='COMPLETED' 이거나, state='OPEN'이면서 결제완료 기록이 있는 경우)
--   2. 9개 analytics_* 함수가 orders 대신 orders_settled를 쓰도록 고친다
--   3. analytics_location_sales_v2의 매장별 하드코딩을 제거하고, average_order_value를
--      net_sales 기준(Square의 Average Sale 정의)으로 바꾼다
--   4. monthly_tax_summary도 같은 orders_settled 기준으로 통일한다
--
-- G4 승인: 오너가 대화 중 명시적으로 "함수랑 데이터도 변경해도 되니까" 승인함 (2026-08-23).
-- 데이터(과거 주문 행) 자체는 수정하지 않는다 — 함수(조회 로직)만 고친다.

-- ============================================================
-- 1. 실제 매출로 집계할 주문의 단일 정의
-- ============================================================
create or replace view public.orders_settled as
select o.*
from public.orders o
where o.state = 'COMPLETED'
   or (
        o.state = 'OPEN'
        and exists (
          select 1 from public.square_payments p
          where p.order_id = o.square_order_id
            and p.status = 'COMPLETED'
        )
      );

comment on view public.orders_settled is
  '실제 매출로 집계해야 하는 주문. COMPLETED 전부 + 결제완료된 OPEN. CANCELED·DRAFT·결제없는 OPEN은 제외. docs/decisions/0001 참조.';

-- ============================================================
-- 2. OPEN 누락 버그가 있던 9개 함수 수정 (orders → orders_settled, state 필터 제거)
-- ============================================================

create or replace function public.analytics_daily_sales(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns table(business_date date, order_count bigint, net_sales numeric, average_order_value numeric, discount numeric, tip numeric)
 language sql stable security definer set search_path to 'public'
as $function$
 select o.business_date,count(*),round(sum(o.net_sales),2),round(avg(o.net_sales),2),
        round(sum(o.discount),2),round(sum(o.tip),2)
 from public.orders_settled o
 where o.business_date between p_start_date and p_end_date
   and (p_location_id is null or o.location_id=p_location_id)
 group by o.business_date order by o.business_date;
$function$;

create or replace function public.analytics_location_sales(p_start_date date, p_end_date date)
 returns table(location_id text, order_count bigint, net_sales numeric, average_order_value numeric, tip numeric)
 language sql stable security definer set search_path to 'public'
as $function$
 select o.location_id,count(*),round(sum(o.net_sales),2),round(avg(o.net_sales),2),round(sum(o.tip),2)
 from public.orders_settled o
 where o.business_date between p_start_date and p_end_date
 group by o.location_id order by 3 desc;
$function$;

create or replace function public.analytics_sales_summary(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
  with filtered as (
    select *
    from public.orders_settled
    where business_date between p_start_date and p_end_date
      and (p_location_id is null or location_id=p_location_id)
  )
  select jsonb_build_object(
    'start_date',p_start_date,
    'end_date',p_end_date,
    'location_id',p_location_id,
    'order_count',count(*),
    'gross_sales',round(coalesce(sum(gross_sales),0),2),
    'discount',round(coalesce(sum(discount),0),2),
    'net_sales',round(coalesce(sum(net_sales),0),2),
    'tax',round(coalesce(sum(tax),0),2),
    'tip',round(coalesce(sum(tip),0),2),
    'total',round(coalesce(sum(total),0),2),
    'average_order_value',round(coalesce(avg(net_sales),0),2),
    'discount_rate_pct',round(
      case when coalesce(sum(gross_sales),0)=0 then 0
           else 100*sum(discount)/sum(gross_sales) end,2
    )
  ) from filtered;
$function$;

create or replace function public.analytics_top_items(p_start_date date, p_end_date date, p_limit integer default 10, p_location_id text default null::text, p_sort_by text default 'net_sales'::text)
 returns table(rank bigint, item_name text, variation_name text, quantity numeric, net_sales numeric, order_count bigint)
 language sql stable security definer set search_path to 'public'
as $function$
  with ranked as (
    select
      oi.item_name,
      oi.variation_name,
      sum(oi.quantity) quantity,
      round(sum(oi.net_sales),2) net_sales,
      count(distinct oi.square_order_id) order_count
    from public.order_items oi
    join public.orders_settled o on o.square_order_id=oi.square_order_id
    where o.business_date between p_start_date and p_end_date
      and (p_location_id is null or o.location_id=p_location_id)
      and oi.item_name is not null
    group by oi.item_name,oi.variation_name
  )
  select
    row_number() over(order by
      case when p_sort_by='quantity' then quantity end desc nulls last,
      case when p_sort_by<>'quantity' then net_sales end desc nulls last,
      item_name
    ) rank,
    item_name,variation_name,quantity,net_sales,order_count
  from ranked
  order by
    case when p_sort_by='quantity' then quantity end desc nulls last,
    case when p_sort_by<>'quantity' then net_sales end desc nulls last,
    item_name
  limit greatest(1,least(coalesce(p_limit,10),50));
$function$;

create or replace function public.analytics_item_sales(p_start_date date, p_end_date date, p_item_name text, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
with matched as (
  select
    oi.item_name,
    oi.variation_name,
    sum(oi.quantity) as quantity,
    round(sum(oi.net_sales),2) as net_sales,
    count(distinct oi.square_order_id) as order_count
  from public.order_items oi
  join public.orders_settled o on o.square_order_id=oi.square_order_id
  where o.business_date between p_start_date and p_end_date
    and (p_location_id is null or o.location_id=p_location_id)
    and oi.item_name ilike '%' || trim(p_item_name) || '%'
  group by oi.item_name,oi.variation_name
), totals as (
  select coalesce(sum(quantity),0) quantity,
         coalesce(round(sum(net_sales),2),0) net_sales,
         coalesce(sum(order_count),0) order_count
  from matched
)
select jsonb_build_object(
 'query',p_item_name,
 'total_quantity',t.quantity,
 'total_net_sales',t.net_sales,
 'total_order_count',t.order_count,
 'matches',coalesce((select jsonb_agg(to_jsonb(m) order by m.net_sales desc) from matched m),'[]'::jsonb)
) from totals t;
$function$;

create or replace function public.analytics_hourly_sales(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns table(business_hour integer, order_count bigint, net_sales numeric, average_order_value numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  select o.business_hour,
    count(*) order_count,
    round(sum(o.net_sales),2) net_sales,
    round(avg(o.net_sales),2) average_order_value
  from public.orders_settled o
  where o.business_date between p_start_date and p_end_date
    and (p_location_id is null or o.location_id=p_location_id)
  group by o.business_hour
  order by o.business_hour;
$function$;

create or replace function public.analytics_category_sales(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns table(category_name text, order_count bigint, quantity numeric, net_sales numeric, sales_share_pct numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  with category_totals as (
    select
      coalesce(e.category_name, 'Uncategorized') as category_name,
      count(distinct o.square_order_id) as order_count,
      coalesce(sum(e.quantity),0)::numeric as quantity,
      coalesce(sum(e.net_sales),0)::numeric as net_sales
    from public.orders_settled o
    join public.order_items_enriched e on e.square_order_id = o.square_order_id
    where o.business_date between p_start_date and p_end_date
      and (p_location_id is null or o.location_id = p_location_id)
    group by 1
  ),
  grand as (select nullif(sum(net_sales),0) as total from category_totals)
  select
    ct.category_name,
    ct.order_count,
    ct.quantity,
    round(ct.net_sales,2),
    round(100 * ct.net_sales / grand.total,2)
  from category_totals ct cross join grand
  order by ct.net_sales desc;
$function$;

create or replace function public.analytics_compare_periods(p_a_start date, p_a_end date, p_b_start date, p_b_end date, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
  with a as (
    select count(*) orders, coalesce(sum(net_sales),0) net, coalesce(avg(net_sales),0) aov
    from public.orders_settled
    where business_date between p_a_start and p_a_end
      and (p_location_id is null or location_id=p_location_id)
  ), b as (
    select count(*) orders, coalesce(sum(net_sales),0) net, coalesce(avg(net_sales),0) aov
    from public.orders_settled
    where business_date between p_b_start and p_b_end
      and (p_location_id is null or location_id=p_location_id)
  )
  select jsonb_build_object(
    'period_a',jsonb_build_object('start_date',p_a_start,'end_date',p_a_end,'orders',a.orders,'net_sales',round(a.net,2),'average_order_value',round(a.aov,2)),
    'period_b',jsonb_build_object('start_date',p_b_start,'end_date',p_b_end,'orders',b.orders,'net_sales',round(b.net,2),'average_order_value',round(b.aov,2)),
    'net_sales_change',round(a.net-b.net,2),
    'net_sales_change_pct',round(case when b.net=0 then null else 100*(a.net-b.net)/b.net end,2),
    'order_change',a.orders-b.orders,
    'order_change_pct',round(case when b.orders=0 then null else 100.0*(a.orders-b.orders)/b.orders end,2)
  ) from a cross join b;
$function$;

create or replace function public.analytics_customer_retention(p_start_date date, p_end_date date, p_location_id text default null::text)
 returns jsonb
 language sql stable security definer set search_path to 'public'
as $function$
  with period_customers as (
    select customer_id, count(*) visits, sum(net_sales) spend, min(created_at) first_in_period
    from public.orders_settled
    where customer_id is not null
      and business_date between p_start_date and p_end_date
      and (p_location_id is null or location_id=p_location_id)
    group by customer_id
  ), labeled as (
    select pc.*,
      exists (
        select 1 from public.orders_settled previous
        where previous.customer_id=pc.customer_id
          and previous.created_at<pc.first_in_period
          and (p_location_id is null or previous.location_id=p_location_id)
      ) is_returning
    from period_customers pc
  )
  select jsonb_build_object(
    'start_date',p_start_date,
    'end_date',p_end_date,
    'identified_customers',count(*),
    'new_customers',count(*) filter(where not is_returning),
    'returning_customers',count(*) filter(where is_returning),
    'returning_customer_pct',round(case when count(*)=0 then 0 else 100.0*count(*) filter(where is_returning)/count(*) end,2),
    'repeat_visitors_in_period',count(*) filter(where visits>1),
    'identified_customer_sales',round(coalesce(sum(spend),0),2)
  ) from labeled;
$function$;

-- ============================================================
-- 3. analytics_location_sales_v2 — 매장별 하드코딩 제거 + Average Sale을
--    Net Sales 기준으로 통일 + business_date를 orders 기준으로 단일화
--    (기존엔 결제 시각 기준으로 별도 계산해 두 군데서 날짜 로직이 갈렸음)
-- ============================================================
create or replace function public.analytics_location_sales_v2(p_start date, p_end date)
 returns table(location_id text, location_name text, net_sales numeric, order_count bigint, average_order_value numeric, tip numeric, refund_total numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  select
    o.location_id,
    coalesce(l.location_name, o.location_id) as location_name,
    round(sum(o.net_sales),2) as net_sales,
    count(*) as order_count,
    round(sum(o.net_sales) / nullif(count(*),0), 2) as average_order_value,
    round(sum(o.tip),2) as tip,
    round(coalesce(sum(r.refund_amt),0),2) as refund_total
  from public.orders_settled o
  left join public.locations l on l.square_location_id = o.location_id
  left join lateral (
    select sum(amount) as refund_amt
    from public.square_refunds r
    where r.order_id = o.square_order_id and r.status = 'COMPLETED'
  ) r on true
  where o.business_date between p_start and p_end
  group by o.location_id, l.location_name
  order by l.location_name;
$function$;

comment on function public.analytics_location_sales_v2(date, date) is
  'net_sales = gross_sales - discount (양쪽 매장 동일 기준, 불변규칙 #2). average_order_value = net_sales/거래건수 (Square Average Sale 정의). refund_total은 참고용 별도 표시 — net_sales에 이미 반영됐는지는 미확정(docs/decisions/0001 항목 3).';

-- ============================================================
-- 4. monthly_tax_summary — 동일 기준(orders_settled)으로 통일
-- ============================================================
create or replace function public.monthly_tax_summary(p_start date, p_end date)
 returns table(location_id text, location_name text, tax_name text, tax_amount numeric)
 language sql stable security definer set search_path to 'public'
as $function$
with target_orders as materialized (
 select o.location_id,o.raw from public.orders_settled o
 where o.business_date between p_start and p_end
), tax_agg as (
 select o.location_id,t->>'name' tax_name,
 round(sum(coalesce((t#>>'{applied_money,amount}')::numeric,0)/100),2) tax_amount
 from target_orders o
 cross join lateral jsonb_array_elements(coalesce(o.raw->'taxes','[]'::jsonb)) t
 where t->>'name' in ('GST','PST','Saskatchewan PST','LCT')
 group by o.location_id,t->>'name'
), resolved_tax as (
 select t.location_id,t.tax_name,coalesce(x.tax_amount,t.tax_amount) tax_amount
 from tax_agg t left join public.monthly_tax_overrides x
 on x.location_id=t.location_id and x.month_start=date_trunc('month',p_start)::date and x.tax_name=t.tax_name
), net_sales as (
 select a.location_id,a.net_sales from public.analytics_location_sales_v2(p_start,p_end) a
)
select t.location_id,coalesce(l.location_name,t.location_id),t.tax_name,t.tax_amount
from resolved_tax t left join public.locations l on l.square_location_id=t.location_id
union all
select n.location_id,coalesce(l.location_name,n.location_id),'NET_SALES',round(n.net_sales,2)
from net_sales n left join public.locations l on l.square_location_id=n.location_id
order by 2,3;
$function$;
