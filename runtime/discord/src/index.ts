// Golden Tree — Discord 런타임 봇 (W4, docs/golden-tree-design.md)
//
// 흐름 (2026-09-04, function calling으로 재구성 / 2026-09-09 Gemini→OpenAI 교체): 슬래시
// 명령 수신 → LLM에게 query_data 도구를 쥐어주고 루프를 돈다 — 질문이 복잡하면(예: "매출
// 비교하고 SNS 업로드 현황이랑 연관 봐줘") 여러 번 나눠서 호출해 필요한 데이터를 전부 모은
// 뒤 최종 답을 쓴다(MAX_TOOL_CALLS로 상한). 전엔 "질문→JSON 1개→함수 1번 호출→답변"으로
// 고정이라 여러 데이터가 필요한 질문에 답을 못 했다(오너/매니저 피드백).
//
// **2026-09-09 Gemini→OpenAI 교체**: Gemini 무료 티어가 하루 20건 한도로 자주 막히고,
// 그 API 특유의 wire-format 버그(role 이름, thought_signature 누락 시 400 등)를 여러 번
// 겪었다(오너 결정 — 유료 GPT 계정 이미 보유, 안정성 우선). OpenAI Chat Completions API의
// 표준 tool-calling 형식(tool_calls/role:"tool"/tool_call_id)으로 옮김 — Gemini 특유의
// 특수 처리(functionCall thought_signature 보존, role:"user"로 우회 등)가 전부 불필요해짐.
//
// 이 파일이 곧 "runtime/router/"의 역할도 겸한다 — 질문을 analytics_dispatch 파라미터로
// 바꾸는 라우팅 로직이 여기 있다. 화면(빌더 에이전트)과 실행 환경(런타임 봇)은 다르다
// (docs/golden-tree-design.md 3.1) — 이 함수는 Supabase Edge Function, 오너 맥북과 무관하게 돈다.
//
// Query Contract 준수: LLM이 호출할 수 있는 도구는 query_data 하나뿐이고, 그 안에서도
// analysis는 ALLOWED_ANALYSIS 화이트리스트로 서버가 재검증한다 — 여러 번 호출을 허용해도
// analytics_dispatch(=Query Contract 함수) 밖으로는 절대 못 나간다 (CLAUDE.md 불변 규칙 #1).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DISCORD_PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY")!;
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN")!;
const DISCORD_APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_MODEL = "gpt-5.6-luna"; // 가장 저렴한 티어 (입력 $0.20/출력 $1.20 per 1M tokens) — 오너 확정, 2026-09-09
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;

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
  "modifier_sales",
  "hourly_sales",
  "daily_sales",
  "monthly_sales",
  "category_sales",
  "comparison",
  "customer_retention",
  "social_sales_correlation",
  "post_item_trend",
  "social_posts",
  "social_campaigns",
  "social_ads",
  "social_comments",
  "stock_status",
  "tax_summary",
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

