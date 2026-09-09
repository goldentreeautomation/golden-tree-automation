// Golden Tree — 시장 수요 예상 실측(outcomes) 기록 (오너 요청, 2026-09-09)
//
// 목적: market_demand_snapshots가 "예측"이라면, 이 함수는 그날 실제로 얼마나 팔렸는지를
// market_demand_outcomes에 기록한다. 지금 당장은 이 데이터를 아무도 안 쓰지만(학습 모델
// 없음), 나중에 "이 신호가 실제로 매출에 얼마나 영향을 주는지" 통계적으로 되짚어보려면
// 예측과 실측이 둘 다 쌓여 있어야 한다 — 라이더스 홈경기 가중치를 백테스트해보니 손으로
// 정한 규칙이 실제와 반대였던 게 계기(`0021`). "감이 아니라 데이터로 판단"하려는 오너의
// 목표를 위한 인프라.
//
// 매일 새벽(America/Regina) 한 번, 완전히 끝난 "어제"에 대해서만 계산한다 — 그래야 하루치가
// 전부 settle된 뒤 기록되고, idempotent하게 재실행해도 같은 값으로 덮어쓴다(불변 규칙 #6).
//
// 같은 이유로 "어제"의 과거 날씨(Open-Meteo Archive API)도 여기서 같이 기록한다 —
// `regina_weather_history`(0030, 오너 요청 2026-09-09) "지금까지 오늘 날씨만 실시간으로
// 보고 버려서 과거 날씨 기록이 없다"는 문제를 매일 자동으로 쌓는 방식으로 해결.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const REGINA_LAT = 50.4526593;
const REGINA_LON = -104.6184244;

const BRANDS = ["LWEFT8C6SXJ7J", "L7DA0MBKD2X4P"];

// market-demand의 PERIODS/시간대 정의와 동일하게 맞춘다(대시보드 currentReginaPeriod()도
// 동일 경계 사용) — 아침 6~11시, 오후 11~17시, 저녁 17~24시+0~6시(새벽은 저녁에 편입).
const PERIODS: { name: string; hours: number[] }[] = [
  { name: "morning", hours: [6, 7, 8, 9, 10] },
  { name: "afternoon", hours: [11, 12, 13, 14, 15, 16] },
  { name: "evening", hours: [17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5] },
];

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}

function reginaYesterday(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Regina", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

function periodStartIso(dateStr: string, periodName: string): string {
  const offset = periodName === "morning" ? "06:00:00" : periodName === "afternoon" ? "11:00:00" : "17:00:00";
  return new Date(`${dateStr}T${offset}-06:00`).toISOString(); // Regina는 연중 고정 UTC-6(DST 없음)
}

async function fetchOrders(locationId: string, businessDate: string): Promise<any[]> {
  const params = new URLSearchParams({
    select: "business_hour,net_sales,order_source",
    location_id: `eq.${locationId}`,
    business_date: `eq.${businessDate}`,
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders_settled?${params}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`orders_settled fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchAndStoreWeather(dateStr: string) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${REGINA_LAT}&longitude=${REGINA_LON}` +
    `&start_date=${dateStr}&end_date=${dateStr}` +
    `&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,windspeed_10m_max,weathercode` +
    `&timezone=America%2FRegina`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo archive failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const d = data.daily;
  if (!d?.time?.length) return;
  await upsert("regina_weather_history", [{
    date: d.time[0],
    temperature_max_c: d.temperature_2m_max?.[0] ?? null,
    temperature_min_c: d.temperature_2m_min?.[0] ?? null,
    temperature_mean_c: d.temperature_2m_mean?.[0] ?? null,
    feels_like_max_c: d.apparent_temperature_max?.[0] ?? null,
    feels_like_min_c: d.apparent_temperature_min?.[0] ?? null,
    precipitation_mm: d.precipitation_sum?.[0] ?? null,
    rain_mm: d.rain_sum?.[0] ?? null,
    snowfall_cm: d.snowfall_sum?.[0] ?? null,
    wind_speed_max_kph: d.windspeed_10m_max?.[0] ?? null,
    weather_code: d.weathercode?.[0] ?? null,
    source: "open-meteo",
    imported_at: new Date().toISOString(),
  }], "date");
}

async function upsert(table: string, rows: any[], onConflict: string) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${table} failed: ${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const targetDate = url.searchParams.get("date") ?? reginaYesterday(); // 수동 백필용으로 ?date= 지원

  try {
    const rows: any[] = [];
    for (const brandId of BRANDS) {
      const orders = await fetchOrders(brandId, targetDate);
      for (const p of PERIODS) {
        const matching = orders.filter((o: any) => p.hours.includes(o.business_hour));
        const revenueTotal = matching.reduce((sum: number, o: any) => sum + Number(o.net_sales ?? 0), 0);
        const deliveryCount = matching.filter((o: any) => String(o.order_source ?? "").toLowerCase().includes("delivery")).length;
        rows.push({
          brand_id: brandId,
          period_start: periodStartIso(targetDate, p.name),
          order_count: matching.length,
          revenue_total: Math.round(revenueTotal * 100) / 100,
          delivery_order_count: deliveryCount,
          source: "square_actual",
          imported_at: new Date().toISOString(),
        });
      }
    }

    await upsert("market_demand_outcomes", rows, "brand_id,period_start,source");
    await fetchAndStoreWeather(targetDate).catch((err) => console.error("weather archive fetch failed:", err));

    return new Response(JSON.stringify({ status: "success", date: targetDate, rows: rows.length }), {
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
