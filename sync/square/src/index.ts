// Golden Tree — Square 일일 동기화 (W1) / 수동 구간 동기화 (W2)
//
// 설계 근거: docs/golden-tree-design.md W1·W2, docs/decisions/0001-legacy-square-data-verification.md
//
// - state 필터 없이 전부 저장한다 (COMPLETED/OPEN/CANCELED/DRAFT 모두). "실제 매출로 볼지"는
//   DB의 orders_settled 뷰가 조회 시점에 결정한다 — 레거시(n8n)에서 COMPLETED만 가져와서
//   결제된 OPEN 주문을 통째로 놓쳤던 문제(오류 4·5·7·15번)를 애초에 구조적으로 막는다.
// - business_date/business_hour는 Intl.DateTimeFormat(America/Regina)로 계산한다.
//   Saskatchewan은 DST가 없어 항상 UTC-6이지만, 하드코딩 대신 타임존 API를 쓴다.
// - net_sales = gross_sales - discount (불변 규칙 #2). Square 원본 필드로 역산:
//     net_sales = total_money - tax_money - tip_money
//     gross_sales = net_sales + discount_money
// - idempotent: ingest_square_batch / ingest_square_payments가 upsert(on conflict)라
//   같은 구간을 여러 번 돌려도 행 수가 늘지 않는다 (불변 규칙 #6).
// - 인증: pg_cron이 호출할 때 X-Sync-Secret 헤더로 SYNC_SHARED_SECRET을 검사한다.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const SQUARE_API_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";
const LOCATIONS = ["LWEFT8C6SXJ7J", "L7DA0MBKD2X4P"]; // Bon Sushi, CozyHaus — docs/golden-tree-design.md 1.6

