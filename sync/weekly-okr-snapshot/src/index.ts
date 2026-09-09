// Golden Tree — 주간 경영 회의 OKR 스냅샷 계산 (오너 요청, 2026-09-08)
//
// 일요일 밤 11시(America/Regina) pg_cron이 이 함수를 호출한다. "지난주"(월~일, 완결된 한 주)
// 기준으로 매출/케이크/소셜 지표를 계산해 weekly_okr_snapshots에 저장한다 — 대시보드는 이걸
// 읽기만 하고 매번 재계산하지 않는다(회의 중 숫자가 바뀌면 안 되고, 매번 AI 호출을 반복할
// 필요도 없음). 오너 지시: "회의할 땐 전 주(풀 7일 지난)를 비교"하므로 진행 중인 주 비례
// 계산(0018의 옛 방식)은 이 패널에서는 더 이상 쓰지 않는다.
//
// 특이사항(anomaly) 문장은 LLM이 쓰되, day_offset 0~3(발행 당일~3일 후) + 주말 지연 반응을
// 반영한 기존 상관관계 로직(analytics_social_sales_correlation, 0008)을 근거로만 쓰게 한다 —
// "그날 포스팅→그날 매출"처럼 당일만 보는 단순 인과는 오너가 명시적으로 나쁜 예로 지적함.
//
// 2026-09-09 Gemini→OpenAI 교체(오너 결정, runtime/discord와 동일한 이유 — 무료 티어 20건/일
// 한도, 유료 GPT 계정 이미 보유).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_MODEL = "gpt-5.6-luna";

const LOCATIONS = [
  { id: "LWEFT8C6SXJ7J", name: "Bon Sushi" },
  { id: "L7DA0MBKD2X4P", name: "CozyHaus" },
];

// 주간 경영 회의 KPI 기준선/목표 (오너 확정, 2026-09-08 수정 — 본스시 목표 하향, 코지하우스
// 매출 목표 신설). "지난주" 완결된 한 주 기준이라 더 이상 비례 축소하지 않는다.
const KPI_THRESHOLDS: Record<string, { weeklyFloor: number; weeklyTarget: number }> = {
  LWEFT8C6SXJ7J: { weeklyFloor: 23750, weeklyTarget: 30000 },
  L7DA0MBKD2X4P: { weeklyFloor: 13750, weeklyTarget: 17500 },
};

const WHOLE_CAKE_ITEM_NAMES = [
  "Fresh Strawberry Cake",
  "Matilda Cake",
  "Pistachio Raspberry Cheesecake (GF)",
  "Plain Basque Cheesecake (GF)",
  "Maple Apple Cake",
];
const CAKE_ORDERS_WEEKLY_TARGET = 21;

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}

function reginaToday(): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Regina", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

// 지난주(월~일) 범위. 이 함수는 항상 "완결된 지난주"만 계산한다 — 진행 중인 주는 대상 아님.
function lastWeekRange() {
  const { y, m, d } = reginaToday();
  const today = new Date(Date.UTC(y, m - 1, d));
  const dow = today.getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() + mondayOffset);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  return { start: toDateStr(lastMonday), end: toDateStr(lastSunday) };
}

async function rpc(fn: string, args: Record<string, unknown>, attempt = 0): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    // 이 함수는 사람이 실시간으로 기다리는 게 아니라 일요일 밤 cron이 돌리는 배치라, 일시적
    // 오류(콜드스타트·네트워크 hiccup 등)엔 여유 있게 한 번 더 재시도한다 — 예전엔 401
    // PGRST303 하나만 재시도했는데, 그 외 사유로 실패한 게 조용히 null로 삼켜져서 "포스팅
    // 데이터가 없다"는 식으로 AI가 잘못 단정하는 사고가 있었다(오너 발견, 2026-09-09).
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
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

function netSalesStatus(locationId: string, netSales: number): "red" | "yellow" | "green" {
  const t = KPI_THRESHOLDS[locationId];
  if (netSales < t.weeklyFloor) return "red";
  if (netSales < t.weeklyTarget) return "yellow";
  return "green";
}

async function fetchWholeCakeOrderCount(startDate: string, endDate: string): Promise<number> {
  const results = await Promise.all(
    WHOLE_CAKE_ITEM_NAMES.map((name) =>
      rpc("analytics_item_sales", { p_start_date: startDate, p_end_date: endDate, p_item_name: name, p_location_id: "L7DA0MBKD2X4P" }),
    ),
  );
  return results.reduce((sum: number, r: any) => sum + (r?.total_order_count ?? 0), 0);
}

