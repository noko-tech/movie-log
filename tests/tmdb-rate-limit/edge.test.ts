// @ts-nocheck
import { fixture, uidA, uidB } from "./fixtures.mjs";
// Existing invocation defaults to tmdb; a second CLI argument selects tmdb-v2.
const functionName = Deno.args[1] || "tmdb";
if (!["tmdb", "tmdb-v2"].includes(functionName)) throw Error("Invalid test Function target");
const f = await fixture();
const originalGet = Deno.env.get,
  originalServe = Deno.serve,
  originalFetch = globalThis.fetch,
  originalTimer = globalThis.setTimeout;
let handler, fastTimeout = false;
Deno.env.get = (name) => f.env[name];
Deno.serve = (h) => {
  handler = h;
  return {};
};
globalThis.fetch = f.fetch;
globalThis.setTimeout = (fn, delay, ...args) =>
  originalTimer(
    fn,
    fastTimeout && [10000, 2000].includes(delay) ? 20 : delay,
    ...args,
  );
await import(
  new URL(`../../supabase/functions/${functionName}/index.ts`, import.meta.url).href
);
Deno.serve = originalServe;
const reports = [];
const assert = (v, m) => {
  if (!v) throw Error(m);
};
const request = (
  jwt,
  payload = { action: "search", query: "模擬映画" },
  options = {},
) =>
  handler(
    new Request(`https://edge.test.invalid/${functionName}`, {
      method: options.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jwt ? { Authorization: "Bearer " + jwt } : {}),
        ...(options.headers || {}),
      },
      ...(options.method === "OPTIONS"
        ? {}
        : { body: JSON.stringify(payload) }),
    }),
  );
async function test(name, fn) {
  Deno.test(name, async () => {
    f.reset();
    const saved = { ...f.env };
    try {
      await fn();
      assert(f.state.unexpected === 0, "no external requests");
      reports.push({
        name,
        result: "PASS",
        authCalls: f.state.authCalls,
        tmdbCalls: f.state.tmdbCalls,
      });
    } finally {
      for (const k of Object.keys(f.env)) delete f.env[k];
      Object.assign(f.env, saved);
      fastTimeout = false;
    }
  });
}
for (const user of ["A", "B", "ES_A", "ES_B"]) {
  await test("valid-user-" + user, async () => {
    const r = await request(f.tokens[user]);
    assert(r.status === 200, "success");
    assert((await r.json()).results.length === 1, "search shape");
    assert(
      f.state.lastUser === (user.endsWith("A") ? uidA : uidB),
      "verified identity",
    );
    assert(f.state.tmdbCalls === 1, "one upstream");
  });
}
for (
  const [name, jwt, headers] of [
    ["missing", null, {}],
    ["malformed", "not-a-token", {}],
    ["bad-structure", "abc.def.ghi", {}],
    ["expired", f.tokens.expired, {}],
    ["wrong-signature", f.tokens.wrongSignature, {}],
    ["foreign-project", f.tokens.foreign, {}],
    ["apikey-only", null, { apikey: "sb_publishable_TEST_ONLY" }],
    ["publishable-as-bearer", "sb_publishable_TEST_ONLY", {}],
    ["anonymous", f.tokens.anonymous, {}],
    ["wrong-role", f.tokens.wrongRole, {}],
  ]
) {
  await test("reject-" + name, async () => {
    const r = await request(jwt, undefined, { headers });
    assert(r.status === 401, "unauthorized");
    assert(f.state.tmdbCalls === 0, "no TMDb request");
    assert(f.state.rpcCalls === 0, "no RPC before valid authentication");
    const data = await r.json();
    assert(data.code === "AUTH_REQUIRED", "safe error code");
    assert(
      !JSON.stringify(data).includes("MOCK_PRIVATE"),
      "no internal detail",
    );
  });
}
await test("options-remains-public-without-upstream", async () => {
  const r = await request(null, undefined, { method: "OPTIONS" });
  assert(r.status === 200 && (await r.text()) === "ok", "preflight unchanged");
  assert(f.state.authCalls === 0 && f.state.tmdbCalls === 0, "no upstream");
});
for (
  const mode of [
    "auth-network",
    "auth-503",
    "auth-429",
    "auth-hang",
    "auth-malformed",
  ]
) {
  await test("auth-fails-closed-" + mode, async () => {
    f.state.mode = mode;
    fastTimeout = true;
    const r = await request(f.tokens.A);
    assert(r.status === 503, "auth temporarily unavailable");
    assert(f.state.tmdbCalls === 0, "no upstream");
    assert((await r.json()).code === "AUTH_UNAVAILABLE", "safe code");
  });
}
for (const mode of ["missing-key", "legacy-key", "single-key", "invalid-map"]) {
  await test("environment-" + mode, async () => {
    delete f.env.SUPABASE_PUBLISHABLE_KEYS;
    if (mode === "legacy-key") f.env.SUPABASE_ANON_KEY = "MOCK_ANON_KEY";
    if (mode === "single-key") {
      f.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TEST_ONLY";
    }
    if (mode === "invalid-map") f.env.SUPABASE_PUBLISHABLE_KEYS = "{broken";
    const r = await request(f.tokens.A);
    assert(
      r.status === (mode === "legacy-key" || mode === "single-key" ? 200 : 503),
      "config compatibility",
    );
  });
}
for (const mediaType of ["movie", "tv"]) {
  await test("details-" + mediaType, async () => {
    const r = await request(f.tokens.B, {
      action: "details",
      mediaType,
      id: 101,
    });
    assert(r.status === 200 && (await r.json()).id === 101, "details shape");
    assert(f.state.requests[0].credits === "credits", "credits preserved");
  });
}
await test("cors-all-values-unchanged", async () => {
  const r = await request(null);
  assert(
    r.headers.get("Access-Control-Allow-Origin") === "*",
    "origin unchanged",
  );
  assert(
    r.headers.get("Access-Control-Allow-Headers") ===
      "authorization, x-client-info, apikey, content-type",
    "headers unchanged",
  );
  assert(
    r.headers.get("Access-Control-Allow-Methods") === "POST, OPTIONS",
    "methods unchanged",
  );
});
for (const status of [401, 429, 500]) {
  await test("upstream-error-" + status, async () => {
    f.state.tmdbStatus = status;
    const r = await request(f.tokens.A);
    assert(
      r.status === (status === 401 ? 502 : status),
      "upstream distinction",
    );
    const body = await r.text();
    assert(!body.includes("MOCK_PRIVATE"), "no upstream detail leak");
  });
}
for (const mode of ["tmdb-network", "tmdb-json"]) {
  await test("upstream-exception-sanitized-" + mode, async () => {
    f.state.mode = mode;
    const r = await request(f.tokens.A);
    assert(r.status === 400, "existing fallback status");
    assert(!(await r.text()).includes("MOCK_INTERNAL"), "no exception detail");
  });
}
await test("parallel-A-B-no-shared-user-session", async () => {
  const rs = await Promise.all([request(f.tokens.A), request(f.tokens.B)]);
  assert(rs.every((r) => r.status === 200), "both valid");
  assert(f.state.tmdbCalls === 2, "two requests");
});

