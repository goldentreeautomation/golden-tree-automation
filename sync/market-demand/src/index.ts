// Golden Tree — Regina 시장 수요 예상 (오너 요청, 2026-08-25)
//
// 중요: 이건 "실제 혼잡도"가 아니라 시장 신호 기반 "예상치"다. 대시보드에도 항상 이 문구를
// 붙인다. 매시간 15분(America/Regina) pg_cron이 이 함수를 호출한다.
//
// 신호별 가중치 (오너 스펙 그대로):
//   기본 50 | 과거 실적 -20~+20 | 날씨 -15~+10 | 지역행사 0~+20 |
//   공휴일·계절 -10~+10 | 검색관심도 -10~+10 | 도로/교통/특보 -10~0
//
// 지금 구현된 신호: 과거 실적(우리 Square 데이터), 날씨(Open-Meteo, 무료·키 불필요), 캘린더.
// 아직 미구현(항상 0, source_status에 "unavailable"로 표시, 신뢰도에 반영):
//   지역행사 — 신뢰할 만한 무료 피드를 아직 못 찾음 (City of Regina 오픈데이터 확인 필요)
//   검색관심도 — GSC는 이 프로젝트 범위 밖 (docs/decisions/0005, 코덱스 사이드 프로젝트 소관)
//   도로/교통/대기질 — 아직 미조사
//
// 학습(회귀 모델)은 여기 없다 — market_demand_outcomes에 실적이 8주/200건 이상 쌓이기 전엔
// 의미가 없어서, 데이터 축적 인프라만 지금 만든다 (db/migrations 0009~0011).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;

const REGINA_LAT = 50.4526593;
const REGINA_LON = -104.6184244;

const BRANDS = [
  { id: "LWEFT8C6SXJ7J", name: "Bon Sushi" },
  { id: "L7DA0MBKD2X4P", name: "CozyHaus" },
];

const PERIODS = ["morning", "afternoon", "evening"] as const;
type Period = typeof PERIODS[number];

// Saskatchewan 공휴일 (연도별로 수동 갱신 필요 — 규칙 기반이라 설명 가능하게 유지)
const SK_HOLIDAYS_2026: Record<string, string> = {
  "2026-01-01": "New Year's Day",
  "2026-02-16": "Family Day",
  "2026-04-03": "Good Friday",
  "2026-05-18": "Victoria Day",
  "2026-07-01": "Canada Day",
  "2026-08-03": "Saskatchewan Day",
  "2026-09-07": "Labour Day",
  "2026-10-12": "Thanksgiving",
  "2026-11-11": "Remembrance Day",
  "2026-12-25": "Christmas Day",
  "2026-12-26": "Boxing Day",
};
// 디저트/카페 수요에 특히 영향 있는 날 (요일 무관 고정일)
const SPECIAL_DEMAND_DATES: Record<string, string> = {
  "2026-02-14": "Valentine's Day",
  "2026-05-10": "Mother's Day",
  "2026-06-21": "Father's Day",
  "2026-10-31": "Halloween",
  "2026-12-24": "Christmas Eve",
  "2026-12-31": "New Year's Eve",
};

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}

function reginaNow() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Regina",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parts.hour === "24" ? 0 : parseInt(parts.hour, 10);
  return { dateStr, hour };
}

function truncatedHourIso() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${REGINA_LAT}&longitude=${REGINA_LON}` +
    `&current=temperature_2m,apparent_temperature,precipitation,rain,snowfall,wind_speed_10m,weather_code` +
    `&hourly=temperature_2m,precipitation_probability,snowfall` +
    `&daily=sunrise,sunset&timezone=America%2FRegina&forecast_hours=12&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  return res.json();
}

