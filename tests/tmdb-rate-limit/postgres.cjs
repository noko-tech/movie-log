// Uses ONLY a new temporary PostgreSQL cluster and loopback HTTP servers.
// Required: MOVIE_LOG_TEST_PG_BIN, MOVIE_LOG_TEST_POSTGREST, MOVIE_LOG_TEST_DEPS.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const net = require("node:net"),
  http = require("node:http"),
  crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process"),
  assert = require("node:assert/strict");
const dependency = (name) =>
  require(
    require.resolve(name, {
      paths: [process.env.MOVIE_LOG_TEST_DEPS || __dirname],
    }),
  );
const { Pool } = dependency("pg"),
  { createClient } = dependency("@supabase/supabase-js");
const root = path.resolve(__dirname, "../.."),
  work = fs.mkdtempSync(path.join(os.tmpdir(), "movie-log-rate-pg-"));
const pgBin = process.env.MOVIE_LOG_TEST_PG_BIN,
  postgrestBin = process.env.MOVIE_LOG_TEST_POSTGREST;
assert(
  pgBin && postgrestBin,
  "Local PostgreSQL and PostgREST binaries are required; no remote DB URL is accepted.",
);
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const secret = crypto.randomBytes(48).toString("base64url"); // Ephemeral local JWT signer; never printed/written.
const sign = (role, sub) => {
  const parts = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        role,
        ...(sub ? { sub } : {}),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url"),
  ];
  const body = parts.join(".");
  return body + "." +
    crypto.createHmac("sha256", secret).update(body).digest("base64url");
};
const tokens = {
  service_role: sign("service_role"),
  authenticated: sign("authenticated", A),
  anon: sign("anon"),
};
const testSecret = "sb_secret_LOCAL_TEST_ONLY";
const verifyUser = (token) => {
  try {
    const [a, b, c] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(a + "." + b)
      .digest();
    const actual = Buffer.from(c, "base64url");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) return null;
    const claims = JSON.parse(Buffer.from(b, "base64url"));
    return claims.role === "authenticated" && claims.exp > Date.now() / 1000 &&
        claims.sub
      ? claims
      : null;
  } catch {
    return null;
  }
};
const results = [];
let pool,
  migrationPool,
  cliPool,
  rest,
  gateway,
  started = false,
  restPort,
  admin,
  localUrl;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
function pg(command, args) {
  const r = spawnSync(path.join(pgBin, command), args, {
    encoding: "utf8",
    env: { ...process.env, DYLD_LIBRARY_PATH: path.join(pgBin, "../lib") },
  });
  assert.equal(
    r.status,
    0,
    `${command} failed; inspect ${work} (credentials are not printed)`,
  );
}
const sql = (text, values) => pool.query(text, values);
const migrationSource = fs.readFileSync(
  path.join(root, "supabase/migrations/20261024000100_tmdb_rate_limit.sql"),
  "utf8",
);
const migrate = (text) => migrationPool.query(text);
const rollbackSource = `BEGIN;
  SET LOCAL ROLE postgres;
  DROP FUNCTION public.consume_tmdb_rate_limit(uuid);
  GRANT tmdb_rate_limiter_owner TO postgres WITH SET TRUE, INHERIT FALSE;
  SET LOCAL ROLE tmdb_rate_limiter_owner;
  DROP FUNCTION tmdb_rate_limit_private.consume_internal(uuid);
  DROP TABLE tmdb_rate_limit_private.events;
  DROP TABLE tmdb_rate_limit_private.settings;
  DROP SCHEMA tmdb_rate_limit_private;
  SET LOCAL ROLE postgres;
  REVOKE tmdb_rate_limiter_owner FROM postgres;
  DROP ROLE tmdb_rate_limiter_owner;
  COMMIT;`;
const test = async (name, fn) => {
  await fn();
  results.push({ name, result: "PASS" });
  console.log("PASS", name);
};
const reset = async () => {
  await sql(
    "TRUNCATE tmdb_rate_limit_private.events; UPDATE tmdb_rate_limit_private.settings SET user_per_minute=60, global_per_minute=300, user_per_10_seconds=10",
  );
};
const seed = async (user, count, age) =>
  sql(
    "INSERT INTO tmdb_rate_limit_private.events (user_id,happened_at) SELECT $1::uuid, clock_timestamp()-$3::double precision*interval '1 second' FROM generate_series(1,$2::integer)",
    [user, count, age],
  );