// fetch()는 기본적으로 타임아웃이 없다 — 상대 서버가 응답 없이 연결만 붙잡고 있으면 영원히
// 기다린다. 오너가 실제로 겪음(1시 4분에 물어본 게 2시 18분까지 "생각 중"으로 멈춰있었음,
// 2026-09-04) — 원인은 이거였을 가능성이 크다. 모든 외부 호출에 타임아웃을 강제한다.
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 과부하(429/503)는 일시적인 경우가 많아 지수 백오프로 재시도한다.
async function callOpenAIRaw(body: any, attempt = 0): Promise<any> {
  const res = await fetchWithTimeout(
    `https://api.openai.com/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, ...body }),
    },
    30000,
  );
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
    return callOpenAIRaw(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// analysis별 설명 — query_data 도구 스키마와 에이전트 시스템 프롬프트가 공유한다.
const ANALYSIS_DESCRIPTIONS = `- sales_summary: 특정 기간 매출 요약 (순매출, 주문수, 객단가)
- location_sales: 두 매장 비교
- top_items: 잘 팔린 품목 순위 (item_name 필요없음, limit로 개수 조절)
- item_sales: 메뉴판에 그 자체로 이름이 있는 품목 하나의 판매 현황 (예: Latte, Dynamite Roll, Macaron). item_name 필수, 영어로
- modifier_sales: 음료/메뉴에 "추가"하는 옵션 단위 조회. 우유 종류(Oat/Almond/Soy/Coconut/Skim Milk), 시럽, Decaf, Extra Shot처럼
  그 자체로는 주문할 수 없고 다른 메뉴에 딸려 나오는 것들. "오트밀크 몇 건", "아몬드밀크 주문 얼마나" 같은 질문은
  무조건 이거다 — item_sales로 보내면 안 된다(그런 이름의 독립 메뉴가 없어서 0건으로 잘못 나온다). item_name에 옵션명, 영어로 (예: "Oat Milk")
- hourly_sales: 시간대별 매출
- daily_sales: 일자별 매출 (일별 최고/최저·날짜별 평균 계산엔 이걸로 구간을 받아와서 네가 직접 계산해라)
- monthly_sales: 월별 매출 (역대 최고/최저 달, 월별 추이 질문에 사용. "지금까지"/"역대"는 start_date를 2025-01-01로)
- category_sales: 카테고리별 매출 비중
- comparison: 두 기간 비교 (compare_start, compare_end 필수)
- customer_retention: 신규/재방문 고객 비율
- social_sales_correlation: 인스타 포스트 발행일 + 이후 3일간, 그날그날 매출을 "그 요일 최근 4주 평균"과 비교(day_offset 0~3). 요일 편중을 피하려고 포스팅 당일이 아니라 각 offset일 자체의 요일 기준으로 비교한다 (인과관계 아님, 상관관계만). "포스팅하면 매출 늘어?", "포스팅하고 며칠 뒤에 효과 나타나?" 류 질문에 사용
- post_item_trend: 특정 메뉴를 다룬 포스트 발행 후 0~3일간 그 메뉴 매출 추이 (item_name 필수, 영어 메뉴명. "라떼 포스트 올리고 라떼 잘 팔렸어?" 류 질문)
- social_posts: 인스타그램 포스트별 좋아요·댓글·공유·저장·도달 (limit로 개수 조절, item_name에 검색어 넣으면 캡션/태그 검색). 날짜는 published_date(America/Regina 현지 날짜) 필드를 써라 — published_at(UTC 원본시각)의 날짜 부분을 그대로 읽지 마라, 자정 근처 게시물은 하루 밀려서 틀린다. ai_visual_description은 캡션이 애매할 때만 보조로 참고해라(2026-09-04부터 새로 올라오는 포스트만 있음, 과거 포스트는 null) — 그래도 caption이 있으면 caption을 우선해라
- social_campaigns: 광고 캠페인 "목록·개수"만 (몇 개 있는지, 목적/상태별 집계). **금액·지출·성과 지표가 전혀 없다** — "캠페인 몇 개야" 류에만 사용
- social_ads: 광고 캠페인별 지출·노출·클릭·CTR·CPC·results·**cost_per_result**(결과 1건당 비용). PAGE_LIKES 목적 캠페인의 results는 페이지 좋아요(팔로우) 수이므로 cost_per_result가 곧 "팔로우당 비용". 비용·성과·효율 비교는 전부 이거 — social_campaigns 아님
- social_comments: 인스타그램 댓글 원문 (item_name에 검색어 넣으면 댓글 내용 검색). 날짜는 created_date(America/Regina 현지 날짜) 필드를 써라
- stock_status: 완제품 재고 현황(마카롱 등 통 단위로 트래킹하는 것들) — 마지막으로 센 시점 이후 생산량은 더하고 Square 판매량은 뺀 추정치. status(없음/거의없음/조금여유/보통/충분/기록없음), days_left(현재 속도로 며칠 버티는지) 포함. "지금 뭐 만들어야 돼", "마카롱 재고 어때" 류 질문에 사용. start_date/end_date는 이 analysis엔 의미 없으니 아무 날짜나(오늘) 채워라
- tax_summary: 기간별 매장별 GST/PST/Saskatchewan PST/LCT 세금액과 순매출. "세금 신고", "GST 얼마야", "PST 계산해줘" 류 질문에 사용. location_id는 무시되고 항상 두 매장 다 나온다. Bon Sushi는 주류 판매로 LCT가 추가로 있을 수 있다`;

function queryDataTool() {
  return [
    {
      type: "function",
      function: {
        name: "query_data",
        description: "82 Bakeshop(CozyHaus, Bon Sushi) 매출·소셜·광고 데이터를 조회한다. Query Contract 함수만 호출하며 이 목록 밖은 절대 만들어내지 마라.",
        parameters: {
          type: "object",
          properties: {
            analysis: { type: "string", enum: ALLOWED_ANALYSIS, description: ANALYSIS_DESCRIPTIONS },
            start_date: { type: "string", description: "YYYY-MM-DD" },
            end_date: { type: "string", description: "YYYY-MM-DD" },
            location_id: { type: "string", description: `"LWEFT8C6SXJ7J"(Bon Sushi) 또는 "L7DA0MBKD2X4P"(CozyHaus). 전체 매장이면 이 필드 자체를 생략해라.` },
            limit: { type: "integer", description: "결과 개수 제한, 기본 10" },
            item_name: { type: "string", description: "item_sales/modifier_sales/post_item_trend에서 필수" },
            compare_start: { type: "string", description: "comparison에서 필수, YYYY-MM-DD" },
            compare_end: { type: "string", description: "comparison에서 필수, YYYY-MM-DD" },
          },
          required: ["analysis", "start_date", "end_date"],
        },
      },
    },
  ];
}

function agentSystemPrompt(today: string): string {
  return `너는 82 Bakeshop(CozyHaus, Bon Sushi 두 매장)의 데이터 분석 어시스턴트다.
오늘 날짜(America/Regina 기준)는 ${today}다.

너는 query_data 도구로 데이터를 조회할 수 있다. 도구가 지원하는 analysis 종류:
${ANALYSIS_DESCRIPTIONS}

**여러 번 호출해도 된다. 하지만 도구 호출은 최대 6번뿐이니 아껴 써라.** 질문이 복잡하면(예: "5~8월
매출 비교하고 SNS 업로드 현황이랑 연관 있는지 봐줘") 필요한 데이터를 여러 번 나눠서 가져와라 — 예:
daily_sales를 5~8월 범위로 한 번, social_posts를 같은 범위로 한 번, 이렇게 모은 다음 네가 직접
종합해서 분석해라. 월별 최고/최저 매출일이나 날짜별 평균처럼 집계가 필요한 계산은 daily_sales/
monthly_sales로 받은 원자료를 놓고 네가 직접 계산해라(데이터가 없는데 숫자를 지어내지 마라).

**절대 하지 말아야 할 것: 날짜 하나하나마다 따로 호출하기.** 예를 들어 "매출 3000불 넘은 날들과
이유"처럼 "여러 날짜를 찾고 각각 이유를 설명"해야 하는 질문이면, (1) daily_sales를 전체 기간 **한 번만**
호출해서 조건에 맞는 날짜들을 네가 직접 걸러내고, (2) social_posts나 social_sales_correlation도
그 날짜들을 포함하는 **넓은 기간으로 한 번만** 호출해서, 그 안에서 날짜별로 대조해라. 찾은 날짜가
3개든 10개든 그 개수만큼 도구를 반복 호출하지 마라 — 호출 횟수를 다 쓰고 답을 못 낼 위험이 크다.

location_id는 "LWEFT8C6SXJ7J"(Bon Sushi)/"L7DA0MBKD2X4P"(CozyHaus) 중 하나 또는 생략(전체).
"이번주"는 이번주 월요일~오늘, "지난주"는 지난주 월~일, "오늘"은 오늘 하루, "이번달"은 이번달 1일~오늘.

데이터를 충분히 모았으면 도구 호출을 멈추고 한국어로 최종 답을 써라. 반드시 지켜야 할 것:
- 데이터에 없는 숫자를 지어내지 마라. JSON 안의 숫자로 직접 계산(합계·평균·최대/최소 등)하는 건 괜찮다
- **포스트 내용(캡션·주제·이벤트명)을 언급할 땐 도구가 실제로 돌려준 caption 필드 원문에서만 인용하거나
  요약해라.** 다른 포스트와 헷갈리지 말고, 그럴듯하게 들리라고 내용을 지어내거나 각색하지 마라
  (예: 캡션에 없는 "타르트", "50% 할인" 같은 걸 만들어 붙이지 마라). 특정 날짜의 포스트 내용을
  설명해야 하는데 그 날짜에 해당하는 post_id가 도구 결과에 없으면, "그날은 게시물이 없었다"고
  명확히 말해라 — 있었던 것처럼 지어내는 게 제일 나쁘다. 특정 포스트를 언급할 땐 반드시 그
  post_id를 괄호로 같이 적어라(예: "…(post_id: 123)") — 근거 없이는 못 쓰게 스스로를 검증하는
  장치다
- 포스팅 이후 매출 추이(예: "포스팅하면 매출 늘어?", "효과가 며칠 가?")를 물으면 발행 당일(day_offset 0)
  만 보여주지 말고 0~3일차를 전부 보여줘라 — 뒷심(잔존 효과)이 더 중요한 질문이다
- 금액은 CAD, 이미 세금·팁 제외된 Net Sales
- 존댓말, 간결하게, 이모지 금지
- vs_baseline_pct나 포스트-매출 관련 데이터를 설명할 땐 "상관관계일 뿐 그 포스트 때문이라고 단정할 수
  없다"는 취지를 짧게 덧붙여라 — 다른 요인(요일, 날씨, 프로모션 등)일 수도 있다
- 물어본 정확한 지표가 없어도 대화를 끊지 마라. 조회한 데이터 안의 가까운 숫자로 직접 계산하거나,
  그래도 없으면 "이 데이터엔 없지만 대신 OO은 있는데 그걸로 볼까요?"처럼 구체적인 대안을 먼저 제안해라.
  "제공된 데이터로는 알 수 없습니다"로 끝내는 답은 마지막 수단이다
- 질문이 이 도구로 답할 수 있는 범위(매출/품목/시간대/카테고리/소셜/광고)를 완전히 벗어나면 도구를
  호출하지 말고 그렇다고 짧게 답해라

도구 호출 결과에 "error" 필드가 있으면 조회가 실패한 것이다. 바로 포기하지 말고 에러 메시지를 읽고
원인을 스스로 판단해서 파라미터를 고쳐 다시 호출해라 — 예: 날짜 범위가 너무 길면 좁혀라, item_name이
빠졌다고 하면 채워라, analysis 이름이 틀렸다고 하면 목록에서 맞는 걸 다시 골라라. 같은 실수를 그대로
반복하지 마라. 두세 번 고쳐봐도 계속 실패하면 사용자에게 어떤 조회가 왜 안 됐는지 짧게 설명해라.`;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  // 전체 기간("지금까지") 같은 넓은 범위 조회는 실측 20초를 넘기기도 한다(category_sales
  // 전체 기간 실측 ~22초, 2026-09-08 오너 보고로 발견) — 20초는 너무 taut해서 정상적인
  // 느린 조회까지 끊었다. 45초로 늘리되, 그래도 넘기면 원인을 명확히 알려줘서 Gemini가
  // 기간을 좁혀 재시도하도록 유도한다(자체 시행착오 루프와 연동).
  let res: Response;
  try {
    res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    }, 45000);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`조회가 45초를 넘겨 중단됐습니다 — 기간(start_date~end_date)이 너무 넓을 수 있습니다. 기간을 좁혀서 다시 시도하거나, 여러 구간으로 나눠 조회하세요.`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
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

// 재고 트래킹(0021) — 완제품(마카롱 등) 통 단위 재고. 재료(레시피 원가)와 무관, 별개 기능.
async function findStockItems(query: string): Promise<any[]> {
  const params = new URLSearchParams({ select: "id,name,location_id,container_label" });
  params.set("name", `ilike.*${query}*`);
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/stock_items?${params}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  }, 10000);
  if (!res.ok) throw new Error(`stock_items lookup failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function insertStockEvent(stockItemId: number, eventType: string, containers: number, createdBy: string) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/stock_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify([{ stock_item_id: stockItemId, event_type: eventType, container_count: containers, created_by: createdBy }]),
  }, 10000);
  if (!res.ok) throw new Error(`stock_events insert failed: ${res.status} ${await res.text()}`);
}

