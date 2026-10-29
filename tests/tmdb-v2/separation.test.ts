const read = (path: string) => Deno.readTextFileSync(new URL("../../" + path, import.meta.url));
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("v2 is a separate complete copy, not an import of the old entrypoint", () => {
  const old = read("supabase/functions/tmdb/index.ts");
  const next = read("supabase/functions/tmdb-v2/index.ts");
  assert(old === next, "Initial v2 must preserve the reviewed implementation");
  assert(next.includes("Deno.serve("), "Independent entrypoint");
  assert(!/from\s+["'][^"']*\/tmdb\//.test(next), "No runtime dependency on the old Function");
});

Deno.test("only the v2 Function has explicit platform authentication configuration", () => {
  const lines = read("supabase/config.toml").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert(JSON.stringify(lines) === JSON.stringify([
    'project_id = "movie-log"',
    "[functions.tmdb-v2]",
    "enabled = true",
    "verify_jwt = false",
    'entrypoint = "./functions/tmdb-v2/index.ts"',
  ]), "No global/old-Function settings or environment values");
});

Deno.test("authentication precedes the verified-user rate check and TMDb call", () => {
  const source = read("supabase/functions/tmdb-v2/index.ts");
  const auth = source.indexOf("authClient.auth.getUser(jwt)");
  const limit = source.indexOf('rateClient.rpc("consume_tmdb_rate_limit", { p_user_id: verifiedUserId })');
  const upstream = source.indexOf("const tmdbResponse = await fetch(url");
  assert(auth >= 0 && limit > auth && upstream > limit, "Authentication/rate/upstream ordering");
  assert(source.includes("verifiedUserId = user.id"), "Only verified identity is passed");
});

Deno.test("the existing three SQL limits remain the source of rate policy", () => {
  const sql = read("supabase/migrations/20261024000100_tmdb_rate_limit.sql");
  assert(/user_per_minute integer NOT NULL DEFAULT 60\b/.test(sql), "User 60/60s");
  assert(/global_per_minute integer NOT NULL DEFAULT 300\b/.test(sql), "Global 300/60s");
  assert(/user_per_10_seconds integer NOT NULL DEFAULT 10\b/.test(sql), "User 10/10s");
});

Deno.test("the browser still calls tmdb, and Pages excludes both server sources", () => {
  const html = read("index.html");
  assert(/functions\/v1\/tmdb["']/.test(html), "Old browser endpoint must remain unchanged");
  assert(!html.includes("functions/v1/tmdb-v2"), "No frontend switch yet");
  const manifest = JSON.parse(read("deploy/pages-files.json"));
  assert(manifest.files.every((name: string) => !name.startsWith("supabase/") && !name.startsWith("tests/")), "No server/test publication");
});

Deno.test("no literal secrets or credential URLs in the new source/config", () => {
  const source = read("supabase/functions/tmdb-v2/index.ts") + read("supabase/config.toml");
  for (const pattern of [
    /\bsb_secret_[A-Za-z0-9_-]{8,}/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:postgres(?:ql)?|mysql|redis):\/\//,
    /["'][a-fA-F0-9]{32}["']/,
  ]) assert(!pattern.test(source), "No literal credential material");
  assert(source.includes('Deno.env.get("TMDB_ACCESS_TOKEN")'), "Server-only TMDb token");
  assert(source.includes('Deno.env.get("SUPABASE_SECRET_KEYS")'), "Server-only Secret map");
});
