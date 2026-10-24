// Only fake keys and ephemeral signed tokens; no production network is allowed.
const enc = new TextEncoder();
const b64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, "").replace(
    /\+/g,
    "-",
  ).replace(/\//g, "_");
const decode = (text) =>
  Uint8Array.from(
    atob(
      text.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - text.length % 4) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
export const uidA = "00000000-0000-4000-8000-000000000001",
  uidB = "00000000-0000-4000-8000-000000000002";
export async function fixture() {
  const keys = {
    HS256: await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
    ES256: await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  };
  const otherKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const issuer = "https://auth.test.invalid/auth/v1";
  const sign = async (sub, options = {}) => {
    const alg = options.alg || "HS256", now = Math.floor(Date.now() / 1000);
    const a = b64(enc.encode(JSON.stringify({ alg, typ: "JWT" }))),
      b = b64(enc.encode(JSON.stringify({
        sub,
        iss: options.issuer || issuer,
        aud: "authenticated",
        role: options.role || "authenticated",
        is_anonymous: !!options.anonymous,
        iat: now,
        exp: now + (options.expired ? -60 : 3600),
      })));
    const input = a + "." + b;
    const key = options.wrongKey
      ? otherKey
      : (alg === "ES256" ? keys.ES256.privateKey : keys.HS256);
    const sig = await crypto.subtle.sign(
      alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "HMAC" },
      key,
      enc.encode(input),
    );
    return input + "." + b64(sig);
  };
  const tokens = {
    A: await sign(uidA),
    B: await sign(uidB),
    ES_A: await sign(uidA, { alg: "ES256" }),
    ES_B: await sign(uidB, { alg: "ES256" }),
    expired: await sign(uidA, { expired: true }),
    foreign: await sign(uidA, { issuer: "https://other.test.invalid/auth/v1" }),
    wrongSignature: await sign(uidA, { wrongKey: true }),
    anonymous: await sign(uidA, { anonymous: true }),
    wrongRole: await sign(uidA, { role: "service_role" }),
  };
  const state = {
    authCalls: 0,
    tmdbCalls: 0,
    mode: "success",
    tmdbStatus: 200,
    lastUser: null,
    requests: [],
    unexpected: 0,
    rpcCalls: 0,
    rpcRequests: [],
    rpcResult: { allowed: true, retry_after_seconds: 0 },
    tmdbRetry: null,
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const verify = async (token) => {
    try {
      const [a, b, c, ...extra] = token.split(".");
      if (extra.length) return null;
      const head = JSON.parse(new TextDecoder().decode(decode(a))),
        body = JSON.parse(new TextDecoder().decode(decode(b)));
      const key = head.alg === "ES256"
        ? keys.ES256.publicKey
        : head.alg === "HS256"
        ? keys.HS256
        : null;
      if (!key) return null;
      const good = await crypto.subtle.verify(
        head.alg === "ES256"
          ? { name: "ECDSA", hash: "SHA-256" }
          : { name: "HMAC" },
        key,
        decode(c),
        enc.encode(a + "." + b),
      );
      return good && body.iss === issuer && body.aud === "authenticated" &&
          body.exp > Date.now() / 1000
        ? body
        : null;
    } catch {
      return null;
    }
  };
  const detail = (id) => ({
    id,
    title: "模擬映画",
    name: "模擬ドラマ",
    overview: "模擬の概要",
    runtime: 111,
    episode_run_time: [24],
    release_date: "2023-01-01",
    first_air_date: "2023-01-01",
    genres: [],
    production_countries: [{ name: "Japan" }],
    origin_country: ["JP"],
    credits: { crew: [], cast: [] },
  });
  const fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      headers = new Headers(
        init.headers || (input instanceof Request ? input.headers : undefined),
      );
    if (
      url.origin === "https://auth.test.invalid" &&
      url.pathname === "/auth/v1/user"
    ) {
      state.authCalls++;
      if (state.mode === "auth-network") throw new Error("MOCK_AUTH_NETWORK");
      if (state.mode === "auth-503") {
        return json({ msg: "MOCK_PRIVATE_AUTH_DETAIL" }, 503);
      }
      if (state.mode === "auth-429") {
        return json({ msg: "MOCK_PRIVATE_AUTH_DETAIL" }, 429);
      }
      if (state.mode === "auth-hang") {
        return new Promise((_, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          } else {init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });}
        });
      }
      if (state.mode === "auth-malformed") {
        return new Response("invalid json", { status: 200 });
      }
      const body = await verify(
        (headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""),
      );
      if (!body) {
        return json({ msg: "MOCK_AUTH_REJECTED", code: "bad_jwt" }, 401);
      }
      state.lastUser = body.sub;
      return json({
        id: body.sub,
        role: body.role,
        aud: body.aud,
        is_anonymous: body.is_anonymous,
      });
    }
    if (
      url.origin === "https://auth.test.invalid" &&
      url.pathname === "/rest/v1/rpc/consume_tmdb_rate_limit"
    ) {
      state.rpcCalls++;
      const body = JSON.parse(init.body);
      state.rpcRequests.push({
        userId: body.p_user_id,
        onlyVerifiedId: Object.keys(body).join(",") === "p_user_id",
        adminHeader: headers.get("apikey") === "sb_secret_TEST_ONLY" &&
          headers.get("Authorization") === "Bearer sb_secret_TEST_ONLY",
      });
      if (!state.rpcRequests.at(-1).adminHeader) {
        return json({ message: "MOCK_PRIVATE_BAD_SECRET" }, 403);
      }
      if (state.mode === "rpc-network") throw Error("MOCK_PRIVATE_RPC_NETWORK");
      if (state.mode === "rpc-error") {
        return json({ message: "MOCK_PRIVATE_SQL_ERROR" }, 500);
      }
      if (state.mode === "rpc-hang") {
        return new Promise((_, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          } else {init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });}
        });
      }
      if (state.mode === "rpc-ignore-abort") {
        return new Promise((resolve) => {
          state.releaseRpc = () =>
            resolve(json({ allowed: true, retry_after_seconds: 0 }));
        });
      }
      if (state.mode === "rpc-json") {
        return new Response("bad json", { status: 200 });
      }
      return json(state.rpcResult);
    }
    if (url.origin === "https://api.themoviedb.org") {
      state.tmdbCalls++;
      if (headers.get("Authorization") !== "Bearer MOCK_TMDB_TOKEN") {
        throw Error("wrong upstream token");
      }
      if (state.mode === "tmdb-429-html") {
        return new Response("<html>MOCK_PRIVATE_UPSTREAM</html>", {
          status: 429,
        });
      }
      if (state.mode === "tmdb-network") {
        throw Error("MOCK_INTERNAL_UPSTREAM_ERROR");
      }
      if (state.mode === "tmdb-json") {
        return new Response("bad json", { status: 200 });
      }
      if (state.tmdbStatus !== 200) {
        return new Response(
          JSON.stringify({ error: "MOCK_PRIVATE_UPSTREAM_DETAIL" }),
          {
            status: state.tmdbStatus,
            headers: {
              "Content-Type": "application/json",
              ...(state.tmdbRetry ? { "Retry-After": state.tmdbRetry } : {}),
            },
          },
        );
      }
      state.requests.push({
        path: url.pathname,
        query: url.searchParams.get("query"),
        credits: url.searchParams.get("append_to_response"),
      });
      return json(
        url.pathname.endsWith("/search/multi")
          ? {
            results: [{
              id: 101,
              media_type: "movie",
              title: "模擬映画",
              release_date: "2023-01-01",
              poster_path: null,
            }],
          }
          : detail(Number(url.pathname.split("/").at(-1))),
      );
    }
    state.unexpected++;
    throw Error("PRODUCTION_NETWORK_FORBIDDEN");
  };
  const reset = () =>
    Object.assign(state, {
      authCalls: 0,
      tmdbCalls: 0,
      mode: "success",
      tmdbStatus: 200,
      lastUser: null,
      requests: [],
      unexpected: 0,
      rpcCalls: 0,
      rpcRequests: [],
      rpcResult: { allowed: true, retry_after_seconds: 0 },
      tmdbRetry: null,
    });
  const env = {
    SUPABASE_URL: "https://auth.test.invalid",
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
      default: "sb_publishable_TEST_ONLY",
    }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_TEST_ONLY" }),
    TMDB_ACCESS_TOKEN: "MOCK_TMDB_TOKEN",
  };
  return { tokens, state, fetch, reset, env };
}