function squareHeaders() {
  return {
    "Square-Version": SQUARE_VERSION,
    "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function callRpc(fn: string, args: Record<string, unknown>, attempt = 0): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    // PGRST303 "JWT issued at future"는 콜드스타트 직후 간헐적 시계 오차로 발생 — 1회 재시도로 흡수
    if (res.status === 401 && text.includes("PGRST303") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return callRpc(fn, args, attempt + 1);
    }
    throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// America/Regina는 DST가 없다(연중 CST, UTC-6). 하드코딩하지 않고 Intl로 계산한다.
function reginaParts(iso: string) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Regina",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const businessDate = `${parts.year}-${parts.month}-${parts.day}`;
  const businessHour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
  return { businessDate, businessHour, dayOfWeek: parts.weekday };
}

function money(m: { amount?: number } | undefined) {
  return (m?.amount ?? 0) / 100;
}

function normalizeOrder(o: any) {
  const { businessDate, businessHour, dayOfWeek } = reginaParts(o.created_at);
  // 환불·반품은 Square가 원본 주문을 고치지 않고 "반품 전용 주문"을 따로 만든다. 이 주문엔
  // line_items/total_money 등 표준 필드가 없고 net_amounts(음수)만 있다 — 그대로 두면
  // money(undefined)=0이라 반품이 매출에서 전혀 빠지지 않는다(오너 지적으로 발견,
  // docs/decisions/0001 버그 #3, docs/decisions/0009). net_amounts로 대체하면 정상 주문은
  // total_money가 있어 그대로 쓰이므로(?? 연산자) 기존 동작에 영향 없다.
  const total = money(o.total_money ?? o.net_amounts?.total_money);
  const tax = money(o.total_tax_money ?? o.net_amounts?.tax_money);
  const tip = money(o.total_tip_money ?? o.net_amounts?.tip_money);
  const discount = money(o.total_discount_money ?? o.net_amounts?.discount_money);
  const net_sales = Math.round((total - tax - tip) * 100) / 100;
  const gross_sales = Math.round((net_sales + discount) * 100) / 100;

  const items = (o.line_items ?? []).map((li: any) => {
    const li_gross = money(li.gross_sales_money);
    const li_discount = money(li.total_discount_money);
    const li_tax = money(li.total_tax_money);
    const li_total = money(li.total_money);
    return {
      id: `${o.id}:${li.uid}`,
      square_order_id: o.id,
      catalog_object_id: li.catalog_object_id ?? null,
      variation_id: li.catalog_object_id ?? null,
      category_id: null, // order_items_enriched 뷰가 catalog 체인으로 연결한다 (0001 결정 문서 항목 11)
      item_name: li.name ?? null,
      variation_name: li.variation_name ?? null,
      quantity: Number(li.quantity ?? "0"),
      gross_sales: li_gross,
      discount: li_discount,
      net_sales: Math.round((li_gross - li_discount) * 100) / 100,
      tax: li_tax,
      total: li_total,
      raw: li,
    };
  });

  const order = {
    square_order_id: o.id,
    location_id: o.location_id,
    created_at: o.created_at,
    updated_at: o.updated_at,
    closed_at: o.closed_at ?? null,
    state: o.state,
    business_date: businessDate,
    business_hour: businessHour,
    day_of_week: dayOfWeek,
    gross_sales,
    discount,
    tax,
    net_sales,
    tip,
    total,
    customer_id: o.customer_id ?? null,
    order_source: o.source?.name ?? null,
    version: o.version ?? 0,
    raw: o,
  };
  return { order, items };
}

async function fetchAllOrders(startIso: string, endIso: string) {
  const orders: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const body: any = {
      location_ids: LOCATIONS,
      query: {
        filter: {
          date_time_filter: { updated_at: { start_at: startIso, end_at: endIso } },
        },
        sort: { sort_field: "UPDATED_AT", sort_order: "ASC" },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;
    const res = await fetch(`${SQUARE_API_BASE}/orders/search`, {
      method: "POST",
      headers: squareHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`orders/search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    orders.push(...(data.orders ?? []));
    cursor = data.cursor;
  } while (cursor);
  return orders;
}

// Square 고객(Customers API) — 매장 구분 없이 상인(merchant) 전체 단위. 원래 M2 스펙에
// 있었는데(docs/golden-tree-design.md 1.4 입출력 정의) Square 동기화를 n8n에서 이 Edge
// Function으로 재구현할 때 빠뜨려서 2026-08-17부터 갱신이 멈춰 있었다(오너 지적, 2026-08-25).
async function fetchAllCustomers(startIso: string, endIso: string) {
  const customers: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const body: any = {
      query: {
        filter: { updated_at: { start_at: startIso, end_at: endIso } },
        sort: { field: "DEFAULT", order: "ASC" },
      },
      limit: 100,
    };
    if (cursor) body.cursor = cursor;
    const res = await fetch(`${SQUARE_API_BASE}/customers/search`, {
      method: "POST",
      headers: squareHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`customers/search failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    customers.push(...(data.customers ?? []));
    cursor = data.cursor;
  } while (cursor);
  return customers;
}

function normalizeCustomer(c: any) {
  return {
    square_customer_id: c.id,
    given_name: c.given_name ?? null,
    family_name: c.family_name ?? null,
    company_name: c.company_name ?? null,
    email_address: c.email_address ?? null,
    phone_number: c.phone_number ?? null,
    reference_id: c.reference_id ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at ?? null,
    first_seen_at: c.created_at,
    last_seen_at: c.updated_at ?? c.created_at,
    raw: c,
  };
}

async function fetchAllPayments(startIso: string, endIso: string) {
  const payments: any[] = [];
  for (const locationId of LOCATIONS) {
    let cursor: string | undefined = undefined;
    do {
      const params = new URLSearchParams({
        location_id: locationId,
        begin_time: startIso,
        end_time: endIso,
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`${SQUARE_API_BASE}/payments?${params}`, { headers: squareHeaders() });
      if (!res.ok) throw new Error(`payments failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      payments.push(...(data.payments ?? []));
      cursor = data.cursor;
    } while (cursor);
  }
  return payments;
}

async function fetchAllRefunds(startIso: string, endIso: string) {
  const refunds: any[] = [];
  for (const locationId of LOCATIONS) {
    let cursor: string | undefined = undefined;
    do {
      const params = new URLSearchParams({
        location_id: locationId,
        begin_time: startIso,
        end_time: endIso,
        sort_order: "ASC",
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`${SQUARE_API_BASE}/refunds?${params}`, { headers: squareHeaders() });
      if (!res.ok) throw new Error(`refunds failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      refunds.push(...(data.refunds ?? []));
      cursor = data.cursor;
    } while (cursor);
  }
  return refunds;
}

function normalizePayment(p: any) {
  return {
    square_payment_id: p.id,
    order_id: p.order_id ?? null,
    location_id: p.location_id,
    created_at: p.created_at,
    updated_at: p.updated_at ?? null,
    status: p.status,
    amount: money(p.amount_money),
    tip: money(p.tip_money),
    refunded_amount: money(p.refunded_money),
    source_type: p.source_type ?? null,
    raw: p,
  };
}

function normalizeRefund(r: any) {
  return {
    square_refund_id: r.id,
    payment_id: r.payment_id ?? null,
    order_id: r.order_id ?? null,
    location_id: r.location_id,
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
    status: r.status,
    amount: money(r.amount_money),
    reason: r.reason ?? null,
    raw: r,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const syncKey = "square_orders:daily";
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // body 없이 호출된 경우 (pg_cron) — 기본 48시간 룩백 사용
  }

  const now = new Date();
  let startIso: string;
  if (body.since) {
    startIso = new Date(body.since).toISOString();
  } else {
    // 매시간 실행으로 바뀌면서(2026-08-25) "마지막 성공 - 48h"로 매번 밀어가던 방식은
    // 오래된 구간을 다시 놓치는 문제가 있어, 항상 "지금 - 48h"로 고정했다. Square 주문이
    // 사후 수정될 수 있어 매번 48시간을 다시 훑는다(W1) — idempotent upsert라 비용은
    // 재조회뿐, 데이터 중복은 없다.
    startIso = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  }
  const endIso = body.until ? new Date(body.until).toISOString() : now.toISOString();

  try {
    const [squareOrders, payments, refunds, squareCustomers] = await Promise.all([
      fetchAllOrders(startIso, endIso),
      fetchAllPayments(startIso, endIso),
      fetchAllRefunds(startIso, endIso),
      fetchAllCustomers(startIso, endIso),
    ]);

    const normalized = squareOrders.map(normalizeOrder);
    const orders = normalized.map((n) => n.order);
    const items = normalized.flatMap((n) => n.items);

    // 대량일 때 페이로드 제한을 피하기 위해 나눠서 upsert (idempotent라 순서 무관).
    // sync_log 기록은 마지막 청크에 함께 실어 보낸다 — ingest_square_batch가
    // sync_log.orders_synced/items_synced를 "그 호출에서 실제로 upsert한 행 수"로
    // 채우므로, 별도의 빈 호출로 남기면 0으로 기록되는 문제가 있었다.
    const batches = [...zipChunks(orders, items)];
    for (let i = 0; i < batches.length; i++) {
      const [oChunk, iChunk] = batches[i];
      const isLast = i === batches.length - 1;
      await callRpc("ingest_square_batch", {
        p_orders: oChunk,
        p_items: iChunk,
        p_customers: [],
        p_sync: isLast
          ? {
              sync_key: syncKey,
              location_id: LOCATIONS.join(","),
              last_sync_at: now.toISOString(),
              status: "success",
              window_start: startIso,
              window_end: endIso,
            }
          : {},
      });
    }

    const normPayments = payments.map(normalizePayment);
    const normRefunds = refunds.map(normalizeRefund);
    for (const pChunk of chunk(normPayments, 300)) {
      await callRpc("ingest_square_payments", { p_payments: pChunk, p_refunds: [] });
    }
    for (const rChunk of chunk(normRefunds, 300)) {
      await callRpc("ingest_square_payments", { p_payments: [], p_refunds: rChunk });
    }

    const normCustomers = squareCustomers.map(normalizeCustomer);
    for (const cChunk of chunk(normCustomers, 300)) {
      await callRpc("ingest_square_batch", { p_orders: [], p_items: [], p_customers: cChunk, p_sync: {} });
    }

    return new Response(
      JSON.stringify({
        status: "success",
        window_start: startIso,
        window_end: endIso,
        orders: orders.length,
        items: items.length,
        payments: normPayments.length,
        refunds: normRefunds.length,
        customers: normCustomers.length,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    await callRpc("ingest_square_batch", {
      p_orders: [],
      p_items: [],
      p_customers: [],
      p_sync: {
        sync_key: syncKey,
        location_id: LOCATIONS.join(","),
        last_sync_at: now.toISOString(),
        status: "error",
        window_start: startIso,
        window_end: endIso,
      },
    }).catch(() => {});
    return new Response(JSON.stringify({ status: "error", message: String(err) }), { status: 500 });
  }
});

function* zipChunks(orders: any[], items: any[]) {
  // 일일 동기화는 보통 수백~수천 건 — 한 청크에 다 들어가야 sync_log 건수가 정확하다.
  // 대형 백필처럼 이 크기를 넘으면 여러 청크로 나뉘고, sync_log엔 마지막 청크 건수만 남는다.
  const orderChunks = chunk(orders, 5000);
  if (orderChunks.length === 0) {
    yield [[], []] as [any[], any[]];
    return;
  }
  for (const oChunk of orderChunks) {
    const ids = new Set(oChunk.map((o) => o.square_order_id));
    const iChunk = items.filter((i) => ids.has(i.square_order_id));
    yield [oChunk, iChunk] as [any[], any[]];
  }
}
