// Golden Tree — 재고 입력 웹페이지 백엔드 (docs/decisions/0014)
//
// web/stock-entry(정적 HTML)이 이 함수를 호출한다. Discord `/stock`과 같은 테이블
// (stock_items, stock_events)을 직접 쓴다 — 두 입력 경로가 하나의 데이터로 합쳐진다.
//
// 인증: 직원 여러 명이 공유하는 비밀번호(STOCK_ENTRY_PASSCODE) 하나만 검사한다.
// 개인별 로그인이 아니라 "공개 웹페이지는 아니게" 하는 정도의 가벼운 게이트 — 소규모
// 매장 운영에 맞춘 선택(오너 결정 없이 기본값으로 진행, 필요시 나중에 강화).
//
// GET  /stock-entry-api                          → 현재 재고 현황(analytics_stock_overview)
// POST /stock-entry-api {action:"event", ...}     → count/production 이벤트 기록
// POST /stock-entry-api {action:"set_units", ...} → 통당 개수·라벨 수정

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STOCK_ENTRY_PASSCODE = Deno.env.get("STOCK_ENTRY_PASSCODE")!;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-stock-passcode",
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
    if (res.status === 401 && text.includes("PGRST303") && attempt < 2) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpc(fn, args, attempt + 1);
    }
    throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function restPost(table: string, rows: any[]) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} failed: ${res.status} ${await res.text()}`);
}

async function restPatch(table: string, id: number, patch: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update ${table} failed: ${res.status} ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  const passcode = req.headers.get("x-stock-passcode");
  if (passcode !== STOCK_ENTRY_PASSCODE) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const locationId = url.searchParams.get("location_id");
      const overview = await rpc("analytics_stock_overview", { p_location_id: locationId });
      return new Response(JSON.stringify({ items: overview }), {
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();

      if (body.action === "event") {
        const { stock_item_id, event_type, container_count, created_by } = body;
        if (!stock_item_id || !["count", "production"].includes(event_type) || typeof container_count !== "number") {
          throw new Error("invalid event payload");
        }
        await restPost("stock_events", [{
          stock_item_id,
          event_type,
          container_count,
          created_by: created_by || "web",
        }]);
        return new Response(JSON.stringify({ status: "success" }), {
          headers: { "content-type": "application/json", ...corsHeaders() },
        });
      }

      if (body.action === "set_units") {
        const { stock_item_id, units_per_container, container_label } = body;
        if (!stock_item_id) throw new Error("stock_item_id required");
        const patch: Record<string, unknown> = {};
        if (typeof units_per_container === "number" && units_per_container > 0) patch.units_per_container = units_per_container;
        if (typeof container_label === "string" && container_label.trim()) patch.container_label = container_label.trim();
        await restPatch("stock_items", stock_item_id, patch);
        return new Response(JSON.stringify({ status: "success" }), {
          headers: { "content-type": "application/json", ...corsHeaders() },
        });
      }

      throw new Error(`unknown action: ${body.action}`);
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