for (const mode of ["rpc-network", "rpc-error", "rpc-hang", "rpc-json"]) {
  await test("rate-store-fails-closed-" + mode, async () => {
    f.state.mode = mode;
    fastTimeout = true;
    const r = await request(f.tokens.A);
    assert(r.status === 503, "503");
    const data = await r.json();
    assert(data.code === "RATE_LIMIT_UNAVAILABLE", "safe code");
    assert(!JSON.stringify(data).includes("MOCK_PRIVATE"), "safe text");
    assert(f.state.tmdbCalls === 0, "no upstream");
  });
}
for (
  const data of [
    null,
    [],
    {},
    { allowed: "true", retry_after_seconds: 0 },
    { allowed: true, retry_after_seconds: 1 },
    { allowed: false, retry_after_seconds: 0 },
    { allowed: false, retry_after_seconds: -1 },
    { allowed: false, retry_after_seconds: 1.2 },
    { allowed: false, retry_after_seconds: 999999 },
  ]
) {
  await test("invalid-rate-result-" + JSON.stringify(data), async () => {
    f.state.rpcResult = data;
    const r = await request(f.tokens.A);
    assert(r.status === 503, "malformed fails closed");
    assert(f.state.tmdbCalls === 0, "no upstream");
  });
}
await test("own-429-returns-DB-retry-header-and-body", async () => {
  f.state.rpcResult = { allowed: false, retry_after_seconds: 37 };
  const r = await request(f.tokens.A);
  assert(r.status === 429, "limit");
  assert(r.headers.get("Retry-After") === "37", "DB clock retry header");
  const body = await r.json();
  assert(
    body.code === "RATE_LIMITED" && body.retryAfterSeconds === 37,
    "distinct own limit",
  );
  assert(f.state.tmdbCalls === 0, "no upstream");
});
await test("verified-user-id-only-not-client-supplied-id", async () => {
  const r = await request(f.tokens.A, {
    action: "search",
    query: "mock",
    p_user_id: uidB,
    userId: uidB,
    limit: 99999,
  });
  assert(r.status === 200, "valid search");
  assert(
    f.state.rpcRequests.length === 1 &&
      f.state.rpcRequests[0].userId === uidA &&
      f.state.rpcRequests[0].onlyVerifiedId,
    "verified id only",
  );
  assert(f.state.rpcRequests[0].adminHeader, "separate admin credential");
});
await test("user-B-details-uses-verified-B", async () => {
  const r = await request(f.tokens.B, {
    action: "details",
    mediaType: "tv",
    id: 101,
    userId: uidA,
  });
  assert(r.status === 200, "details");
  assert(f.state.rpcRequests[0].userId === uidB, "B only");
});
for (const mode of ["missing", "broken", "public", "wrong"]) {
  await test("secret-configuration-" + mode, async () => {
    if (mode === "missing") {
      delete f.env.SUPABASE_SECRET_KEYS;
    }
    if (mode === "broken") f.env.SUPABASE_SECRET_KEYS = "{bad";
    if (mode === "public") {
      f.env.SUPABASE_SECRET_KEYS = JSON.stringify({
        default: "sb_publishable_TEST_ONLY",
      });
    }
    if (mode === "wrong") {
      f.env.SUPABASE_SECRET_KEYS = JSON.stringify({
        default: "sb_secret_WRONG_TEST",
      });
    }
    const r = await request(f.tokens.A);
    assert(r.status === 503, "fail closed");
    assert(f.state.tmdbCalls === 0, "no upstream");
  });
}
await test("named-server-secret-supported", async () => {
  f.env.SUPABASE_SECRET_KEYS = JSON.stringify({ tmdb: "sb_secret_TEST_ONLY" });
  f.env.TMDB_RATE_LIMIT_SECRET_KEY_NAME = "tmdb";
  assert((await request(f.tokens.A)).status === 200, "named key");
});
await test("upstream-429-is-distinct-and-sanitized", async () => {
  f.state.tmdbStatus = 429;
  f.state.tmdbRetry = "12";
  const r = await request(f.tokens.A);
  assert(
    r.status === 429 && f.state.tmdbCalls === 1,
    "upstream already called",
  );
  const body = await r.json();
  assert(
    body.code === "TMDB_RATE_LIMITED" && body.retryAfterSeconds === 12,
    "distinct code",
  );
  assert(r.headers.get("Retry-After") === "12", "retry");
});
await test("upstream-429-without-retry-does-not-invent-wait", async () => {
  f.state.tmdbStatus = 429;
  f.state.tmdbRetry = "bad header";
  const r = await request(f.tokens.A);
  assert(
    !(await r.json()).retryAfterSeconds && !r.headers.has("Retry-After"),
    "no fake wait",
  );
});
await test("invalid-payload-is-not-admitted", async () => {
  const r = await request(f.tokens.A, {
    action: "details",
    mediaType: "wrong",
    id: 0,
  });
  assert(r.status === 400, "invalid request");
  assert(
    f.state.rpcCalls === 0 && f.state.tmdbCalls === 0,
    "no budget/upstream",
  );
});
await test("RPC-ignores-abort-still-times-out-and-late-result-never-fetches-TMDb", async () => {
  f.state.mode = "rpc-ignore-abort";
  fastTimeout = true;
  const r = await request(f.tokens.A);
  assert(r.status === 503, "bounded deadline");
  assert(f.state.tmdbCalls === 0, "no upstream");
  f.state.releaseRpc();
  await new Promise((r) => originalTimer(r, 0));
  assert(f.state.tmdbCalls === 0, "late admission ignored");
});
await test("upstream-non-JSON-429-still-distinguished", async () => {
  f.state.mode = "tmdb-429-html";
  const r = await request(f.tokens.A);
  assert(r.status === 429, "HTTP status preserved");
  const body = await r.json();
  assert(
    body.code === "TMDB_RATE_LIMITED" &&
      !JSON.stringify(body).includes("MOCK_PRIVATE"),
    "safe fixed error",
  );
});
Deno.test("summary", () => {
  if (Deno.args[0]) {
    Deno.writeTextFileSync(
      Deno.args[0],
      JSON.stringify(
        {
          functionName,
          tests: reports,
          scope:
            "Actual Function and SDK, crypto-verifying mock Auth and mock rate store; runtime networking denied",
        },
        null,
        2,
      ),
    );
  }
});
