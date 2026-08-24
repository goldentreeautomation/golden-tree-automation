// Golden Tree — Meta(Instagram·Facebook 광고) 동기화 (Phase 5, M2)
//
// 순서: 인스타 포스팅(캡션·미디어) → 포스트별 인게이지먼트(좋아요·댓글·공유·저장·도달) →
// 댓글 원문 → 광고 캠페인 → 캠페인별 일별 광고 성과.
//
// 기존 스키마(레거시 n8n 시절 설계, docs/decisions/0004)를 그대로 쓴다 — social_*_ingest는
// VIEW이고 INSTEAD OF INSERT 트리거가 upsert 처리를 한다. 여기서는 그 뷰에 INSERT만 하면 된다.
// Query Contract 함수(analytics_dispatch의 social_* 케이스)가 이미 이 최종 테이블들을 읽는다.
//
// idempotent: 뷰 트리거가 (platform, id) 또는 (platform, id, date) 기준 upsert라 재실행해도
// 안전하다 (불변 규칙 #6).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const SYNC_SHARED_SECRET = Deno.env.get("SYNC_SHARED_SECRET")!;
const GRAPH_API = "https://graph.facebook.com/v21.0";
const AD_ACCOUNT_ID = "act_545127089932186";

const ACCOUNTS = [
  { platform: "instagram", igId: "17841478338651157", pageId: "963178380207915", businessName: "Bon Sushi Regina", locationKey: "LWEFT8C6SXJ7J" },
  { platform: "instagram", igId: "17841472136242619", pageId: "661485160374126", businessName: "Cozyhaus Regina", locationKey: "L7DA0MBKD2X4P" },
];

async function graphGet(path: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", META_ACCESS_TOKEN);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Graph API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphGetPaginated(path: string, params: Record<string, string>, maxPages = 20) {
  const all: any[] = [];
  let data = await graphGet(path, params);
  all.push(...(data.data ?? []));
  let pages = 1;
  while (data.paging?.next && pages < maxPages) {
    const res = await fetch(data.paging.next);
    if (!res.ok) break;
    data = await res.json();
    all.push(...(data.data ?? []));
    pages++;
  }
  return all;
}

async function ingest(view: string, rows: any[]) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${view}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`ingest ${view} failed: ${res.status} ${await res.text()}`);
  }
}

function insightsMetricsFor(mediaProductType: string) {
  const base = ["likes", "comments", "shares", "saved", "reach", "total_interactions"];
  if (mediaProductType === "REELS") return [...base, "views"];
  return base;
}

async function fetchPostInsights(mediaId: string, mediaProductType: string) {
  try {
    const metrics = insightsMetricsFor(mediaProductType);
    const data = await graphGet(`${mediaId}/insights`, { metric: metrics.join(",") });
    const byName: Record<string, number> = {};
    for (const m of data.data ?? []) byName[m.name] = m.values?.[0]?.value ?? 0;
    return byName;
  } catch (err) {
    console.error(`insights failed for ${mediaId}:`, err);
    return {};
  }
}

async function syncAccountPosts(acc: typeof ACCOUNTS[number], sinceIso: string) {
  await ingest("social_accounts_ingest", [
    {
      platform: acc.platform,
      account_id: acc.igId,
      page_id: acc.pageId,
      business_name: acc.businessName,
      username: acc.businessName,
      location_key: acc.locationKey,
      metadata: {},
      updated_at: new Date().toISOString(),
    },
  ]);

  const sinceTs = Math.floor(new Date(sinceIso).getTime() / 1000);
  const media = await graphGetPaginated(`${acc.igId}/media`, {
    fields: "id,caption,media_type,media_product_type,media_url,permalink,timestamp,like_count,comments_count",
    since: String(sinceTs),
  });

  const capturedDate = new Date().toISOString().slice(0, 10);
  const capturedAt = new Date().toISOString();

  // Edge Function 유휴 타임아웃(150초) 대응 — 게시물이 많으면(전체 백필 등) 순차 처리로는
  // 못 끝낸다. 동시에 여러 게시물을 처리하고, 배치마다 바로 저장해서 중간에 끊겨도 그때까지는
  // 남는다 (idempotent라 재실행하면 이어서 채워진다).
  const CONCURRENCY = 8;
  let totalPosts = 0;
  let totalComments = 0;

  for (let i = 0; i < media.length; i += CONCURRENCY) {
    const batch = media.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (m: any) => {
        const insights = await fetchPostInsights(m.id, m.media_product_type ?? "");
        let comments: any[] = [];
        try {
          comments = await graphGetPaginated(`${m.id}/comments`, {
            fields: "id,text,timestamp,like_count,replies.summary(true)",
          }, 5);
        } catch (err) {
          console.error(`comments failed for ${m.id}:`, err);
        }
        return { m, insights, comments };
      }),
    );

    const postRows = results.map(({ m }) => ({
      platform: acc.platform,
      post_id: m.id,
      account_id: acc.igId,
      caption: m.caption ?? null,
      media_type: m.media_product_type ?? m.media_type,
      media_url: m.media_url ?? null,
      permalink: m.permalink ?? null,
      published_at: m.timestamp,
      product_tags: [],
      category_tags: [],
      raw_data: m,
      updated_at: capturedAt,
    }));
    const metricRows = results.map(({ m, insights }) => ({
      platform: acc.platform,
      post_id: m.id,
      captured_date: capturedDate,
      likes: insights.likes ?? m.like_count ?? 0,
      comments: insights.comments ?? m.comments_count ?? 0,
      shares: insights.shares ?? 0,
      saves: insights.saved ?? 0,
      reach: insights.reach ?? 0,
      impressions: insights.impressions ?? 0,
      views: insights.views ?? 0,
      plays: 0,
      total_interactions: insights.total_interactions ?? 0,
      raw_data: insights,
      captured_at: capturedAt,
    }));
    const commentRows = results.flatMap(({ m, comments }) =>
      comments.map((c: any) => ({
        platform: acc.platform,
        comment_id: c.id,
        post_id: m.id,
        account_id: acc.igId,
        message: c.text ?? null,
        sentiment: null,
        topic_summary: null,
        created_at: c.timestamp,
        like_count: c.like_count ?? 0,
        reply_count: c.replies?.summary?.total_count ?? 0,
        raw_data: c,
        updated_at: capturedAt,
      }))
    );

    await ingest("social_posts_ingest", postRows);
    await ingest("social_post_metrics_ingest", metricRows);
    await ingest("social_comments_ingest", commentRows);
    totalPosts += postRows.length;
    totalComments += commentRows.length;
  }

  return { posts: totalPosts, comments: totalComments };
}

