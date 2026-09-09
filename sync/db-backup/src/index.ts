// Golden Tree — DB 논리적 백업 (Phase 0, 오너 요청 2026-09-09)
//
// 배경: Supabase 두 프로젝트(Automation, Local Growth) 다 Free 요금제라 자동 백업이
// 없다(Management API로 직접 확인, backups: [] 둘 다). Pro 요금제로 올리지 않고 Free를
// 유지하기로 오너가 결정 — 대신 이 함수가 주기적으로 논리적 백업(테이블 row를 JSON으로
// export)을 만들어 "Git 저장소 밖의 별도 클라우드 스토리지"에 보관한다.
//
// 저장 위치: 각 프로젝트 자신의 Supabase Storage(`db-backups` 버킷, private)에 저장하고,
// **상대 프로젝트의 버킷에도 동일 파일을 교차 저장(cross-store)**한다 — 두 프로젝트가 완전히
// 분리된 Storage 인프라라, 한쪽 프로젝트 사고가 백업까지 같이 날리지 않는다. 이 함수는
// Automation 프로젝트에만 배포되고, Local Growth 프로젝트 자체는 손대지 않는다(오너 지시 —
// 기존 production deployment 변경 금지) — 대신 LOCAL_GROWTH_SERVICE_ROLE_KEY로 그
// 프로젝트의 REST/Storage API를 원격으로 호출한다.
//
// 시크릿/토큰은 백업에서 제외한다(오너 지시) — tiktok_oauth_states/tokens(Automation),
// dashboard_access_tokens(Local Growth)는 테이블 목록에서 명시 제외.
//
// **체이닝 설계(중요)**: orders(6.8만 행, raw jsonb 포함) 전체를 한 번의 호출 안에서
// 다 처리하려다 실제로 두 번 막혔다 — 처음엔 메모리(WORKER_RESOURCE_LIMIT, 테이블 전체를
// 한 배열로 들고 있어서), 페이지 단위로 고친 뒤에도 91초 지점에서 또 막힘(누적 CPU 시간
// 한도). Free 티어 Edge Function 하나의 호출은 "가볍게" 끝나야 한다는 뜻 — 그래서 페이지
// 하나(500행)만 처리하고, 다음 페이지 호출을 EdgeRuntime.waitUntil로 "발사 후 응답"한다.
// 각 호출은 새 인스턴스라 매번 자원 한도가 새로 리셋된다. 진행 상태(다음에 어느 테이블·
// 어느 offset을 처리할지, 지금까지 각 테이블 몇 행 백업했는지)는 메모리에 안 남기고
// `_progress.json` 파일에 매 페이지마다 기록해서 이어간다.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const LG_URL = Deno.env.get("LOCAL_GROWTH_SUPABASE_URL")!;
const LG_KEY = Deno.env.get("LOCAL_GROWTH_SERVICE_ROLE_KEY")!;
const SELF_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/db-backup`;
const PAGE_SIZE = 500;

const AUTOMATION_TABLES = [
  "analysis_requests", "customers", "discord_processed_messages", "external_web_metrics",
  "ingredient_price_history", "ingredients", "locations", "market_demand_features",
  "market_demand_outcomes", "market_demand_snapshots", "monthly_tax_overrides",
  "order_items", "orders", "receipt_line_items", "receipts", "recipe_cost_alerts",
  "recipe_cost_daily_snapshots", "recipe_ingredients", "recipes", "regina_weather_history",
  "social_accounts", "social_ad_campaigns", "social_ad_metrics", "social_comments",
  "social_post_metrics", "social_posts", "social_sync_log", "square_catalog_items",
  "square_catalog_variations", "square_categories", "square_payments", "square_refunds",
  "stock_events", "stock_items", "sync_log", "weekly_okr_snapshots",
  // 제외(시크릿/토큰 보유): tiktok_oauth_states, tiktok_oauth_tokens
];

const LOCAL_GROWTH_TABLES = [
  "brands", "locations", "integration_connections", "integration_capabilities",
  "sync_runs", "source_records", "external_actions", "action_versions", "approvals",
  "execution_attempts", "audit_events", "dashboard_snapshots",
  // 제외(토큰 보유): dashboard_access_tokens
];

function tablesFor(label: string): string[] {
  return label === "automation" ? AUTOMATION_TABLES : LOCAL_GROWTH_TABLES;
}
function sourceFor(label: string): { baseUrl: string; key: string } {
  return label === "automation" ? { baseUrl: SUPABASE_URL, key: SERVICE_ROLE_KEY } : { baseUrl: LG_URL, key: LG_KEY };
}
function crossFor(label: string): { baseUrl: string; key: string } {
  return label === "automation" ? { baseUrl: LG_URL, key: LG_KEY } : { baseUrl: SUPABASE_URL, key: SERVICE_ROLE_KEY };
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}

async function fetchPage(baseUrl: string, key: string, table: string, offset: number): Promise<any[]> {
  const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*&limit=${PAGE_SIZE}&offset=${offset}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`fetch ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// count=exact는 order_items(18만+ 행)처럼 큰 테이블에서 실제로 statement timeout(57014)이
