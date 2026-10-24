import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function errorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
  const authController = new AbortController();
  const authTimeout = setTimeout(() => authController.abort(), 10000);
  try {
    const projectUrl = Deno.env.get("SUPABASE_URL");
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

    const tmdbResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });

    const data = await tmdbResponse.json();
    if (!tmdbResponse.ok) {
      // TMDb側の401と、Movie Logユーザーの認証失敗を区別する。
      return errorResponse(tmdbResponse.status === 401 ? 502 : tmdbResponse.status, "TMDB_ERROR", "作品情報を取得できませんでした。");
    }

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
