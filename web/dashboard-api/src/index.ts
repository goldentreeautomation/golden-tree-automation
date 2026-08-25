// Golden Tree — 대시보드 데이터 API (읽기 전용)
//
// web/dashboard(정적 HTML)이 이 함수를 호출한다. 브라우저는 DB에 직접 붙지 않는다 —
// service role key는 이 Edge Function 안에만 있고, 오직 analytics_* Query Contract
// 함수만 호출한다 (docs/golden-tree-design.md 3.7, CLAUDE.md 불변 규칙 #1).
//
// GET /dashboard-api?week_offset=0   (0=이번 주, -1=지난 주, ...)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const LOCATIONS = [
  { id: "LWEFT8C6SXJ7J", name: "Bon Sushi" },
  { id: "L7DA0MBKD2X4P", name: "CozyHaus" },
];

// 오너가 지정한 그룹 (2026-08-24 대화). Square 카테고리명은 실제 DB 조회로 확인함.
// docs/decisions/0002-dashboard-static-html-not-nextjs.md 참조.
const CATEGORY_GROUPS: Record<string, { name: string; categories: string[] }[]> = {
  LWEFT8C6SXJ7J: [
    { name: "백주방", categories: ["Dish", "Tempura"] },
    { name: "음료", categories: ["Beverage", "Drinks", "Drink"] },
    // 나머지 전부(Sashimi & Nigiri, Maki, Special Roll, Lunch Set, Small Bite,
    // Party Tray Set, By The Piece, Extras 등) = 앞주방 스시 — "기타"로 합산 후 이름만 바꿔 표시
  ],
  L7DA0MBKD2X4P: [
    { name: "커피류", categories: ["Coffee"] },
    { name: "음료류", categories: ["Non Coffee"] },
    { name: "디저트류", categories: ["Dessert/Bread", "Cake", "Dessert", "Basque Cheesecake", "Genoise Cake", "Vegan Cheesecake", "Vegan"] },
    { name: "컵밥류", categories: ["Food"] },
  ],
};
const CATCHALL_NAME: Record<string, string> = {
  LWEFT8C6SXJ7J: "스시(앞주방)",
  L7DA0MBKD2X4P: "기타",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

async function rpc(fn: string, args: Record<string, unknown>, attempt = 0): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    // PGRST303 "JWT issued at future"는 콜드스타트 직후 간헐적 시계 오차로 발생 — 1회 재시도로 흡수
    if (res.status === 401 && text.includes("PGRST303") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpc(fn, args, attempt + 1);
    }
    throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function reginaToday(): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Regina",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

// 월요일 시작 주. week_offset=0은 이번 주(월요일~오늘), 그 외는 월요일~일요일 전체.
function weekRange(weekOffset: number) {
  const { y, m, d } = reginaToday();
  const today = new Date(Date.UTC(y, m - 1, d)); // Regina 날짜를 자정 UTC로 취급해 날짜 연산만 함
  const dow = today.getUTCDay(); // 0=일 ... 6=토
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() + mondayOffset);

  const start = new Date(thisMonday);
  start.setUTCDate(thisMonday.getUTCDate() + weekOffset * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  const isCurrentWeek = weekOffset === 0;
  const effectiveEnd = isCurrentWeek ? today : end;

  return { start: toDateStr(start), end: toDateStr(effectiveEnd), fullWeekEnd: toDateStr(end) };
}

function groupCategorySales(locationId: string, rows: { category_name: string; net_sales: number }[]) {
  const groups = CATEGORY_GROUPS[locationId] ?? [];
  const totals = groups.map((g) => ({ name: g.name, net_sales: 0 }));
  let catchall = 0;
  let grandTotal = 0;
  for (const row of rows) {
    grandTotal += row.net_sales;
    const g = groups.find((g) => g.categories.includes(row.category_name));
    if (g) {
      totals.find((t) => t.name === g.name)!.net_sales += row.net_sales;
    } else {
      catchall += row.net_sales;
    }
  }
  totals.push({ name: CATCHALL_NAME[locationId] ?? "기타", net_sales: catchall });
  return totals
    .filter((t) => t.net_sales > 0)
    .map((t) => ({
      name: t.name,
      net_sales: Math.round(t.net_sales * 100) / 100,
      pct: grandTotal === 0 ? 0 : Math.round((t.net_sales / grandTotal) * 1000) / 10,
    }))
    .sort((a, b) => b.net_sales - a.net_sales);
}

function groupTopItemsByName(rows: { item_name: string; quantity: number; net_sales: number; order_count: number }[]) {
  const byName = new Map<string, { item_name: string; quantity: number; net_sales: number; order_count: number }>();
  for (const r of rows) {
    const existing = byName.get(r.item_name);
    if (existing) {
      existing.quantity += r.quantity;
      existing.net_sales += r.net_sales;
      existing.order_count += r.order_count;
    } else {
      byName.set(r.item_name, { item_name: r.item_name, quantity: r.quantity, net_sales: r.net_sales, order_count: r.order_count });
    }
  }
  return [...byName.values()]
    .map((r) => ({ ...r, net_sales: Math.round(r.net_sales * 100) / 100 }))
    .sort((a, b) => b.net_sales - a.net_sales)
    .slice(0, 5);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  const url = new URL(req.url);
  const weekOffset = parseInt(url.searchParams.get("week_offset") ?? "0", 10);

  const cur = weekRange(weekOffset);
  const prev = weekRange(weekOffset - 1);
  const isCurrentWeek = weekOffset === 0;

  try {
    // 이번 주(진행 중)는 "저번주 같은 요일 전체"가 아니라 "저번주 이 시각까지"와 비교해야
    // 공정하다 — 예: 화요일 새벽 1시엔 저번주도 화요일 새벽 1시까지만 잘라서 비교한다.
    // Regina는 연중 고정 UTC-6(DST 없음)이라 -06:00 오프셋을 직접 써도 안전하다.
    // (오너 지적, 2026-08-25 — 전엔 날짜 단위로만 잘라 "이번 주 화요일 1시간"을
    // "저번주 화요일 24시간"과 비교하는 바람에 항상 불공정하게 낮게 나왔다.)
    let curSales: any[];
    let prevSales: any[];
    if (isCurrentWeek) {
      const thisMondayTs = new Date(cur.start + "T00:00:00-06:00");
      const nowTs = new Date();
      const elapsedMs = nowTs.getTime() - thisMondayTs.getTime();
      const prevMondayTs = new Date(prev.start + "T00:00:00-06:00");
      const prevCutoffTs = new Date(prevMondayTs.getTime() + elapsedMs);
      [curSales, prevSales] = await Promise.all([
        rpc("analytics_location_sales_by_timestamp", { p_start_ts: thisMondayTs.toISOString(), p_end_ts: nowTs.toISOString() }),
        rpc("analytics_location_sales_by_timestamp", { p_start_ts: prevMondayTs.toISOString(), p_end_ts: prevCutoffTs.toISOString() }),
      ]);
    } else {
      // 과거 완결된 주끼리 비교할 땐 부분-일 문제가 없으니 기존 날짜 단위 비교로 충분하다.
      [curSales, prevSales] = await Promise.all([
        rpc("analytics_location_sales_v2", { p_start: cur.start, p_end: cur.end }),
        rpc("analytics_location_sales_v2", { p_start: prev.start, p_end: prev.fullWeekEnd }),
      ]);
    }

    const dailyByLocation = await Promise.all(
      LOCATIONS.map((loc) =>
        rpc("analytics_daily_sales", {
          p_start_date: cur.start,
          p_end_date: cur.end,
          p_location_id: loc.id,
        }).then((rows: any[]) => [loc.id, rows] as const)
      ),
    );
    const dailyMap = Object.fromEntries(dailyByLocation);

    const categoryByLocation = await Promise.all(
      LOCATIONS.map((loc) =>
        rpc("analytics_category_sales", {
          p_start_date: cur.start,
          p_end_date: cur.end,
          p_location_id: loc.id,
        }).then((rows: any[]) => [loc.id, groupCategorySales(loc.id, rows)] as const)
      ),
    );
    const categoryMap = Object.fromEntries(categoryByLocation);

    // analytics_top_items는 (품목, 맛/옵션) 단위로 나온다 — 대시보드는 맛 구분 없이 품목
    // 전체 합계로 보여달라는 요청(2026-08-24)이 있어 여기서만 품목명으로 재집계한다.
    // Query Contract 함수 자체는 안 바꾼다 — 다른 곳(디스코드 등)은 맛별 구분이 필요할 수 있음.
    const topItemsByLocation = await Promise.all(
      LOCATIONS.map((loc) =>
        rpc("analytics_top_items", {
          p_start_date: cur.start,
          p_end_date: cur.end,
          p_limit: 50,
          p_location_id: loc.id,
          p_sort_by: "net_sales",
        }).then((rows: any[]) => [loc.id, groupTopItemsByName(rows)] as const)
      ),
    );
    const topItemsMap = Object.fromEntries(topItemsByLocation);

    // Regina 시장 수요 예상 — 실제 혼잡도 아님, 시장 신호 기반 추정치 (2026-08-25 추가)
    const marketDemandByLocation = await Promise.all(
      LOCATIONS.map((loc) =>
        rpc("analytics_market_demand_latest", { p_location_id: loc.id }).then((r: any) => [loc.id, r] as const)
      ),
    );
    const marketDemandMap = Object.fromEntries(marketDemandByLocation);

    const byId = (rows: any[]) => Object.fromEntries(rows.map((r: any) => [r.location_id, r]));
    const curById = byId(curSales);
    const prevById = byId(prevSales);

    const locations = LOCATIONS.map((loc) => {
      const c = curById[loc.id] ?? { net_sales: 0, order_count: 0, average_order_value: 0, tip: 0 };
      const p = prevById[loc.id] ?? { net_sales: 0, order_count: 0, average_order_value: 0, tip: 0 };
      const pct = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10);
      return {
        location_id: loc.id,
        location_name: loc.name,
        net_sales: c.net_sales,
        order_count: c.order_count,
        average_order_value: c.average_order_value,
        compare: {
          net_sales: p.net_sales,
          order_count: p.order_count,
          net_sales_change_pct: pct(c.net_sales, p.net_sales),
          order_count_change_pct: pct(c.order_count, p.order_count),
        },
        daily: dailyMap[loc.id] ?? [],
        category_groups: categoryMap[loc.id] ?? [],
        top_items: topItemsMap[loc.id] ?? [],
        market_demand: marketDemandMap[loc.id] ?? null,
      };
    });

    return new Response(
      JSON.stringify({
        week_offset: weekOffset,
        week_start: cur.start,
        week_end: cur.end,
        full_week_end: cur.fullWeekEnd,
        is_current_week: weekOffset === 0,
        compare_start: prev.start,
        compare_end: isCurrentWeek ? prev.end : prev.fullWeekEnd,
        locations,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders() } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
