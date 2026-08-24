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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  const url = new URL(req.url);
  const weekOffset = parseInt(url.searchParams.get("week_offset") ?? "0", 10);

  const cur = weekRange(weekOffset);
  const prev = weekRange(weekOffset - 1);
  // 지난주와 "같은 요일까지" 비교해야 공정하다 (이번 주가 아직 안 끝났으면)
  const daysIntoWeek =
    (new Date(cur.end).getTime() - new Date(cur.start).getTime()) / 86400000;
  const prevEnd = new Date(prev.start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() + daysIntoWeek);
  const prevCompareEnd = toDateStr(prevEnd);

  try {
    const [curSales, prevSales] = await Promise.all([
      rpc("analytics_location_sales_v2", { p_start: cur.start, p_end: cur.end }),
      rpc("analytics_location_sales_v2", { p_start: prev.start, p_end: prevCompareEnd }),
    ]);

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
        compare_end: prevCompareEnd,
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