const consume = async (user = A) => {
  const { data, error } = await admin.rpc("consume_tmdb_rate_limit", {
    p_user_id: user,
  });
  assert(!error, "service RPC should succeed");
  assert.equal(typeof data.allowed, "boolean");
  return data;
};
const raw = async (
  role,
  body = { p_user_id: A },
  endpoint = "/rpc/consume_tmdb_rate_limit",
  headers = {},
) => {
  return fetch(`http://127.0.0.1:${restPort}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
};
const existingSnapshot = async () =>
  (await sql(
    `SELECT 'table' AS kind, c.relname AS name, c.relacl::text AS acl, c.relrowsecurity::text AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='movie_logs'
 UNION ALL SELECT 'function',p.proname,p.proacl::text,pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('create_movie_log_with_series_order','update_movie_log_with_series_order','delete_movie_log_with_series_order','restore_movie_logs_from_backup')
 UNION ALL SELECT 'policy',policyname,roles::text,coalesce(qual,'')||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename='movie_logs' ORDER BY kind,name`,
  )).rows;
(async () => {
  const pgPort = await freePort();
  restPort = await freePort();
  pg("initdb", [
    "-D",
    path.join(work, "data"),
    "-U",
    "supabase_admin",
    "-A",
    "trust",
    "--locale=C",
    "--encoding=UTF8",
  ]);
  pg("pg_ctl", [
    "-D",
    path.join(work, "data"),
    "-l",
    path.join(work, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${pgPort} -k ${work}`,
    "-w",
    "start",
  ]);
  started = true;
  pool = new Pool({
    host: "127.0.0.1",
    port: pgPort,
    user: "supabase_admin",
    database: "postgres",
    max: 25,
  });
  await sql(
    `CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT CREATE ON DATABASE postgres TO postgres;
    GRANT USAGE, CREATE ON SCHEMA public TO postgres;
    CREATE ROLE cli_login_postgres LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT postgres TO cli_login_postgres WITH SET TRUE, INHERIT FALSE;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO authenticator;
    CREATE TABLE public.movie_logs(id integer PRIMARY KEY, user_id uuid, title text); ALTER TABLE public.movie_logs ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.movie_logs TO authenticated,service_role;
    CREATE POLICY own_movies ON public.movie_logs TO authenticated USING (user_id::text=current_setting('request.jwt.claims',true)::jsonb->>'sub') WITH CHECK (user_id::text=current_setting('request.jwt.claims',true)::jsonb->>'sub');
    INSERT INTO public.movie_logs VALUES (1,'${A}','MOCK_EXISTING_MOVIE');
    CREATE FUNCTION public.create_movie_log_with_series_order() RETURNS integer LANGUAGE sql AS 'SELECT 1';
    CREATE FUNCTION public.update_movie_log_with_series_order() RETURNS integer LANGUAGE sql AS 'SELECT 2';
    CREATE FUNCTION public.delete_movie_log_with_series_order() RETURNS integer LANGUAGE sql AS 'SELECT 3';
    CREATE FUNCTION public.restore_movie_logs_from_backup() RETURNS integer LANGUAGE sql AS 'SELECT 4';
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;`,
  );
  // Genuine non-superuser connections, NOT SET ROLE inside a superuser session.
  migrationPool = new Pool({
    host: "127.0.0.1",
    port: pgPort,
    user: "postgres",
    database: "postgres",
    max: 1,
  });
  cliPool = new Pool({
    host: "127.0.0.1",
    port: pgPort,
    user: "cli_login_postgres",
    database: "postgres",
    max: 1,
  });
  const baseline = await existingSnapshot();
  await test("migration-session-is-actually-non-superuser", async () => {
    const r = (await migrate(
      "SELECT session_user,current_user,rolsuper,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )).rows[0];
    assert.equal(r.session_user, "postgres");
    assert.equal(r.current_user, "postgres");
    assert(!r.rolsuper && !r.rolinherit && !r.rolbypassrls && r.rolcreaterole);
  });
  await test("migration-succeeds-as-non-superuser-postgres", async () => {
    await migrate(migrationSource);
  });
  await test("migration-keeps-existing-movie-table-policy-four-RPCs", async () => {
    assert.deepEqual(await existingSnapshot(), baseline);
    assert.equal(
      (await sql("SELECT title FROM public.movie_logs")).rows[0].title,
      "MOCK_EXISTING_MOVIE",
    );
  });
  rest = spawn(postgrestBin, [], {
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: path.join(pgBin, "../lib"),
      PGRST_DB_URI: `postgresql://authenticator@127.0.0.1:${pgPort}/postgres`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: secret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(restPort),
      PGRST_LOG_LEVEL: "crit",
    },
    stdio: [
      "ignore",
      fs.openSync(path.join(work, "postgrest.log"), "a"),
      fs.openSync(path.join(work, "postgrest.log"), "a"),
    ],
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${restPort}/`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(ready, "local PostgREST boot");
  // Emulates ONLY the hosted API-key-to-role mapping. Actual RPC routing, JWT
  // verification, ACLs and SQL transactions below are real PostgREST/Postgres.
  gateway = http.createServer(async (req, res) => {
    try {
      if (req.url === "/auth/v1/user") {
        const user = verifyUser(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        );
        res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify(
            user
              ? { id: user.sub, role: "authenticated", is_anonymous: false }
              : { msg: "MOCK_INVALID_JWT" },
          ),
        );
      }
      if (!req.url.startsWith("/rest/v1/")) {
        res.writeHead(404);
        return res.end();
      }
      const headers = { ...req.headers };
      delete headers.host;
      if (
        headers.apikey !== testSecret ||
        headers.authorization !== `Bearer ${testSecret}`
      ) {
        res.writeHead(401);
        return res.end("{}");
      }
      headers.authorization = `Bearer ${tokens.service_role}`;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const r = await fetch(
        `http://127.0.0.1:${restPort}${req.url.slice("/rest/v1".length)}`,
        { method: req.method, headers, body: Buffer.concat(chunks) },
      );
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(await r.text());
    } catch {
      res.writeHead(503);
      res.end("{}");
    }
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  localUrl = `http://127.0.0.1:${gateway.address().port}`;
  admin = createClient(localUrl, testSecret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  await test("real-SDK-public-RPC-through-PostgREST", async () => {
    await reset();
    assert.deepEqual(await consume(), {
      allowed: true,
      retry_after_seconds: 0,
    });
  });
  for (const role of [null, "anon", "authenticated"]) {
    await test("RPC-execute-denied-" + (role || "no-token"), async () => {
      await reset();
      const r = await raw(role);
      assert([401, 403, 404].includes(r.status));
      assert.equal(
        (await sql(
          "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
        )).rows[0].n,
        0,
      );
    });
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (
      const operation of ["SELECT *", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]
    ) {
      await test("direct-table-denied-" + role + "-" + operation, async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(`SET LOCAL ROLE ${role}`);
          const query = operation === "SELECT *"
            ? "SELECT * FROM tmdb_rate_limit_private.events"
            : operation === "INSERT"
            ? `INSERT INTO tmdb_rate_limit_private.events(user_id) VALUES('${A}')`
            : operation === "UPDATE"
            ? `UPDATE tmdb_rate_limit_private.events SET user_id='${B}'`
            : operation === "DELETE"
            ? "DELETE FROM tmdb_rate_limit_private.events"
            : "TRUNCATE tmdb_rate_limit_private.events";
          await assert.rejects(c.query(query), (e) => e.code === "42501");
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      });
    }
  }
  await test("private-schema-not-exposed-in-Data-API", async () => {
    const r = await raw("service_role", {}, "/events", {
      "Content-Profile": "tmdb_rate_limit_private",
    });
    assert.equal(r.status, 406);
  });
  await test("internal-function-has-no-direct-Data-API-endpoint", async () => {
    assert.equal(
      (await raw("service_role", { p_user_id: A }, "/rpc/consume_internal", {
        "Content-Profile": "tmdb_rate_limit_private",
      })).status,
      406,
    );
    assert.equal(
      (await raw("service_role", { p_user_id: A }, "/rpc/consume_internal"))
        .status,
      404,
    );
  });
  await test("restricted-owner-and-fixed-search-path", async () => {
    const r = (await sql(
      "SELECT p.prosecdef,p.proconfig,r.rolname,r.rolcanlogin,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='tmdb_rate_limit_private.consume_internal(uuid)'::regprocedure",
    )).rows[0];
    assert(r.prosecdef);
    assert.equal(r.rolname, "tmdb_rate_limiter_owner");
    assert(!r.rolcanlogin && !r.rolsuper && !r.rolbypassrls);
    assert(r.proconfig.includes('search_path=""'));
    assert(r.proconfig.includes("lock_timeout=500ms"));
    assert.equal(
      (await sql(
        "SELECT has_table_privilege('tmdb_rate_limiter_owner','public.movie_logs','SELECT') AS yes",
      )).rows[0].yes,
      false,
    );
    assert.equal(
      (await sql(
        "SELECT has_schema_privilege('tmdb_rate_limiter_owner','public','CREATE') AS yes",
      )).rows[0].yes,
      false,
    );
  });
  await test("public-RPC-is-invoker-owned-by-migration-admin", async () => {
    const r = (await sql(
      "SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.consume_tmdb_rate_limit(uuid)'::regprocedure",
    )).rows[0];
    assert.equal(r.prosecdef, false);
    assert.equal(r.rolname, "postgres");
    assert(r.proconfig.includes('search_path=""'));
  });
  const assertNoTemporaryPrivileges = async () => {
    const r = (await migrate(
      "SELECT pg_has_role('postgres','tmdb_rate_limiter_owner','SET') AS can_set, pg_has_role('postgres','tmdb_rate_limiter_owner','USAGE') AS can_inherit",
    )).rows[0];
    assert.equal(r.can_set, false);
    assert.equal(r.can_inherit, false);
    const members = (await sql(
      "SELECT m.admin_option,m.set_option,m.inherit_option,g.rolname AS grantor,u.rolname AS member FROM pg_auth_members m JOIN pg_roles t ON t.oid=m.roleid JOIN pg_roles g ON g.oid=m.grantor JOIN pg_roles u ON u.oid=m.member WHERE t.rolname='tmdb_rate_limiter_owner'",
    )).rows;
    assert.deepEqual(members, [{
      admin_option: true,
      set_option: false,
      inherit_option: false,
      grantor: "supabase_admin",
      member: "postgres",
    }]);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='public' AND a.grantee='tmdb_rate_limiter_owner'::regrole",
      )).rows[0].n,
      0,
    );
  };
  await test(
    "only-bootstrap-admin-membership-remains-no-SET-INHERIT-or-public-grant",
    assertNoTemporaryPrivileges,
  );
  for (const role of ["anon", "authenticated", "service_role"]) {
    await test("private-owner-SET-ROLE-denied-" + role, async () => {
      assert.equal(
        (await sql(
          "SELECT pg_has_role($1,'tmdb_rate_limiter_owner','SET') AS yes",
          [role],
        )).rows[0].yes,
        false,
      );
    });
  }
  await test("service-role-only-has-private-USAGE-and-function-EXECUTE", async () => {
    const r = (await sql(
      "SELECT has_schema_privilege('service_role','tmdb_rate_limit_private','USAGE') AS usage,has_schema_privilege('service_role','tmdb_rate_limit_private','CREATE') AS create,has_function_privilege('service_role','tmdb_rate_limit_private.consume_internal(uuid)','EXECUTE') AS execute",
    )).rows[0];
    assert.deepEqual(r, { usage: true, create: false, execute: true });
  });
  for (const role of ["anon", "authenticated"]) {
    await test("internal-SQL-execute-denied-" + role, async () => {
      const permissions = (await sql(
        "SELECT has_schema_privilege($1,'tmdb_rate_limit_private','USAGE') AS usage,has_function_privilege($1,'tmdb_rate_limit_private.consume_internal(uuid)','EXECUTE') AS execute,has_function_privilege($1,'public.consume_tmdb_rate_limit(uuid)','EXECUTE') AS public_execute",
        [role],
      )).rows[0];
      assert.deepEqual(permissions, {
        usage: false,
        execute: false,
        public_execute: false,
      });
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(
          c.query("SELECT tmdb_rate_limit_private.consume_internal($1)", [A]),
          (e) => e.code === "42501",
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  }
  await test("accidental-wrapper-grant-still-does-not-authorize-private-function", async () => {
    await sql(
      "GRANT EXECUTE ON FUNCTION public.consume_tmdb_rate_limit(uuid) TO authenticated",
    );
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await assert.rejects(
        c.query("SELECT public.consume_tmdb_rate_limit($1)", [A]),
        (e) => e.code === "42501",
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await sql(
        "REVOKE EXECUTE ON FUNCTION public.consume_tmdb_rate_limit(uuid) FROM authenticated",
      );
    }
  });
  await test("actual-default-settings", async () => {
    const r =
      (await sql("SELECT * FROM tmdb_rate_limit_private.settings")).rows[0];
    assert.deepEqual(r, {
      singleton: true,
      user_per_minute: 60,
      global_per_minute: 300,
      user_per_10_seconds: 10,
    });
  });
  await test("user-60-per-60-seconds", async () => {
    await reset();
    await seed(A, 60, 20);
    const r = await consume();
    assert(
      !r.allowed && r.retry_after_seconds >= 39 && r.retry_after_seconds <= 40,
    );
  });
  await test("global-300-per-60-seconds", async () => {
    await reset();
    await seed(B, 300, 20);
    const r = await consume();
    assert(
      !r.allowed && r.retry_after_seconds >= 39 && r.retry_after_seconds <= 40,
    );
  });
  await test("user-10-per-10-seconds", async () => {
    await reset();
    for (let i = 0; i < 10; i++) assert((await consume()).allowed);
    const r = await consume();
    assert(
      !r.allowed && r.retry_after_seconds >= 9 && r.retry_after_seconds <= 10,
    );
  });
  await test("A-limit-does-not-consume-B-individual-budget", async () => {
    await reset();
    await seed(A, 60, 20);
    assert(!(await consume()).allowed);
    assert((await consume(B)).allowed);
  });
  await test("expired-minute-budget-is-reusable", async () => {
    await reset();
    await seed(A, 60, 61);
    assert((await consume()).allowed);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
      )).rows[0].n,
      1,
    );
  });
  await test("expired-short-budget-is-reusable-with-minute-history", async () => {
    await reset();
    await seed(A, 10, 11);
    assert((await consume()).allowed);
  });
  await test("retry-uses-latest-blocking-window", async () => {
    await reset();
    await seed(A, 50, 59);
    await seed(A, 10, 1);
    const r = await consume();
    assert(
      !r.allowed && r.retry_after_seconds >= 8 && r.retry_after_seconds <= 9,
    );
  });
  await test("admin-can-tune-settings-without-client-limit-parameters", async () => {
    await reset();
    await seed(A, 5, 20);
    await sql("UPDATE tmdb_rate_limit_private.settings SET user_per_minute=3");
    assert(!(await consume()).allowed);
    const r = await raw("service_role", {
      p_user_id: A,
      user_per_minute: 99999,
    });
    assert.equal(r.status, 404);
  });
  await test("denial-does-not-partially-consume-budget", async () => {
    await reset();
    await seed(A, 10, 1);
    assert(!(await consume()).allowed);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
      )).rows[0].n,
      10,
    );
  });
  for (
    const body of [{ p_user_id: null }, { p_user_id: "not-a-uuid" }, {
      p_user_id: A,
      p_now: "2099-01-01",
    }]
  ) {
    await test(
      "invalid-or-untrusted-RPC-arguments-" + results.length,
      async () => {
        await reset();
        const r = await raw("service_role", body);
        assert([400, 404].includes(r.status));
        assert.equal(
          (await sql(
            "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
          )).rows[0].n,
          0,
        );
      },
    );
  }
  await test("parallel-short-limit-exactly-10-of-80", async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 80 }, () => consume()));
    assert.equal(rs.filter((r) => r.allowed).length, 10);
  });
  await test("parallel-minute-limit-exactly-5-of-80", async () => {
    await reset();
    await seed(A, 55, 20);
    const rs = await Promise.all(Array.from({ length: 80 }, () => consume()));
    assert.equal(rs.filter((r) => r.allowed).length, 5);
  });
  await test("parallel-global-limit-exactly-5-of-80", async () => {
    await reset();
    await seed(B, 295, 20);
    const rs = await Promise.all(
      Array.from({ length: 80 }, (_, i) => consume(uid(i + 100))),
    );
    assert.equal(rs.filter((r) => r.allowed).length, 5);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
      )).rows[0].n,
      300,
    );
  });
  await test("parallel-A-and-B-each-get-10", async () => {
    await reset();
    const rs = await Promise.all(
      Array.from({ length: 80 }, (_, i) => consume(i % 2 ? A : B)),
    );
    assert.equal(rs.filter((r, i) => i % 2 && r.allowed).length, 10);
    assert.equal(rs.filter((r, i) => !(i % 2) && r.allowed).length, 10);
  });
  await test("lock-timeout-does-not-write-partial-events", async () => {
    await reset();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT * FROM tmdb_rate_limit_private.settings FOR UPDATE",
      );
      const r = await raw("service_role");
      assert.equal(r.status, 500);
      assert.equal(
        (await sql(
          "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
        )).rows[0].n,
        0,
      );
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  await test("SQL-error-rolls-back-event-admission", async () => {
    await reset();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE service_role");
      await c.query("SELECT public.consume_tmdb_rate_limit($1)", [A]);
      await assert.rejects(c.query("SELECT 1/0"));
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
      )).rows[0].n,
      0,
    );
  });
  await test("migration-collision-fails-without-changing-existing-objects", async () => {
    await reset();
    await assert.rejects(
      migrate(migrationSource),
    );
    await migrate("ROLLBACK");
    assert.deepEqual(await existingSnapshot(), baseline);
  });
  for (const role of ["anon", "authenticated", "service_role"]) {
    await test(
      "settings-and-sequence-direct-access-denied-" + role,
      async () => {
        for (
          const query of [
            "SELECT * FROM tmdb_rate_limit_private.settings",
            "UPDATE tmdb_rate_limit_private.settings SET user_per_minute=9999",
            "SELECT nextval('tmdb_rate_limit_private.events_id_seq')",
          ]
        ) {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query(`SET LOCAL ROLE ${role}`);
            await assert.rejects(c.query(query), (e) => e.code === "42501");
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
        }
      },
    );
  }
  // Complete Function -> actual SDK -> local Auth/key gateway -> real RPC.
  let edgeHandler, tmdbCalls = 0;
  const env = {
    SUPABASE_URL: localUrl,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({
      default: "sb_publishable_LOCAL_TEST",
    }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: testSecret }),
    TMDB_ACCESS_TOKEN: "MOCK_ONLY",
  };
  const isolatedFetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.origin === localUrl) return fetch(input, init);
    assert.equal(
      u.origin,
      "https://api.themoviedb.org",
      "all other network forbidden",
    );
    tmdbCalls++;
    return new Response(
      JSON.stringify(
        u.pathname.includes("/search/")
          ? { results: [] }
          : { id: 101, runtime: 123 },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const vm = require("node:vm"),
    { stripTypeScriptTypes } = require("node:module");
  const edgeSource = fs.readFileSync(
    path.join(root, "supabase/functions/tmdb/index.ts"),
    "utf8",
  ).replace(/^import[^\n]+\n/, "");
  vm.runInNewContext(stripTypeScriptTypes(edgeSource), {
    createClient: (url, key, options = {}) =>
      createClient(url, key, {
        ...options,
        global: { fetch: isolatedFetch, ...options.global },
      }),
    Deno: { env: { get: (k) => env[k] }, serve: (h) => edgeHandler = h },
    fetch: isolatedFetch,
    Request,
    Response,
    Headers,
    AbortController,
    AbortSignal,
    DOMException,
    setTimeout,
    clearTimeout,
    URL,
    console,
  });
  const edge = async (
    payload = { action: "search", query: "mock" },
    jwt = tokens.authenticated,
  ) =>
    edgeHandler(
      new Request("https://edge.test.invalid/tmdb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify(payload),
      }),
    );
  await test("Function-real-RPC-normal-search-and-details", async () => {
    await reset();
    tmdbCalls = 0;
    assert.equal((await edge()).status, 200);
    assert.equal(
      (await edge({ action: "details", mediaType: "movie", id: 101 })).status,
      200,
    );
    assert.equal(tmdbCalls, 2);
  });
  for (const scope of ["minute", "global", "short"]) {
    await test("Function-real-RPC-" + scope + "-429-zero-TMDb", async () => {
      await reset();
      tmdbCalls = 0;
      await seed(
        scope === "global" ? B : A,
        scope === "global" ? 300 : scope === "minute" ? 60 : 10,
        scope === "short" ? 1 : 20,
      );
      const r = await edge({ action: "search", query: "mock", p_user_id: B });
      assert.equal(r.status, 429);
      assert.equal((await r.json()).code, "RATE_LIMITED");
      assert.equal(tmdbCalls, 0);
    });
  }
  await test("Function-rejects-unauthenticated-before-real-RPC", async () => {
    await reset();
    tmdbCalls = 0;
    assert.equal((await edge(undefined, null)).status, 401);
    assert.equal(tmdbCalls, 0);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM tmdb_rate_limit_private.events",
      )).rows[0].n,
      0,
    );
  });
  await test("Function-real-RPC-uses-verified-user-not-payload-id", async () => {
    await reset();
    assert.equal(
      (await edge({ action: "search", query: "mock", p_user_id: B, userId: B }))
        .status,
      200,
    );
    assert.deepEqual(
      (await sql("SELECT DISTINCT user_id FROM tmdb_rate_limit_private.events"))
        .rows.map((r) => r.user_id),
      [A],
    );
  });
  await test("Function-real-DB-lock-failure-is-503-zero-TMDb", async () => {
    await reset();
    tmdbCalls = 0;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT * FROM tmdb_rate_limit_private.settings FOR UPDATE",
      );
      assert.equal((await edge()).status, 503);
      assert.equal(tmdbCalls, 0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  assert.deepEqual(await existingSnapshot(), baseline);
  await test("scoped-rollback-keeps-existing-movie-objects", async () => {
    await migrate(rollbackSource);
    assert.deepEqual(await existingSnapshot(), baseline);
    assert.equal(
      (await sql("SELECT title FROM public.movie_logs")).rows[0].title,
      "MOCK_EXISTING_MOVIE",
    );
  });
  await test("CLI-session-is-non-superuser-without-direct-admin-attributes", async () => {
    const r = (await cliPool.query(
      "SELECT session_user,current_user,rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    )).rows[0];
    assert.equal(r.session_user, "cli_login_postgres");
    assert.equal(r.current_user, "cli_login_postgres");
    assert(!r.rolsuper && !r.rolcreaterole);
  });
  await test("migration-succeeds-through-temporary-CLI-role", async () => {
    await cliPool.query(migrationSource);
    await assertNoTemporaryPrivileges();
    assert.deepEqual(await existingSnapshot(), baseline);
    assert.equal(
      (await cliPool.query("SELECT current_user")).rows[0].current_user,
      "cli_login_postgres",
    );
    assert.equal((await consume()).allowed, true);
  });
  await test("non-superuser-CLI-rollback-and-no-leftover-objects", async () => {
    await cliPool.query(rollbackSource);
    assert.deepEqual(await existingSnapshot(), baseline);
    assert.equal(
      (await sql(
        "SELECT count(*)::int AS n FROM pg_roles WHERE rolname='tmdb_rate_limiter_owner'",
      )).rows[0].n,
      0,
    );
    assert.equal(
      (await cliPool.query("SELECT current_user")).rows[0].current_user,
      "cli_login_postgres",
    );
  });
  console.log(
    "COMPLETE",
    results.length,
    "real PostgreSQL/PostgREST checks; production requests: 0",
  );
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (gateway) await new Promise((r) => gateway.close(r));
  if (rest && rest.exitCode === null) {
    rest.kill("SIGTERM");
    await new Promise((r) => rest.once("exit", r));
  }
  if (pool) await pool.end();
  if (migrationPool) await migrationPool.end();
  if (cliPool) await cliPool.end();
  if (started) {
    pg("pg_ctl", ["-D", path.join(work, "data"), "-m", "fast", "-w", "stop"]);
  }
  fs.writeFileSync(
    path.join(work, "results.json"),
    JSON.stringify(
      {
        tests: results,
        productionRequests: 0,
        scope:
          "Actual PostgreSQL and PostgREST, mock hosted secret-key mapping, existing movie objects are local fixtures.",
      },
      null,
      2,
    ),
  );
  console.log("Artifacts:", work);
});
