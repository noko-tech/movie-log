import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function errorResponse(status: number, code: string, message: string, retryAfterSeconds?: number) {
  return new Response(JSON.stringify({ error: message, code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jwt = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i
    .exec(req.headers.get("Authorization") || "")?.[1];
  const unauthorized = () => errorResponse(401, "AUTH_REQUIRED", "ログイン状態を確認してください。");
  if (!jwt) return unauthorized();

  // 固定したプロジェクトのAuthで検証する。リクエスト由来のURL・管理者キーは使わない。
  const projectUrl = Deno.env.get("SUPABASE_URL");
  let verifiedUserId: string;
  const authController = new AbortController();
  const authTimeout = setTimeout(() => authController.abort(), 10000);
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const publicKey = keys?.default || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
    if (!projectUrl || typeof publicKey !== "string" || !publicKey) {
      return errorResponse(503, "AUTH_UNAVAILABLE", "認証を確認できませんでした。時間をおいてお試しください。");
    }
    const authClient = createClient(projectUrl, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: authController.signal }) },
    });
    const { data: { user }, error } = await authClient.auth.getUser(jwt);
    if (error) {
      if (!error.status || error.status === 429 || error.status >= 500) {
        return errorResponse(503, "AUTH_UNAVAILABLE", "認証を確認できませんでした。時間をおいてお試しください。");
      }
      return unauthorized();
    }
    if (!user?.id || user.role !== "authenticated" || user.is_anonymous === true) return unauthorized();
    verifiedUserId = user.id;
  } catch (_) {
    return errorResponse(503, "AUTH_UNAVAILABLE", "認証を確認できませんでした。時間をおいてお試しください。");
  } finally {
    clearTimeout(authTimeout);
  }

  try {
    const token = Deno.env.get("TMDB_ACCESS_TOKEN");

    if (!token) {
      throw new Error("TMDB_ACCESS_TOKEN is not set");
    }

    const body = await req.json();
    const { action } = body;

    let url = "";

    if (action === "search") {
      const query = String(body.query || "").trim();

      if (!query) {
        throw new Error("query is required");
      }

      url =
        `${TMDB_BASE_URL}/search/multi` +
        `?query=${encodeURIComponent(query)}` +
        `&language=ja-JP&include_adult=false`;
    } else if (action === "details") {
      const mediaType = body.mediaType;
      const id = Number(body.id);

      if (!["movie", "tv"].includes(mediaType) || !Number.isInteger(id) || id <= 0) {
        throw new Error("invalid mediaType or id");
      }

      url =
        `${TMDB_BASE_URL}/${mediaType}/${id}` +
        `?language=ja-JP&append_to_response=credits`;
    } else {
      throw new Error("invalid action");
    }

    // 本人確認用clientとは分離し、ユーザーのAuthorizationを引き継がない。
    // このSecretはservice_role権限を持つため、ブラウザ・ログへ絶対に出さない。
    const rateController = new AbortController();
    let rejectTimedOut: (reason: Error) => void = () => {};
    const timedOut = new Promise<never>((_, reject) => { rejectTimedOut = reject; });
    const rateTimeout = setTimeout(() => {
      rateController.abort();
      rejectTimedOut(new Error("rate store timeout"));
    }, 2000);
    try {
      const secrets = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      const secret = secrets?.[Deno.env.get("TMDB_RATE_LIMIT_SECRET_KEY_NAME") || "default"];
      if (!projectUrl || typeof secret !== "string" || !secret.startsWith("sb_secret_")) throw new Error("rate store unavailable");
      const rateClient = createClient(projectUrl, secret, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await Promise.race([
        rateClient.rpc("consume_tmdb_rate_limit", { p_user_id: verifiedUserId }).abortSignal(rateController.signal),
        timedOut,
      ]);
      if (error || !data || typeof data.allowed !== "boolean"
        || !Number.isSafeInteger(data.retry_after_seconds)
        || (data.allowed ? data.retry_after_seconds !== 0 : data.retry_after_seconds < 1 || data.retry_after_seconds > 86400)) {
        throw new Error("invalid rate store response");
      }
      if (!data.allowed) return errorResponse(429, "RATE_LIMITED", "利用上限に達しました。時間をおいてお試しください。", data.retry_after_seconds);
    } catch (_) {
      return errorResponse(503, "RATE_LIMIT_UNAVAILABLE", "作品情報を一時的に取得できません。時間をおいてお試しください。");
    } finally {
      clearTimeout(rateTimeout);
    }

    const tmdbResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });

    if (!tmdbResponse.ok) {
      if (tmdbResponse.status === 429) {
        const header = tmdbResponse.headers.get("Retry-After");
        const seconds = header && /^\d+$/.test(header) ? Number(header)
          : header ? Math.ceil((Date.parse(header) - Date.now()) / 1000) : NaN;
        const retry = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : undefined;
        return errorResponse(429, "TMDB_RATE_LIMITED", "TMDbへのアクセスが集中しています。時間をおいてお試しください。", retry);
      }
      // TMDb側の401と、Movie Logユーザーの認証失敗を区別する。
      return errorResponse(tmdbResponse.status === 401 ? 502 : tmdbResponse.status, "TMDB_ERROR", "作品情報を取得できませんでした。");
    }

    const data = await tmdbResponse.json();
    return new Response(JSON.stringify(data), {
      status: tmdbResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (_) {
    return new Response(
      JSON.stringify({
        error: "作品情報を取得できませんでした。",
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