// 날씨 영향 -15~+10. 카페·베이커리 기준 — 너무 춥거나(-15C↓) 덥거나(32C↑) 눈/비가 오면 감소,
// 쾌적한 기온(10~28C)에 강수 적으면 야외활동 늘어 증가.
function weatherImpact(weather: any): { impact: number; reasons: string[]; features: Record<string, unknown> } {
  const cur = weather.current ?? {};
  const temp = cur.temperature_2m ?? null;
  const feels = cur.apparent_temperature ?? null;
  const precip12h = (weather.hourly?.precipitation_probability ?? []).reduce((a: number, b: number) => Math.max(a, b ?? 0), 0);
  const snow12h = (weather.hourly?.snowfall ?? []).reduce((a: number, b: number) => a + (b ?? 0), 0);
  const wind = cur.wind_speed_10m ?? 0;

  let impact = 0;
  const reasons: string[] = [];

  if (temp !== null) {
    if (temp <= -15 || temp >= 32) {
      impact -= 10;
      reasons.push(`극단적인 기온(${temp}°C)`);
    } else if (temp >= 12 && temp <= 26) {
      impact += 7;
      reasons.push("야외 활동에 적합한 기온");
    }
  }
  if (precip12h >= 60) {
    impact -= 8;
    reasons.push(`강수 확률 ${Math.round(precip12h)}%`);
  }
  if (snow12h > 0) {
    impact -= 6;
    reasons.push("눈 예보");
  }
  if (wind >= 40) {
    impact -= 4;
    reasons.push(`강풍 ${Math.round(wind)}km/h`);
  }
  impact = Math.max(-15, Math.min(10, impact));

  return {
    impact,
    reasons,
    features: {
      temperature_c: temp, feels_like_c: feels,
      precip_probability_pct: precip12h, snow_cm: snow12h, wind_kph: wind,
      sunrise: weather.daily?.sunrise?.[0] ?? null, sunset: weather.daily?.sunset?.[0] ?? null,
    },
  };
}

function calendarImpact(dateStr: string): { impact: number; reasons: string[]; features: Record<string, unknown> } {
  const d = new Date(dateStr + "T00:00:00");
  const dow = d.getUTCDay(); // 날짜 문자열만 쓰므로 UTC 파싱해도 날짜는 동일
  const isWeekend = dow === 0 || dow === 6;
  const holiday = SK_HOLIDAYS_2026[dateStr];
  const special = SPECIAL_DEMAND_DATES[dateStr];
  const day = d.getUTCDate();
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const isMonthStart = day <= 3;
  const isMonthEnd = day >= lastDayOfMonth - 2;
  const month = d.getUTCMonth() + 1;
  const season = month >= 12 || month <= 2 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "fall";

  let impact = 0;
  const reasons: string[] = [];
  if (isWeekend) { impact += 5; reasons.push("주말"); }
  if (holiday) { impact += 6; reasons.push(`공휴일: ${holiday}`); }
  if (special) { impact += 8; reasons.push(`특별한 날: ${special}`); }
  impact = Math.max(-10, Math.min(10, impact));

  return {
    impact,
    reasons,
    features: {
      is_weekend: isWeekend, is_holiday: !!holiday, holiday_name: holiday ?? null,
      is_school_break: false, is_month_start: isMonthStart, is_month_end: isMonthEnd,
      special_date: special ?? null, season,
    },
  };
}

async function historyImpact(brandId: string, period: Period, dateStr: string) {
  const [baselineRows, profileRows] = await Promise.all([
    rpc("market_demand_baseline", { p_location_id: brandId, p_period: period, p_target_date: dateStr, p_lookback_weeks: 8 }),
    rpc("market_demand_dow_profile", { p_location_id: brandId, p_period: period, p_lookback_weeks: 8 }),
  ]);
  const baseline = baselineRows?.[0];
  const targetDow = new Date(dateStr + "T00:00:00").getUTCDay();
  const overallAvg = profileRows.length
    ? profileRows.reduce((s: number, r: any) => s + Number(r.avg_net_sales ?? 0), 0) / profileRows.length
    : null;
  const targetDowAvg = profileRows.find((r: any) => r.dow === targetDow)?.avg_net_sales ?? null;

  let impact = 0;
  const reasons: string[] = [];
  if (overallAvg && targetDowAvg !== null && overallAvg > 0) {
    const ratio = (Number(targetDowAvg) - overallAvg) / overallAvg;
    impact = Math.max(-20, Math.min(20, Math.round(ratio * 100)));
    const dowNames = ["일", "월", "화", "수", "목", "금", "토"];
    if (impact <= -8) reasons.push(`${dowNames[targetDow]}요일의 평소 수요가 낮음`);
    else if (impact >= 8) reasons.push(`${dowNames[targetDow]}요일의 평소 수요가 높음`);
  }
  return {
    impact,
    reasons,
    baseline_net_sales: baseline?.avg_net_sales ?? null,
    baseline_order_count: baseline?.avg_order_count ?? null,
    sample_weeks: baseline?.sample_weeks ?? 0,
  };
}