// 났다 — planner 통계 기반의 count=estimated로 바꾼다. 검증 목적("대략 맞는지")엔 충분하고,
// 매번 무거운 전체 스캔을 돌리지 않아도 된다.
async function countRows(baseUrl: string, key: string, table: string): Promise<number> {
  const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=estimated" },
  });
  if (!res.ok) throw new Error(`count ${table} failed: ${res.status} ${await res.text()}`);
  const range = res.headers.get("content-range");
  return range ? Number(range.split("/")[1]) : -1;
}

async function uploadJson(baseUrl: string, key: string, bucket: string, path: string, body: string) {
  const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "x-upsert": "true" },
    body,
  });
  if (!res.ok) throw new Error(`upload ${bucket}/${path} failed: ${res.status} ${await res.text()}`);
}

async function downloadJson(baseUrl: string, key: string, bucket: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function listLatestFolder(baseUrl: string, key: string, bucket: string, prefix: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, sortBy: { column: "name", order: "desc" }, limit: 5 }),
  });
  if (!res.ok) throw new Error(`list ${bucket}/${prefix} failed: ${res.status} ${await res.text()}`);
  const items = await res.json();
  const folder = items.find((i: any) => i.id === null); // 폴더는 id가 null로 옴
  return folder ? `${prefix}${folder.name}` : null;
}

function selfUrl(params: Record<string, string | number>): string {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  return `${SELF_FUNCTION_URL}?${qs.toString()}`;
}

function fireNext(params: Record<string, string | number>) {
  // @ts-ignore — Supabase Edge Runtime 전역. 응답은 바로 내려주고, 다음 페이지 호출은
  // 백그라운드로 발사한다 — 그래야 이번 호출이 가볍게 끝나서 CPU 시간 한도를 안 넘긴다.
  EdgeRuntime.waitUntil(fetch(selfUrl(params), { headers: { "x-sync-secret": SYNC_SHARED_SECRET } }));
}

// 체이닝 한 스텝: label의 tables[tableIndex] 테이블에서 offset부터 PAGE_SIZE개를 백업.
async function runStep(label: string, folder: string, tableIndex: number, offset: number) {
  const tables = tablesFor(label);
  if (tableIndex >= tables.length) {
    // 전체 완료 — manifest 확정
    const progress = (await downloadJson(...Object.values(sourceFor(label)) as [string, string], "db-backups", `${folder}/_progress.json`)) ?? { row_counts: {} };
    // 빈 테이블은 한 페이지도 안 거쳐서 progress에 기록이 안 남는다 — 0행으로 명시(누락 아님).
    const rowCounts = Object.fromEntries(tables.map((t) => [t, progress.row_counts[t] ?? 0]));
    const manifest = JSON.stringify({ source: label, generated_at: folder.split("/")[1], tables, row_counts: rowCounts, status: "complete" });
    const self = sourceFor(label);
    const cross = crossFor(label);
    await uploadJson(self.baseUrl, self.key, "db-backups", `${folder}/_manifest.json`, manifest);
    await uploadJson(cross.baseUrl, cross.key, "db-backups", `${folder}/_manifest.json`, manifest);
    return;
  }

  const table = tables[tableIndex];
  const self = sourceFor(label);
  const cross = crossFor(label);
  const page = await fetchPage(self.baseUrl, self.key, table, offset);

  if (page.length > 0) {
    const partIndex = Math.floor(offset / PAGE_SIZE);
    const payload = JSON.stringify({ source: label, table, part: partIndex, rows: page });
    const path = `${folder}/${table}/part-${String(partIndex).padStart(4, "0")}.json`;
    await uploadJson(self.baseUrl, self.key, "db-backups", path, payload);
    await uploadJson(cross.baseUrl, cross.key, "db-backups", path, payload);

    // 진행 상황 기록(각 테이블 지금까지 몇 행 백업했는지) — 다음 호출이 이걸 읽어서 이어감
    const progress = (await downloadJson(self.baseUrl, self.key, "db-backups", `${folder}/_progress.json`)) ?? { row_counts: {} };
    progress.row_counts[table] = (progress.row_counts[table] ?? 0) + page.length;
    const progressPayload = JSON.stringify(progress);
    await uploadJson(self.baseUrl, self.key, "db-backups", `${folder}/_progress.json`, progressPayload);
    await uploadJson(cross.baseUrl, cross.key, "db-backups", `${folder}/_progress.json`, progressPayload);
  }

  if (page.length < PAGE_SIZE) {
    // 이 테이블 끝 — 다음 테이블로
    fireNext({ action: "step", label, folder, tableIndex: tableIndex + 1, offset: 0 });
  } else {
    fireNext({ action: "step", label, folder, tableIndex, offset: offset + PAGE_SIZE });
  }
}

