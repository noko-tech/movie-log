const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

    return new Response(JSON.stringify(data), {
      status: tmdbResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
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