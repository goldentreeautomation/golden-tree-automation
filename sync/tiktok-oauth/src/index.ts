// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

interface ReqPayload {
  name: string;
}

console.info("server started");

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    const { name }: ReqPayload = await req.json();

    // Using 'sb_secret_xyz' bypasses RLS — use for privileged operations
    if (ctx.authMode === "secret") {
      return Response.json({
        message: `Hello ${name} admin!`,
      });
    }

    return Response.json({
      message: `Hello ${name}!`,
    });
  }),
};import { createClient } from "jsr:@supabase/supabase-js@2";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing server configuration: " + name);
  return value;
}

async function exchangeToken(body: URLSearchParams) {
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error("TikTok token error: " + JSON.stringify(payload));
  }
  return payload;
}

async function refreshIfNeeded(supabase: any, token: any) {
  const expiresAt = new Date(token.access_expires_at).getTime();
  if (expiresAt > Date.now() + 5 * 60 * 1000) return token;

  const payload = await exchangeToken(new URLSearchParams({
    client_key: env("TIKTOK_CLIENT_KEY"),
    client_secret: env("TIKTOK_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  }));

  const updated = {
    ...token,
    open_id: payload.open_id ?? token.open_id,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? token.refresh_token,
    scope: payload.scope ?? token.scope,
    access_expires_at: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + payload.refresh_expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("tiktok_oauth_tokens")
    .upsert(updated, { onConflict: "account_key" });
  if (error) throw error;
  return updated;
}

async function tiktokJson(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: "Bearer " + accessToken,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code) {
    throw new Error("TikTok API error: " + JSON.stringify(payload));
  }
  return payload;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const route = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const supabase = createClient(
      env("SUPABASE_URL"),
      env("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );

    if (route === "start") {
      const account = url.searchParams.get("account");
      if (account !== "bon" && account !== "cozy") {
        return json({ error: "account must be bon or cozy" }, 400);
      }

      const state = randomState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await supabase.from("tiktok_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const { error } = await supabase.from("tiktok_oauth_states").insert({
        state,
        account_key: account,
        expires_at: expiresAt,
      });
      if (error) throw error;

      const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
      auth.searchParams.set("client_key", env("TIKTOK_CLIENT_KEY"));
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "user.info.basic,user.info.profile,user.info.stats,video.list");
      auth.searchParams.set("redirect_uri", env("TIKTOK_REDIRECT_URI"));
      auth.searchParams.set("state", state);
      return Response.redirect(auth.toString(), 302);
    }

    if (route === "callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "Missing code or state" }, 400);

      const { data: stateRow, error: stateError } = await supabase
        .from("tiktok_oauth_states")
        .select("*")
        .eq("state", state)
        .maybeSingle();
      if (stateError || !stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) {
        return json({ error: "Invalid or expired authorization state" }, 400);
      }

      const payload = await exchangeToken(new URLSearchParams({
        client_key: env("TIKTOK_CLIENT_KEY"),
        client_secret: env("TIKTOK_CLIENT_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: env("TIKTOK_REDIRECT_URI"),
      }));

      const userPayload = await tiktokJson(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count",
        payload.access_token,
      );
      const user = userPayload?.data?.user ?? {};

      const { error: tokenError } = await supabase.from("tiktok_oauth_tokens").upsert({
        account_key: stateRow.account_key,
        open_id: payload.open_id ?? user.open_id,
        display_name: user.display_name ?? null,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        scope: payload.scope,
        access_expires_at: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
        refresh_expires_at: new Date(Date.now() + payload.refresh_expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "account_key" });
      if (tokenError) throw tokenError;

      await supabase.from("tiktok_oauth_states").delete().eq("state", state);
      const label = stateRow.account_key === "bon" ? "Bon Sushi" : "Cozy Haus";
      return new Response(
        "<!doctype html><meta charset=utf-8><title>TikTok connected</title><body style='font-family:system-ui;padding:48px'><h1>✅ " + label + " TikTok 연결 완료</h1><p>이 창을 닫아도 됩니다.</p></body>",
        { headers: htmlHeaders },
      );
    }

    const brokerKey = req.headers.get("x-broker-key");
    if (!brokerKey || brokerKey !== env("TIKTOK_BROKER_KEY")) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (route === "status") {
      const { data, error } = await supabase
        .from("tiktok_oauth_tokens")
        .select("account_key,open_id,display_name,scope,access_expires_at,refresh_expires_at,updated_at")
        .order("account_key");
      if (error) throw error;
      return json({ accounts: data });
    }

    if (route === "sync") {
      const account = url.searchParams.get("account");
      if (account !== "bon" && account !== "cozy") {
        return json({ error: "account must be bon or cozy" }, 400);
      }

      const { data: stored, error } = await supabase
        .from("tiktok_oauth_tokens")
        .select("*")
        .eq("account_key", account)
        .maybeSingle();
      if (error) throw error;
      if (!stored) return json({ error: "TikTok account is not connected" }, 404);

      const token = await refreshIfNeeded(supabase, stored);
      const userPayload = await tiktokJson(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,follower_count,following_count,likes_count,video_count",
        token.access_token,
      );

      const videos: any[] = [];
      let cursor = 0;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 50) {
        const videoPayload = await tiktokJson(
          "https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,duration,cover_image_url,embed_link,create_time,like_count,comment_count,share_count,view_count",
          token.access_token,
          { method: "POST", body: JSON.stringify({ max_count: 20, cursor }) },
        );
        const page = videoPayload?.data?.videos ?? [];
        videos.push(...page);
        hasMore = Boolean(videoPayload?.data?.has_more);
        cursor = videoPayload?.data?.cursor ?? cursor;
        pages += 1;
        if (!page.length) break;
      }

      return json({
        platform: "tiktok",
        account_key: account,
        fetched_at: new Date().toISOString(),
        user: userPayload?.data?.user ?? null,
        videos,
        video_count_fetched: videos.length,
      });
    }

    return json({ service: "golden-tree-tiktok", routes: ["start", "callback", "status", "sync"] });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