async function verifyBackup(label: string) {
  const self = sourceFor(label);
  const latestFolder = await listLatestFolder(self.baseUrl, self.key, "db-backups", `${label}/`);
  if (!latestFolder) return { label, status: "no_backup_found" };
  const manifest = await downloadJson(self.baseUrl, self.key, "db-backups", `${latestFolder}/_manifest.json`);
  if (!manifest) return { label, folder: latestFolder, status: "backup_incomplete_or_in_progress" };
  const mismatches: Record<string, { backup: number; live: number }> = {};
  for (const t of tablesFor(label)) {
    const backupCount = manifest.row_counts?.[t] ?? -1;
    const liveCount = await countRows(self.baseUrl, self.key, t);
    // count=estimated는 planner 통계 기반 근사치라 정확히 일치하지 않는다 — 절대 오차 50 또는
    // 5% 중 큰 쪽까지는 정상으로 본다. 그보다 크게 벌어지면 진짜 이상 신호.
    const tolerance = Math.max(50, liveCount * 0.05);
    if (liveCount !== -1 && Math.abs(backupCount - liveCount) > tolerance) mismatches[t] = { backup: backupCount, live: liveCount };
  }
  return {
    label,
    folder: latestFolder,
    generated_at: manifest.generated_at,
    status: Object.keys(mismatches).length === 0 ? "ok" : "row_count_drift",
    note: "실시간 DB가 백업 시점 이후 계속 바뀌므로 약간의 drift는 정상 — 큰 차이만 이상 신호. " +
      "이 검증은 저장된 백업 파일의 정합성 확인이며, 아직 '빈 DB에 실제로 복원'하는 진짜 restore drill은 아니다(로컬 Supabase 스택 도입 후 강화 예정).",
    mismatches,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "start";

  try {
    if (action === "start") {
      const label = url.searchParams.get("label") ?? "automation";
      const generatedAt = new Date().toISOString();
      const folder = `${label}/${generatedAt.replace(/[:.]/g, "-")}`;
      fireNext({ action: "step", label, folder, tableIndex: 0, offset: 0 });
      return new Response(JSON.stringify({ status: "started", label, folder }), { headers: { "content-type": "application/json", ...corsHeaders() } });
    }
    if (action === "step") {
      const label = url.searchParams.get("label")!;
      const folder = url.searchParams.get("folder")!;
      const tableIndex = Number(url.searchParams.get("tableIndex"));
      const offset = Number(url.searchParams.get("offset"));
      await runStep(label, folder, tableIndex, offset);
      return new Response(JSON.stringify({ status: "step_ok" }), { headers: { "content-type": "application/json", ...corsHeaders() } });
    }
    if (action === "verify") {
      const automation = await verifyBackup("automation");
      const localGrowth = await verifyBackup("local-growth");
      return new Response(JSON.stringify({ status: "success", automation, local_growth: localGrowth }), { headers: { "content-type": "application/json", ...corsHeaders() } });
    }
    return new Response(JSON.stringify({ error: `unknown action: ${action}` }), { status: 400, headers: corsHeaders() });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders() },
    });
  }
});