async function handleStock(itemQuery: string, containers: number, eventType: string, createdBy: string, token: string) {
  try {
    const matches = await findStockItems(itemQuery);
    if (matches.length === 0) {
      await editFollowup(
        token,
        `"${itemQuery}"에 해당하는 재고 품목을 못 찾았습니다. 이름을 확인해주세요 — 새 품목이면 먼저 등록이 필요합니다(오너와 대화로 설정).`,
      );
      return;
    }
    if (matches.length > 1) {
      const names = matches.map((m: any) => `- ${m.name}`).join("\n");
      await editFollowup(token, `"${itemQuery}"에 여러 품목이 걸립니다. 더 정확히 말씀해주세요:\n${names}`);
      return;
    }
    const item = matches[0];
    await insertStockEvent(item.id, eventType, containers, createdBy);
    const today = reginaTodayStr();
    const overview = await rpc("analytics_dispatch", {
      p_analysis: "stock_status",
      p_start_date: today,
      p_end_date: today,
      p_location_id: item.location_id,
      p_limit: 50,
      p_compare_start: null,
      p_compare_end: null,
      p_item_name: null,
    });
    const status = (overview?.data ?? []).find((s: any) => s.name === item.name);
    const label = eventType === "count" ? "카운트 기록" : "생산 추가";
    const unit = item.container_label ?? "통";
    let msg = `${item.name} ${label} 완료 (${containers}${unit}).`;
    if (status) {
      msg += `\n현재 추정: ${status.estimated_containers}${unit}(${status.estimated_units}개) · 상태: ${status.status}`;
      if (status.days_left !== null && status.days_left !== undefined) msg += ` · 약 ${status.days_left}일분`;
    }
    await editFollowup(token, msg);
  } catch (err) {
    console.error(err);
    await editFollowup(token, `재고 기록 중 오류: ${String(err).slice(0, 300)}`);
  }
}

