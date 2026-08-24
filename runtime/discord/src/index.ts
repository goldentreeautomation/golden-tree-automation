// Golden Tree — Discord 런타임 봇 (W4, docs/golden-tree-design.md)
//
// 흐름: 슬래시 명령 수신 → Gemini가 질문→Query Contract 함수 파라미터로 변환 → analytics_dispatch
// 실행(코드) → Gemini가 결과 숫자만으로 답변 문장 생성 → Discord에 회신.
//
// 이 파일이 곧 "runtime/router/"의 역할도 겸한다 — 질문을 analytics_dispatch 파라미터로
// 바꾸는 라우팅 로직이 여기 있다. 화면(빌더 에이전트)과 실행 환경(런타임 봇)은 다르다
// (docs/golden-tree-design.md 3.1) — 이 함수는 Supabase Edge Function, 오너 맥북과 무관하게 돈다.
//
// Query Contract 준수: 여기서 raw SQL을 절대 만들지 않는다. 오직 analytics_dispatch RPC만
// 호출한다 (CLAUDE.md 불변 규칙 #1). Gemini가 고를 수 있는 analysis 종류는 ALLOWED_ANALYSIS로
// 화이트리스트했다 — LLM이 계약 밖의 값을 지어내도 서버에서 막는다.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DISCORD_PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY")!;
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN")!;
const DISCORD_APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_MODEL = "gemini-3.6-flash";

const LOCATIONS: Record<string, string> = {
  "Bon Sushi": "LWEFT8C6SXJ7J",
  "CozyHaus": "L7DA0MBKD2X4P",
};

// docs/contracts/query-contract.md와 동기화 유지 — analytics_dispatch가 지원하는 것 중
// 이 봇(analyst 페르소나, M2)이 다룰 범위만 허용한다. social_* 는 marketing 페르소나 몫(M3+).
const ALLOWED_ANALYSIS = [
  "sales_summary",
  "location_sales",
  "top_items",
  "item_sales",
  "hourly_sales",
  "daily_sales",
  "monthly_sales",
  "category_sales",
  "comparison",
  "customer_retention",
];

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(DISCORD_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

function reginaTodayStr(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Regina",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function callGemini(systemPrompt: string, userText: string, jsonMode: boolean): Promise<string> {
  const body: any = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };
  if (jsonMode) body.generationConfig = { responseMimeType: "application/json" };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

function routerSystemPrompt(today: string): string {
  return `너는 82 Bakeshop(CozyHaus, Bon Sushi 두 매장)의 매출 데이터 조회 라우터다.
오늘 날짜(America/Regina 기준)는 ${today}다. 사용자의 질문을 아래 JSON 스키마로만 답해라. 다른 텍스트 금지.

analysis 값은 반드시 다음 중 하나: ${ALLOWED_ANALYSIS.join(", ")}
- sales_summary: 특정 기간 매출 요약 (순매출, 주문수, 객단가)
- location_sales: 두 매장 비교
- top_items: 잘 팔린 품목 순위 (item_name 필요없음, limit로 개수 조절)
- item_sales: 특정 품목 하나의 판매 현황 (item_name 필수)
- hourly_sales: 시간대별 매출
- daily_sales: 일자별 매출
- monthly_sales: 월별 매출 (역대 최고/최저 달, 월별 추이 질문에 사용. "지금까지"/"역대"는 start_date를 2025-01-01로)
- category_sales: 카테고리별 매출 비중
- comparison: 두 기간 비교 (compare_start, compare_end 필수)
- customer_retention: 신규/재방문 고객 비율

location_id는 다음 중 하나 또는 null(전체): "LWEFT8C6SXJ7J"(Bon Sushi), "L7DA0MBKD2X4P"(CozyHaus)

JSON 스키마:
{
  "analysis": "...",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "location_id": "..." 또는 null,
  "limit": 숫자 또는 null,
  "item_name": "..." 또는 null,
  "compare_start": "YYYY-MM-DD" 또는 null,
  "compare_end": "YYYY-MM-DD" 또는 null
}

"이번주"는 이번주 월요일~오늘, "지난주"는 지난주 월~일, "오늘"은 오늘 하루, "이번달"은 이번달 1일~오늘.
질문이 위 analysis 중 어디에도 해당하지 않으면 analysis를 "unsupported"로 답해라.`;
}

function answerSystemPrompt(): string {
  return `너는 82 Bakeshop 매장 데이터를 설명하는 어시스턴트다. 아래에 주어지는 JSON 데이터에 있는
숫자만 사용해서 한국어로 짧고 명확하게 답해라. 데이터에 없는 숫자를 지어내지 마라.
금액은 CAD 달러 기준이고 이미 세금·팁이 제외된 Net Sales다. 존댓말을 쓰되 간결하게. 이모지 쓰지 마라.`;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function parseJsonLoose(text: string): any {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

async function editFollowup(token: string, content: string) {
  await fetch(
    `https://discord.com/api/v10/webhooks/${DISCORD_APPLICATION_ID}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

async function handleAsk(question: string, token: string) {
  try {
    const today = reginaTodayStr();
    const routerRaw = await callGemini(routerSystemPrompt(today), question, true);
    const plan = parseJsonLoose(routerRaw);

    if (!ALLOWED_ANALYSIS.includes(plan.analysis)) {
      await editFollowup(
        token,
        `이 질문은 아직 답할 수 없습니다 (지원 범위 밖). 매출/품목/시간대/카테고리 관련 질문으로 다시 물어봐 주세요.`,
      );
      return;
    }

    const result = await rpc("analytics_dispatch", {
      p_analysis: plan.analysis,
      p_start_date: plan.start_date,
      p_end_date: plan.end_date,
      p_location_id: plan.location_id ?? null,
      p_limit: plan.limit ?? 10,
      p_compare_start: plan.compare_start ?? null,
      p_compare_end: plan.compare_end ?? null,
      p_item_name: plan.item_name ?? null,
    });

    const answer = await callGemini(
      answerSystemPrompt(),
      `질문: ${question}\n\n데이터: ${JSON.stringify(result)}`,
      false,
    );

    await editFollowup(token, `${answer}\n\n-# ${plan.analysis} · ${plan.start_date}~${plan.end_date}`);
  } catch (err) {
    console.error(err);
    await editFollowup(token, `조회 중 오류가 발생했습니다: ${String(err).slice(0, 300)}`);
  }
}

Deno.serve(async (req) => {
  const rawBody = await req.text();
  const valid = await verifySignature(req, rawBody);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const interaction = JSON.parse(rawBody);

  if (interaction.type === 1) {
    // PING
    return new Response(JSON.stringify({ type: 1 }), { headers: { "content-type": "application/json" } });
  }

  if (interaction.type === 2) {
    // APPLICATION_COMMAND
    if (interaction.data?.name === "ask") {
      const question = interaction.data.options?.find((o: any) => o.name === "question")?.value ?? "";

      // idempotency: 같은 interaction을 재시도로 두 번 받아도 한 번만 처리
      const claim = await rpc("claim_discord_message", { p_message_id: `interaction:${interaction.id}` });
      if (claim?.claimed) {
        // @ts-ignore — Supabase Edge Runtime 전역, 응답 이후에도 백그라운드 작업을 이어간다
        EdgeRuntime.waitUntil(handleAsk(question, interaction.token));
      }

      return new Response(JSON.stringify({ type: 5 }), { headers: { "content-type": "application/json" } }); // DEFERRED
    }
  }

  return new Response(JSON.stringify({ type: 4, data: { content: "지원하지 않는 명령입니다." } }), {
    headers: { "content-type": "application/json" },
  });
});