async function rpc(fn: string, args: Record<string, unknown>, attempt = 0): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 && text.includes("PGRST303") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpc(fn, args, attempt + 1);
    }
    throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
  }
  return res.json();
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

function scoreToBand(score: number): string {
  if (score < 35) return "quiet";
  if (score < 65) return "normal";
  if (score < 80) return "busy";
  return "very_busy";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  const { dateStr } = reginaNow();
  const calculatedAt = truncatedHourIso();

  try {
    const weather = await fetchWeather();
    const w = weatherImpact(weather);
    const cal = calendarImpact(dateStr);

    // source_status: 지금 확보된 신호 vs 아직 없는 신호를 명시 — 신뢰도 계산에 씀
    const unavailableSignals = ["events", "search_trend", "road_traffic_air_quality"];
    const availableCount = 3; // weather, calendar, history
    const confidence = availableCount >= 3 && cal ? "medium" : "low"; // 행사·검색 없으니 high는 아직 안 씀

    const results: any[] = [];
    for (const brand of BRANDS) {
      for (const period of PERIODS) {
        const hist = await historyImpact(brand.id, period, dateStr);
        const score = Math.max(
          0,
          Math.min(100, Math.round(50 + hist.impact + w.impact + cal.impact)),
        );
        const reasons = [
          ...hist.reasons.map((r) => ({ text: r, sign: hist.impact >= 0 ? "+" : "-" })),
          ...w.reasons.map((r) => ({ text: r, sign: w.impact >= 0 ? "+" : "-" })),
          ...cal.reasons.map((r) => ({ text: r, sign: cal.impact >= 0 ? "+" : "-" })),
        ].slice(0, 5);

        results.push({
          brand_id: brand.id,
          forecast_for: dateStr,
          period,
          score,
          demand_band: scoreToBand(score),
          confidence: hist.sample_weeks >= 4 ? confidence : "low",
          model_version: "rule-v1",
          weather_impact: w.impact,
          event_impact: 0,
          calendar_impact: cal.impact,
          search_impact: 0,
          operations_impact: hist.impact,
          // jsonb 컬럼이므로 문자열로 stringify하면 안 된다 — 그러면 jsonb 안에 "JSON 텍스트"가
          // 그대로 들어가 이중 인코딩되고, 프론트에서 .map()이 실패한다(배열이 아니라 문자열이 됨).
          reasons,
          source_status: {
            weather: "ok", calendar: "ok", history: hist.sample_weeks >= 4 ? "ok" : "insufficient_data",
            unavailable: unavailableSignals,
          },
          calculated_at: calculatedAt,
        });
      }
    }

    await upsert("market_demand_snapshots", results, "brand_id,forecast_for,period,calculated_at");

    const featureRows = BRANDS.map((brand) => ({
      brand_id: brand.id,
      observed_at: calculatedAt,
      ...w.features,
      weather_alert: false,
      weather_alert_text: null,
      nearby_event_count: 0,
      weighted_event_score: 0,
      events_confirmed: false,
      ...cal.features,
      search_trend_pct: null,
      road_alert: false,
      transit_alert: false,
      air_quality_index: null,
      same_weekday_baseline_net_sales: null,
      same_weekday_baseline_order_count: null,
      raw: { weather_current: weather.current },
    }));
    await upsert("market_demand_features", featureRows, "brand_id,observed_at");

    return new Response(JSON.stringify({ status: "success", calculated_at: calculatedAt, snapshots: results.length }), {
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
