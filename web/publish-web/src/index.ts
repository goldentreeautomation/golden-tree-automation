// Golden Tree — 정적 페이지 배포 도구
//
// Supabase Edge Function은 브라우저가 주소창으로 직접 들어오면(navigate) 피싱 방지 차원에서
// 강제로 text/plain + CSP sandbox로 감싸서 응답한다 — 실제 웹페이지로 열 수 없다
// (docs/decisions/0003 참조). 그래서 브라우저가 직접 여는 화면은 Supabase Storage(public
// bucket)에 정적 파일로 올려서 서빙한다. 이 함수는 dashboard 함수가 만드는 HTML을 그대로
// 가져와 Storage에 재업로드한다 — HTML 내용은 web/dashboard/src/index.ts 한 곳에서만 관리한다.
//
// 사용법: web/dashboard/src/index.ts 수정 → dashboard 함수 재배포 → 이 함수 호출

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const BUCKET = "golden-tree-web";

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const htmlRes = await fetch(`${SUPABASE_URL}/functions/v1/dashboard`);
  if (!htmlRes.ok) {
    return new Response(JSON.stringify({ error: `dashboard fetch failed: ${htmlRes.status}` }), { status: 500 });
  }
  const html = await htmlRes.text();

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/index.html`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "text/html; charset=utf-8",
      "x-upsert": "true",
      "Cache-Control": "no-cache",
    },
    body: html,
  });
  const uploadBody = await uploadRes.text();
  if (!uploadRes.ok) {
    return new Response(JSON.stringify({ error: `upload failed: ${uploadRes.status} ${uploadBody}` }), { status: 500 });
  }

  return new Response(
    JSON.stringify({
      status: "success",
      bytes: html.length,
      public_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/index.html`,
    }),
    { headers: { "content-type": "application/json" } },
  );
});