async function syncAds(startDate: string, endDate: string) {
  const campaigns = await graphGetPaginated(`${AD_ACCOUNT_ID}/campaigns`, {
    fields: "id,name,objective,status,start_time,stop_time",
  });
  const campaignRows = campaigns.map((c: any) => ({
    platform: "meta", // 레거시 데이터와 동일한 값으로 맞춤 (platform+campaign_id가 키)
    campaign_id: c.id,
    ad_account_id: AD_ACCOUNT_ID,
    business_name: c.name?.toLowerCase().includes("cozy") ? "Cozyhaus Regina" : c.name?.toLowerCase().includes("bon") ? "Bon Sushi Regina" : null,
    campaign_name: c.name,
    objective: c.objective,
    status: c.status,
    start_time: c.start_time ?? null,
    stop_time: c.stop_time ?? null,
    raw_data: c,
    updated_at: new Date().toISOString(),
  }));
  await ingest("social_ad_campaigns_ingest", campaignRows);

  const insights = await graphGetPaginated(`${AD_ACCOUNT_ID}/insights`, {
    level: "campaign",
    fields: "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,ctr,cpc,cpm",
    time_range: JSON.stringify({ since: startDate, until: endDate }),
    time_increment: "1",
    limit: "200",
  });
  const capturedAt = new Date().toISOString();
  // social_ad_metrics는 social_ad_campaigns(platform,campaign_id)를 참조하는 FK가 있다.
  // Meta의 /campaigns 목록에 왜인지 안 잡히는 캠페인(ARCHIVED 등, 원인 미상)이 있으면
  // 그 캠페인의 지표는 FK 위반으로 전체 배치가 막힌다 — 알려진 캠페인 것만 남기고 스킵.
  const knownCampaignIds = new Set(campaignRows.map((c: any) => c.campaign_id));
  const skipped: string[] = [];
  const metricRows = insights
    .filter((row: any) => {
      const known = knownCampaignIds.has(row.campaign_id);
      if (!known) skipped.push(row.campaign_id);
      return known;
    })
    .map((row: any) => ({
      platform: "meta", // 레거시 데이터와 동일한 값으로 맞춤 (platform+campaign_id가 키)
      campaign_id: row.campaign_id,
      metric_date: row.date_start,
      spend: parseFloat(row.spend ?? "0"),
      impressions: parseInt(row.impressions ?? "0", 10),
      reach: parseInt(row.reach ?? "0", 10),
      clicks: parseInt(row.clicks ?? "0", 10),
      link_clicks: parseInt(row.inline_link_clicks ?? "0", 10),
      conversions: 0,
      purchase_value: 0,
      ctr: parseFloat(row.ctr ?? "0"),
      cpc: parseFloat(row.cpc ?? "0"),
      cpm: parseFloat(row.cpm ?? "0"),
      raw_data: row,
      captured_at: capturedAt,
    }));
  await ingest("social_ad_metrics_ingest", metricRows);
  if (skipped.length > 0) console.error("skipped ad metric rows, campaign not found:", [...new Set(skipped)]);

  return { campaigns: campaignRows.length, ad_metric_rows: metricRows.length, skipped_campaign_ids: [...new Set(skipped)] };
}

async function upsertSyncLog(syncKey: string, status: string, rowCount: number, errorMessage: string | null) {
  await fetch(`${SUPABASE_URL}/rest/v1/social_sync_log?on_conflict=sync_key`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([
      {
        sync_key: syncKey,
        platform: "meta",
        sync_type: syncKey,
        last_success_at: status === "success" ? new Date().toISOString() : undefined,
        status,
        row_count: rowCount,
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      },
    ]),
  });
}

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // 기본값 사용
  }
  const now = new Date();
  const since = body.since ?? new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const adStart = (body.since ?? new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()).slice(0, 10);
  const adEnd = (body.until ?? now.toISOString()).slice(0, 10);

  try {
    const [postResultPairs, adResult] = await Promise.all([
      Promise.all(ACCOUNTS.map(async (acc) => [acc.businessName, await syncAccountPosts(acc, since)] as const)),
      syncAds(adStart, adEnd),
    ]);
    const postResults = Object.fromEntries(postResultPairs);

    await upsertSyncLog("meta_posts", "success", Object.values(postResults).reduce((s: number, r: any) => s + r.posts, 0), null);
    await upsertSyncLog("meta_ads", "success", adResult.ad_metric_rows, null);

    return new Response(JSON.stringify({ status: "success", posts: postResults, ads: adResult }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    await upsertSyncLog("meta_posts", "error", 0, String(err).slice(0, 500));
    return new Response(JSON.stringify({ status: "error", message: String(err) }), { status: 500 });
  }
});