async function callOpenAI(prompt: string): Promise<string> {
  const res = await fetch(`https://api.openai.com/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning_effort: "none", // 도구 없이도 gpt-5.6-luna 기본값(medium)은 지연시간만 늘림
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}

// 특이사항 문장 — day_offset 0~3(발행 당일~3일 후)/주말 지연 반응을 반영한 기존 상관관계
// 로직(analytics_social_sales_correlation, 0008)의 실제 데이터만 근거로 쓰게 한다. "그날
// 포스팅→그날 매출"식 당일 단순 인과는 명시적으로 금지(오너가 나쁜 예로 지적, 2026-09-08).
async function buildAnomalyNote(locationId: string, locationName: string, start: string, end: string, dailySales: any[]): Promise<string> {
  // 지난주 포스팅 + 그 이후 최대 3일 지연효과까지 보려면 상관관계 조회 범위를 3일 더 넓힌다.
  const lookbackEnd = new Date(end + "T00:00:00Z");
  lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + 3);
  // rpc()가 재시도까지 실패하면 여기서 명시적으로 실패를 구분해둔다 — 예전엔 이걸 조용히
  // null로 삼켜서, Gemini가 "포스팅이 없어서 원인을 모르겠다"는 식으로 **실제로는 포스팅이
  // 있었는데 조회에 실패했을 뿐인 상황**을 잘못 단정해버리는 사고가 있었다(오너 발견,
  // 2026-09-09 — 실제론 그 주 내내 매일 포스팅이 있었음). 조회 실패와 "포스팅이 진짜 없음"은
  // 프롬프트에서 명확히 구분해서 전달해야 한다.
  let correlation: any = null;
  let correlationFailed = false;
  try {
    correlation = await rpc("analytics_dispatch", {
      p_analysis: "social_sales_correlation",
      p_start_date: start,
      p_end_date: toDateStr(lookbackEnd),
      p_location_id: locationId,
    });
  } catch {
    correlationFailed = true;
  }

  const correlationSection = correlationFailed
    ? `(포스팅-매출 상관관계 데이터를 이번엔 시스템 오류로 가져오지 못했다 — 포스팅이 없었다는
뜻이 아니다. 이 경우 포스팅 관련 언급은 하지 말고, 일별 매출 데이터만으로 판단해라.)`
    : `포스팅-매출 상관관계(day_offset=발행일로부터 며칠 후, 같은 요일 4주 평균과 비교):
${JSON.stringify(correlation)}`;

  const prompt = `너는 ${locationName}의 주간 경영 회의용 데이터 분석가다. 아래 실제 데이터만 근거로,
지난주(${start}~${end}) 매출에서 눈에 띄는 부분(튄 날, 침체된 날, 요일 패턴 등)과 그 이유를
한국어 2~3문장으로 짧게 써라.

규칙(반드시 지킬 것):
- 주어진 데이터에 없는 내용을 상상해서 쓰지 마라. 근거가 부족하면 "뚜렷한 원인은 안 보인다"고 써라.
- 포스팅과 매출의 인과관계는 "포스팅 당일" 하나만 보지 마라. 실제로 반응은 발행 후 1~3일 뒤
  또는 다음 주말에 나타나는 경우가 많다 — 아래 correlation 데이터의 day_offset(0~3)을 참고해서
  판단해라.
- 특정 포스팅을 언급할 땐 post_id를 괄호로 표기해라(확인 가능하게).
- 과장하지 말고 담백하게, 회의에서 바로 읽을 수 있는 톤으로.

일별 매출:
${JSON.stringify(dailySales)}

${correlationSection}`;

  try {
    const text = await callOpenAI(prompt);
    return text || "이번 주는 특이사항 문장을 생성하지 못했다.";
  } catch (err) {
    return `특이사항 분석 실패: ${String(err)}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  const { start, end } = lastWeekRange();

  try {
    const salesRows = await rpc("analytics_location_sales_v2", { p_start: start, p_end: end });
    const salesById = Object.fromEntries(salesRows.map((r: any) => [r.location_id, r]));

    const snapshots = [];
    for (const loc of LOCATIONS) {
      const s = salesById[loc.id] ?? { net_sales: 0 };
      const netSales = Number(s.net_sales ?? 0);
      const status = netSalesStatus(loc.id, netSales);

      let cakeCount: number | null = null;
      let cakeStatus: "red" | "yellow" | "green" | null = null;
      if (loc.id === "L7DA0MBKD2X4P") {
        cakeCount = await fetchWholeCakeOrderCount(start, end);
        cakeStatus = cakeCount >= CAKE_ORDERS_WEEKLY_TARGET ? "green" : cakeCount >= CAKE_ORDERS_WEEKLY_TARGET * 0.5 ? "yellow" : "red";
      }

      const social = await rpc("analytics_social_weekly_overview", { p_start_date: start, p_end_date: end, p_location_id: loc.id }).catch(() => null);
      const dailySales = await rpc("analytics_daily_sales", { p_start_date: start, p_end_date: end, p_location_id: loc.id }).catch(() => []);
      const anomalyNote = await buildAnomalyNote(loc.id, loc.name, start, end, dailySales);

      snapshots.push({
        location_id: loc.id,
        week_start: start,
        week_end: end,
        net_sales: netSales,
        net_sales_floor: KPI_THRESHOLDS[loc.id].weeklyFloor,
        net_sales_target: KPI_THRESHOLDS[loc.id].weeklyTarget,
        net_sales_status: status,
        cake_order_count: cakeCount,
        cake_order_target: loc.id === "L7DA0MBKD2X4P" ? CAKE_ORDERS_WEEKLY_TARGET : null,
        cake_status: cakeStatus,
        social_summary: social ?? {},
        anomaly_note: anomalyNote,
        calculated_at: new Date().toISOString(),
      });
    }

    await upsert("weekly_okr_snapshots", snapshots, "location_id,week_start");

    return new Response(JSON.stringify({ status: "success", week_start: start, week_end: end, count: snapshots.length }), {
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
