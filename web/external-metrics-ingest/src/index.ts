// Golden Tree — 외부(웹사이트/GBP) 지표 수신 엔드포인트 (오너 요청, 2026-09-08)
//
// 배경: 웹사이트·Google Business는 코덱스 사이드 프로젝트가 별도 저장소에서 관리한다
// (0005). 오너 지시: 저장소를 합치지 않고, "메인 자료(브랜드 md, API 키 등)만 공유하고
// 각 프로젝트는 독립적으로 돌아가되 서로 업데이트할 수 있는 창구"를 원함 — 이 함수가 그
// 창구다. 코덱스 프로젝트가 이 엔드포인트로 웹사이트 세션수·GBP 조회수 등을 밀어넣으면
// Golden Tree DB(external_web_metrics)에 쌓이고, 대시보드/주간 OKR이 그걸 읽어 쓴다.
// Golden Tree는 이 데이터를 직접 수집하지 않는다 — 오직 수신만 한다.
//
// 인증은 Discord/Square 등 내부 동기화와 다른 별도 비밀(EXTERNAL_METRICS_SECRET)을 쓴다 —
// 외부(다른 저장소·다른 서비스 계정)에 나눠줄 값이라 내부 SYNC_SHARED_SECRET과 분리한다.
//
// POST body: { source: "website"|"gbp", metric_date: "YYYY-MM-DD", metric_name: string,
//              metric_value: number, location_id?: string, raw?: object }
// 또는 배열로 여러 건을 한 번에 보낼 수 있다: { items: [...] }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EXTERNAL_METRICS_SECRET = Deno.env.get("EXTERNAL_METRICS_SECRET")!;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-metrics-secret",
  };
}

type MetricItem = {
  source: "website" | "gbp";
  metric_date: string;
  metric_name: string;
  metric_value: number;
  location_id?: string | null;
  raw?: Record<string, unknown>;
};

function validate(item: any): item is MetricItem {
  return (
    (item.source === "website" || item.source === "gbp") &&
    typeof item.metric_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.metric_date) &&
    typeof item.metric_name === "string" && item.metric_name.trim().length > 0 &&
    typeof item.metric_value === "number" && Number.isFinite(item.metric_value)
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: corsHeaders() });
  if (req.headers.get("x-metrics-secret") !== EXTERNAL_METRICS_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: corsHeaders() });
  }

  const items: any[] = Array.isArray(body.items) ? body.items : [body];
  const invalid = items.filter((i) => !validate(i));
  if (invalid.length > 0) {
    return new Response(JSON.stringify({ error: "invalid item(s)", invalid }), { status: 400, headers: corsHeaders() });
  }

  const rows = items.map((i: MetricItem) => ({
    source: i.source,
    metric_date: i.metric_date,
    metric_name: i.metric_name,
    metric_value: i.metric_value,
    location_id: i.location_id ?? null,
    raw: i.raw ?? {},
  }));

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/external_web_metrics?on_conflict=source,metric_date,metric_name,location_id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `upsert failed: ${res.status} ${await res.text()}` }), {
      status: 500, headers: corsHeaders(),
    });
  }

  return new Response(JSON.stringify({ status: "success", count: rows.length }), {
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
});