// 관리용 — Discord 슬래시 명령어 (재)등록. Discord 서명 검증 대상이 아니라 SYNC_SHARED_SECRET로
// 보호한다. PUT은 목록 전체를 덮어쓰므로 기존 명령어(ask)도 항상 같이 포함해야 한다 —
// 빠뜨리면 그 명령어가 삭제된다.
async function registerSlashCommands() {
  const commands = [
    {
      name: "ask",
      description: "매출·소셜·광고 데이터에 대해 자연어로 질문합니다",
      options: [{ name: "question", description: "질문 내용", type: 3, required: true }],
    },
    {
      name: "stock",
      description: "완제품 재고 기록 (카운트 또는 방금 만든 것 추가)",
      options: [
        { name: "item", description: "품목명 (예: 마카롱 피스타치오)", type: 3, required: true },
        { name: "containers", description: "통 개수 (예: 1.5)", type: 10, required: true },
        {
          name: "type",
          description: "count=지금 남은 걸 세서 기록 / production=방금 만든 것 추가",
          type: 3,
          required: true,
          choices: [
            { name: "카운트 (지금 남은 걸 셈)", value: "count" },
            { name: "생산 (방금 만든 것 추가)", value: "production" },
          ],
        },
      ],
    },
  ];
  const res = await fetchWithTimeout(
    `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    },
    15000,
  );
  if (!res.ok) throw new Error(`command registration failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// query_data 도구 호출 1건을 실행한다. item_sales가 0건이면 modifier_sales로 자동 재시도하는
// 안전장치는 그대로 유지 — Gemini가 이 실수를 여전히 종종 하기 때문(프롬프트로는 완전히 못 막음).
async function executeQueryData(args: any): Promise<any> {
  const analysis = String(args.analysis ?? "");
  if (!ALLOWED_ANALYSIS.includes(analysis)) {
    return { error: `"${analysis}"는 지원하지 않는 analysis다. 허용된 값: ${ALLOWED_ANALYSIS.join(", ")}` };
  }
  const call = (a: string, extra: Record<string, unknown> = {}) =>
    rpc("analytics_dispatch", {
      p_analysis: a,
      p_start_date: args.start_date,
      p_end_date: args.end_date,
      p_location_id: args.location_id ?? null,
      p_limit: args.limit ?? 10,
      p_compare_start: args.compare_start ?? null,
      p_compare_end: args.compare_end ?? null,
      p_item_name: args.item_name ?? null,
      ...extra,
    });

  let result = await call(analysis);
  if (analysis === "item_sales" && (result?.data?.total_quantity ?? 0) === 0 && args.item_name) {
    const retry = await call("modifier_sales");
    if ((retry?.data?.total_quantity ?? 0) > 0) result = retry;
  }
  return result;
}

const MAX_TOOL_CALLS = 8;

async function handleAsk(question: string, token: string) {
  try {
    const today = reginaTodayStr();
    const messages: any[] = [
      { role: "system", content: agentSystemPrompt(today) },
      { role: "user", content: question },
    ];
    const usedAnalyses = new Set<string>();
    let finalText: string | null = null;

    for (let i = 0; i < MAX_TOOL_CALLS; i++) {
      const isLastAttempt = i === MAX_TOOL_CALLS - 1;
      // gpt-5.6-luna는 도구(tools)를 넘길 때 reasoning_effort를 명시적으로 "none"으로 안 두면
      // /v1/chat/completions가 400을 낸다("Function tools with reasoning_effort are not
      // supported... use /v1/responses or set reasoning_effort to 'none'", 실제 확인함,
      // 2026-09-09). 도구 없는 최종 답변 턴에도 동일하게 둬서 지연시간을 낮춘다 — 이 모델은
      // 저비용/저지연 용도라 별도 reasoning 단계 없이도 프롬프트 규칙만으로 충분하다.
      const data = await callOpenAIRaw({
        messages,
        reasoning_effort: "none",
        tools: isLastAttempt ? undefined : queryDataTool(),
      });
      const message = data.choices?.[0]?.message;
      const toolCalls: any[] = message?.tool_calls ?? [];

      if (toolCalls.length === 0) {
        finalText = (message?.content ?? "").trim() || null;
        break;
      }

      // OpenAI는 assistant 메시지(tool_calls 포함)를 그대로 대화 기록에 추가하고, 각 tool_call마다
      // role:"tool" + 그 tool_call_id를 짝지어 응답해야 한다(표준 형식 — Gemini 때 겪은 role 이름/
      // thought_signature 같은 특수 처리가 필요 없다).
      messages.push(message);

      for (const tc of toolCalls) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        if (args.analysis) usedAnalyses.add(String(args.analysis));

        // 조회가 실패해도(잘못된 파라미터, 유효성 검사 실패 등) 대화를 바로 끊지 않는다 — 실패
        // 이유를 LLM에게 그대로 보여주면 스스로 파라미터를 고쳐서 재시도할 수 있다(예: 날짜
        // 범위가 너무 김, item_name 빠뜨림). 사람 개입 없이 대화 안에서 자체 시행착오.
        let toolResult: any;
        try {
          toolResult = await executeQueryData(args);
        } catch (err) {
          toolResult = { error: String(err).slice(0, 500) };
        }

        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
      }
    }

    if (!finalText) {
      finalText = "질문이 너무 복잡해서 정해진 횟수 안에 다 조회하지 못했습니다. 좀 더 좁혀서 다시 물어봐 주세요.";
    }

    const tag = usedAnalyses.size > 0 ? `\n\n-# ${[...usedAnalyses].join(", ")}` : "";
    await editFollowup(token, `${finalText}${tag}`);
  } catch (err) {
    console.error(err);
    await editFollowup(token, `조회 중 오류가 발생했습니다: ${String(err).slice(0, 300)}`);
  }
}

Deno.serve(async (req) => {
  // 관리용: 슬래시 명령어 (재)등록. Discord 서명 검증 대상이 아니라서 먼저 분기한다.
  if (req.method === "POST" && req.headers.get("x-sync-secret") === SYNC_SHARED_SECRET) {
    try {
      const result = await registerSlashCommands();
      return new Response(JSON.stringify({ status: "success", result }), { headers: { "content-type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: String(err) }), { status: 500 });
    }
  }

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

    if (interaction.data?.name === "stock") {
      const opts = interaction.data.options ?? [];
      const itemQuery = opts.find((o: any) => o.name === "item")?.value ?? "";
      const containers = Number(opts.find((o: any) => o.name === "containers")?.value ?? 0);
      const eventType = opts.find((o: any) => o.name === "type")?.value ?? "count";
      const createdBy = interaction.member?.user?.username ?? interaction.user?.username ?? "unknown";

      const claim = await rpc("claim_discord_message", { p_message_id: `interaction:${interaction.id}` });
      if (claim?.claimed) {
        // @ts-ignore — Supabase Edge Runtime 전역
        EdgeRuntime.waitUntil(handleStock(itemQuery, containers, eventType, createdBy, interaction.token));
      }

      return new Response(JSON.stringify({ type: 5 }), { headers: { "content-type": "application/json" } }); // DEFERRED
    }
  }

  return new Response(JSON.stringify({ type: 4, data: { content: "지원하지 않는 명령입니다." } }), {
    headers: { "content-type": "application/json" },
  });
});
