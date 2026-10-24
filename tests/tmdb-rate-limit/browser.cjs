const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { chromium, webkit } = require(
  require.resolve("playwright", {
    paths: [process.env.MOVIE_LOG_TEST_DEPS || __dirname],
  }),
);
const root = path.resolve(__dirname, "../.."),
  out = process.env.MOVIE_LOG_TEST_OUTPUT;
assert(
  out && process.env.MOVIE_LOG_TEST_TAILWIND,
  "Provide a temporary output directory and local Tailwind bundle",
);
fs.mkdirSync(out, { recursive: true });
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const marker = "      // ===================== データ管理";
const main = source.slice(
  source.indexOf(marker),
  source.indexOf("</script>", source.indexOf(marker)),
);
const auth = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
  (m) => m[1],
).find((s) => s.includes("async function initializeAuth()"));
const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(
  /<link\b[^>]*>/gi,
  "",
).replace("</head>", '<script src="/tailwind.js"></script></head>');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/tailwind.js") {
    res.setHeader("Content-Type", "application/javascript");
    return res.end(fs.readFileSync(process.env.MOVIE_LOG_TEST_TAILWIND));
  }
  if (u.pathname.startsWith("/assets/")) {
    const file = path.resolve(root, "." + decodeURIComponent(u.pathname));
    if (
      !file.startsWith(path.join(root, "assets") + path.sep) ||
      !fs.existsSync(file)
    ) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".svg")
        ? "image/svg+xml"
        : file.endsWith(".webp")
        ? "image/webp"
        : "image/png",
    );
    return res.end(fs.readFileSync(file));
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});
const details = (id = 101) => ({
  id,
  title: `作品${id}`,
  overview: `概要${id}`,
  poster_path: `/${id}.jpg`,
  runtime: id + 10,
  release_date: "2023-01-01",
  production_countries: [{ name: `国${id}` }],
  genres: [{ id: 16, name: "Animation" }],
  credits: {
    crew: [{ job: "Director", name: `監督${id}` }, {
      job: "Writer",
      name: `脚本${id}`,
    }],
    cast: [{ name: `出演${id}` }],
  },
});
let browser, f, edgeHandler;
const results = [];
let blockedExternal = 0;
async function run(engine, viewport) {
  const context = await browser.newContext({
    viewport,
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600,
    serviceWorkers: "block",
  });
  await context.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === "127.0.0.1") return r.continue();
    if (u.hostname === "image.tmdb.org" || u.hostname === "manual.invalid") {
      return r.fulfill({
        contentType: "image/svg+xml",
        body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"/>',
      });
    }
    blockedExternal++;
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() =>
    getComputedStyle(document.body).marginLeft === "0px"
  );
  await page.evaluate(() => {
    window.alerts = [];
    window.alert = (message) => alerts.push(message);
    window.confirm = () => true;
  });
  await page.addScriptTag({ content: main });
  await page.exposeBinding(
    "invokeMockEdge",
    async (_, { headers, payload }) => {
      const response = await edgeHandler(
        new Request("https://edge.test.invalid/tmdb", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        }),
      );
      return { status: response.status, body: await response.text() };
    },
  );
  await page.evaluate(({ tokens, uidA, uidB }) => {
    window.testAuth = {
      user: uidA,
      kind: "A",
      mode: "normal",
      fetchMode: "normal",
      sessionCalls: 0,
      calls: [],
      signOutFails: false,
    };
    window.testTokenMap = tokens;
    window.testUsers = { A: uidA, B: uidB };
    window.alerts = [];
    window.alert = (m) => alerts.push(m);
    window.confirm = () => true;
    const session = () => ({
      user: { id: testAuth.user },
      access_token: testTokenMap[testAuth.kind],
      expires_at: Date.now() / 1000 +
        (testAuth.mode === "expired-meta" ? -1 : 3600),
    });
    window.testGetSession = async () => {
      testAuth.sessionCalls++;
      const s = session();
      if (testAuth.mode === "defer") {
        return new Promise((r) =>
          window.releaseSession = () => r({ data: { session: s }, error: null })
        );
      }
      if (testAuth.mode === "throw") throw Error("MOCK_PRIVATE_SDK_DETAIL");
      if (testAuth.mode === "missing") {
        return { data: { session: null }, error: null };
      }
      if (testAuth.mode === "wrong-user") s.user.id = testUsers.B;
      return { data: { session: s }, error: null };
    };
    const query = () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      order() {
        return this;
      },
      range() {
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: [], count: 0, error: null }).then(
          resolve,
          reject,
        );
      },
      insert() {
        throw Error("WRITE_FORBIDDEN");
      },
      update() {
        throw Error("WRITE_FORBIDDEN");
      },
      delete() {
        throw Error("WRITE_FORBIDDEN");
      },
    });
    window.fakeClient = {
      schema: () => ({ from: query }),
      rpc: () => {
        throw Error("RPC_FORBIDDEN");
      },
      auth: {
        getSession: () => testGetSession(),
        getUser: async () => ({
          data: { user: { id: testAuth.user } },
          error: null,
        }),
        onAuthStateChange: (fn) => {
          window.authCallback = fn;
          return {};
        },
        signOut: async () => {
          if (testAuth.signOutFails) return { error: { status: 500 } };
          testAuth.user = null;
          authCallback("SIGNED_OUT", null);
          return { error: null };
        },
      },
    };
    window.supabase = { createClient: () => fakeClient };
    window.fetch = async (url, options) => {
      if (!url.endsWith("/functions/v1/tmdb")) {
        throw Error("NON_MOCK_FETCH_FORBIDDEN");
      }
      const payload = JSON.parse(options.body);
      testAuth.calls.push({
        action: payload.action,
        correctBearer: options.headers.Authorization ===
          "Bearer " + testTokenMap[testAuth.kind],
        correctApikey: options.headers.apikey === "sb_publishable_TEST_ONLY",
        signal: options.signal,
      });
      if (testAuth.fetchMode === "hold-fetch") {
        return new Promise((resolve, reject) => {
          window.releaseFetch = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                results: [{ id: 101, media_type: "movie", title: "遅い候補" }],
              }),
            });
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      const r = await invokeMockEdge({ headers: options.headers, payload });
      if (testAuth.fetchMode === "hold-body") {
        return {
          ok: r.status < 400,
          status: r.status,
          json: () =>
            new Promise((resolve) =>
              window.releaseBody = () => resolve(JSON.parse(r.body))
            ),
        };
      }
      if (testAuth.fetchMode === "late-response") {
        await new Promise((r) => window.releaseResponse = r);
      }
      return new Response(r.body, {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }, {
    tokens: f.tokens,
    uidA: "00000000-0000-4000-8000-000000000001",
    uidB: "00000000-0000-4000-8000-000000000002",
  });
  const hookedAuth = auth.replace(
    /const publishableKey\s*=\s*[^;]+;/,
    'const publishableKey = "sb_publishable_TEST_ONLY";',
  ).replace(
    "    initializeAuth();",
    "    window.authProbe={applySession,active:()=>tmdbAuthRequests.size,ready:()=>supabaseMovieLoadRequest?.ready}; scheduleAutoInitializeSupabaseSyncMetadata=()=>{}; initializeAuth();",
  );
  await page.addScriptTag({ content: hookedAuth });
  await page.waitForFunction(() =>
    document.documentElement.dataset.authState === "authenticated" &&
    authProbe.ready()
  );
  const test = async (name, fn) => {
    const detail = await fn();
    results.push({ engine, viewport, name, result: "PASS", detail });
    console.log("PASS", engine, viewport.width, name);
  };
  const reset = async (user = "A") => {
    await page.evaluate((user) => {
      testAuth.user = testUsers[user];
      testAuth.kind = user;
      testAuth.mode = "normal";
      testAuth.fetchMode = "normal";
      testAuth.signOutFails = false;
      authProbe.applySession({ user: { id: testAuth.user } });
    }, user);
    await page.waitForFunction(() =>
      document.documentElement.dataset.authState === "authenticated" &&
      authProbe.ready()
    );
    await page.evaluate(async () => {
      await openForm();
      testAuth.calls = [];
      testAuth.sessionCalls = 0;
      window.searches = {};
      window.saveCalls = [];
      alerts = [];
      saveNewMovieToSupabase = async (m) => {
        saveCalls.push({ synopsis: m.synopsis, runtime: m.runtime });
        return { ok: true };
      };
    });
    f.reset();
  };
  const start = (query = "模擬検索", key = "current") =>
    page.evaluate(({ query, key }) => {
      const el = document.getElementById("titleInput");
      el.value = query;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      clearTimeout(titleSearchTimer);
      searches[key] = searchTitleSuggestions(query);
    }, { query, key });
  const finish = (key = "current") =>
    page.evaluate((key) => searches[key], key);
  const state = () =>
    page.evaluate(() => ({
      message: document.querySelector("#titleSuggestions .title-search-message")
        ?.textContent || "",
      titles: [
        ...document.querySelectorAll(
          "#titleSuggestions button > span > span:first-child",
        ),
      ].map((e) => e.textContent),
      hidden: document.getElementById("titleSuggestions").classList.contains(
        "hidden",
      ),
      active: authProbe.active(),
      calls: testAuth.calls.length,
      headersValid: testAuth.calls.every((c) =>
        c.correctBearer && c.correctApikey
      ),
      saveDisabled: ["saveBtn", "mobileSaveBtn"].map((id) =>
        document.getElementById(id).disabled
      ),
      pending: !!newFormPendingDetails,
    }));
  const positions = () =>
    page.evaluate(() =>
      ["titleInput", "saveBtn", "posterPreview", "mobileSaveBtn"].map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [id, r.x, r.y, r.width, r.height];
      })
    );
  const waitForSession = () =>
    page.waitForFunction(() => typeof window.releaseSession === "function");
  const freeze = async () => {
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
  };

  for (const user of ["A", "B"]) {
    await test("signed-" + user + "-search-details-and-save", async () => {
      await reset(user);
      await start();
      assert.equal((await finish()).status, "success");
      assert.equal(
        f.state.lastUser,
        user === "A"
          ? "00000000-0000-4000-8000-000000000001"
          : "00000000-0000-4000-8000-000000000002",
      );
      assert((await state()).headersValid);
      if (viewport.width < 600) {
        await page.locator("#titleSuggestions button").tap();
      } else {
        await page.locator("#titleSuggestions button").focus();
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(() => !newFormPendingDetails);
      assert.equal(await page.locator("#runtimeInput").inputValue(), "111");
      assert.equal(
        await page.locator("#synopsisInput").inputValue(),
        "模擬の概要",
      );
      await page.evaluate(() => saveMovie());
      assert.equal(await page.evaluate(() => saveCalls.length), 1);
      assert.equal(f.state.tmdbCalls, 2);
      return {
        verifiedUser: user,
        authAndApiHeaders: true,
        metadataAndMockSave: true,
      };
    });
  }
  for (
    const kind of [
      "wrongSignature",
      "expired",
      "foreign",
      "anonymous",
      "wrongRole",
    ]
  ) {
    await test("server-reject-" + kind + "-shows-login-message", async () => {
      await reset();
      await page.evaluate((kind) => testAuth.kind = kind, kind);
      const before = await positions();
      await start();
      assert.equal((await finish()).status, "auth-error");
      const s = await state();
      assert(s.message.includes("ログイン状態を確認"));
      assert.equal(f.state.tmdbCalls, 0);
      assert.deepEqual(await positions(), before);
      assert.equal(s.active, 0);
      return { status: 401, upstreamCalls: 0, loginMessage: true };
    });
  }
  await test("unauthenticated-does-not-start-function-fetch", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.user = null;
      authProbe.applySession(null);
    });
    const r = await page.evaluate(() =>
      callTmdbFunction({ action: "search", query: "検索" }).then(
        () => false,
        (e) => e.tmdbFailure === "auth-error" && e.httpStatus === 401,
      )
    );
    assert(r);
    assert.equal((await state()).calls, 0);
    assert.equal(f.state.authCalls, 0);
    assert.equal(f.state.tmdbCalls, 0);
    return { local401: true, noOutgoingCall: true };
  });
  for (const mode of ["missing", "expired-meta", "throw", "wrong-user"]) {
    await test("session-reject-before-network-" + mode, async () => {
      await reset();
      await page.evaluate((mode) => testAuth.mode = mode, mode);
      await start();
      assert.equal((await finish()).status, "auth-error");
      assert.equal((await state()).calls, 0);
      assert.equal(f.state.tmdbCalls, 0);
      return { local401: true, noOutgoingCall: true };
    });
  }
  await test("fresh-token-read-for-every-request", async () => {
    await reset();
    await start("最初の検索", "first");
    await finish("first");
    await page.evaluate(() => testAuth.kind = "ES_A");
    await start("次の検索", "second");
    assert.equal((await finish("second")).status, "success");
    assert((await state()).headersValid);
    assert.equal(await page.evaluate(() => testAuth.sessionCalls), 2);
    return { latestRotatedSessionUsed: true };
  });
  await test("logout-during-session-read-prevents-old-token-send", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.mode = "defer";
      window.releaseSession = null;
    });
    await start();
    await waitForSession();
    await page.evaluate(() => authProbe.applySession(null));
    assert.equal((await finish()).status, "cancelled");
    await page.evaluate(() => releaseSession());
    assert.equal((await state()).calls, 0);
    assert.equal((await state()).active, 0);
    return { oldTokenNotSent: true };
  });
  await test("user-switch-during-session-read-prevents-old-token-send", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.mode = "defer";
      window.releaseSession = null;
    });
    await start("Aの保留", "old");
    await waitForSession();
    await page.evaluate(() => {
      testAuth.mode = "normal";
      testAuth.user = testUsers.B;
      testAuth.kind = "B";
      authProbe.applySession({ user: { id: testUsers.B } });
    });
    await page.waitForFunction(() =>
      document.documentElement.dataset.authState === "authenticated" &&
      authProbe.ready()
    );
    await page.evaluate(() => openForm());
    await start("Bの検索", "new");
    assert.equal((await finish("new")).status, "success");
    await page.evaluate(() => releaseSession());
    assert.equal((await finish("old")).status, "cancelled");
    assert.equal(f.state.tmdbCalls, 1);
    assert.equal(f.state.lastUser, "00000000-0000-4000-8000-000000000002");
    assert.deepEqual((await state()).titles, ["模擬映画"]);
    return { onlyBRequestSent: true };
  });
  await test("actual-logout-click-cancels-pending-call", async () => {
    await reset();
    await page.evaluate(() => testAuth.fetchMode = "hold-fetch");
    await start();
    await page.waitForFunction(() => testAuth.calls.length === 1);
    await page.evaluate(() => document.getElementById("authLogoutBtn").click());
    assert.equal((await finish()).status, "cancelled");
    assert.equal((await state()).active, 0);
    assert(
      await page.evaluate(() =>
        document.documentElement.dataset.authState === "guest"
      ),
    );
    return { logoutCallbackAndControllerCancellation: true };
  });
  await test("logout-failure-allows-new-request-after-unlock", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.mode = "defer";
      testAuth.signOutFails = true;
      window.releaseSession = null;
    });
    await start("保留", "old");
    await waitForSession();
    await page.evaluate(() => document.getElementById("authLogoutBtn").click());
    await page.waitForFunction(() =>
      !document.getElementById("authLogoutBtn").disabled
    );
    await page.evaluate(() => {
      releaseSession();
      testAuth.mode = "normal";
    });
    assert.equal((await finish("old")).status, "cancelled");
    await start("再試行", "new");
    assert.equal((await finish("new")).status, "success");
    return { failedLogoutDoesNotLeaveAuthTransportLocked: true };
  });
  await test("already-aborted-request-does-not-read-session-or-fetch", async () => {
    await reset();
    const r = await page.evaluate(async () => {
      const c = new AbortController();
      c.abort();
      try {
        await callTmdbFunction({ action: "search", query: "検索" }, c.signal);
        return false;
      } catch (e) {
        return e.name === "AbortError";
      }
    });
    assert(r);
    assert.equal((await state()).calls, 0);
    assert.equal(await page.evaluate(() => testAuth.sessionCalls), 0);
    return { noRequest: true };
  });
  for (const stage of ["session", "fetch", "body"]) {
    await test("30-second-timeout-" + stage, async () => {
      await reset();
      await freeze();
      await page.evaluate((stage) => {
        testAuth.mode = stage === "session" ? "defer" : "normal";
        testAuth.fetchMode = stage === "fetch"
          ? "hold-fetch"
          : stage === "body"
          ? "hold-body"
          : "normal";
        window.releaseSession = null;
        window.releaseBody = null;
      }, stage);
      await start();
      if (stage === "session") {
        await waitForSession();
      }
      if (stage === "fetch") {
        await page.waitForFunction(() => testAuth.calls.length === 1);
      }
      if (stage === "body") {
        await page.waitForFunction(() => typeof releaseBody === "function");
      }
      await page.clock.fastForward(29999);
      assert.equal((await state()).active, 1);
      await page.clock.fastForward(1);
      assert.equal((await finish()).status, "timeout");
      assert((await state()).message.includes("検索に時間がかかっています"));
      assert.equal((await state()).active, 0);
      if (stage === "session") await page.evaluate(() => releaseSession());
      if (stage === "body") await page.evaluate(() => releaseBody());
      await page.clock.resume();
      return {
        deadlineMs: 30000,
        authWaitIncluded: true,
        controllerReleased: true,
      };
    });
  }
  await test("keyword-change-during-session-read-discards-old-request", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.mode = "defer";
      window.releaseSession = null;
    });
    await start("旧入力", "old");
    await waitForSession();
    await page.evaluate(() => testAuth.mode = "normal");
    await start("新入力", "new");
    await finish("new");
    await page.evaluate(() => releaseSession());
    assert.equal((await finish("old")).status, "cancelled");
    assert.equal((await state()).calls, 1);
    return { onlyLatestSearchSent: true };
  });
  await test("late-response-after-user-switch-does-not-populate-new-form", async () => {
    await reset();
    await page.evaluate(() => {
      testAuth.fetchMode = "late-response";
      window.releaseResponse = null;
    });
    await start("Aの検索", "old");
    await page.waitForFunction(() => typeof releaseResponse === "function");
    await reset("B");
    await start("Bの検索", "new");
    await finish("new");
    await page.evaluate(() => releaseResponse());
    assert.deepEqual((await state()).titles, ["模擬映画"]);
    assert.equal((await state()).calls, 1);
    return { oldResponseDiscarded: true };
  });
  await test("auth-service-outage-is-not-login-failure", async () => {
    await reset();
    f.state.mode = "auth-503";
    await start();
    assert.equal((await finish()).status, "http-error");
    assert.equal(f.state.tmdbCalls, 0);
    assert(!(await state()).message.includes("再ログイン"));
    return { status: 503, upstreamCalls: 0 };
  });
  await test("upstream-401-is-not-user-authentication-error", async () => {
    await reset();
    f.state.tmdbStatus = 401;
    await start();
    assert.equal((await finish()).status, "http-error");
    assert(!(await state()).message.includes("再ログイン"));
    return { status: 502 };
  });
  await test("details-401-restores-save-and-preserves-manual-input", async () => {
    await reset();
    await start();
    await finish();
    await page.locator("#synopsisInput").fill("手動で入力した概要");
    await page.evaluate(() => testAuth.kind = "expired");
    await page.locator("#titleSuggestions button").click();
    await page.waitForFunction(() => !newFormPendingDetails);
    assert(
      (await page.locator("#fetchStatus").textContent()).includes(
        "ログイン状態を確認",
      ),
    );
    assert.equal(
      await page.locator("#synopsisInput").inputValue(),
      "手動で入力した概要",
    );
    assert((await state()).saveDisabled.every((v) => !v));
    return { manualInputPreserved: true, saveUnlocked: true };
  });
  await test("own-429-DB-wait-message-and-layout", async () => {
    await reset();
    f.state.rpcResult = { allowed: false, retry_after_seconds: 37 };
    const before = await positions();
    await start();
    assert.equal((await finish()).status, "rate-limit");
    assert((await state()).message.includes("あと37秒"));
    assert(!(await state()).message.includes("TMDbへのアクセス"));
    assert.equal(f.state.tmdbCalls, 0);
    assert.deepEqual(await positions(), before);
    return { safeJapaneseMessage: true, noLayoutMovement: true };
  });
  await test("store-503-safe-message-with-zero-TMDb", async () => {
    await reset();
    f.state.mode = "rpc-error";
    await start();
    assert.equal((await finish()).status, "service-unavailable");
    assert((await state()).message.includes("一時的に取得できません"));
    assert(!(await state()).message.includes("MOCK_PRIVATE"));
    assert.equal(f.state.tmdbCalls, 0);
    return { safe503: true };
  });
  await test("upstream-429-has-distinct-message", async () => {
    await reset();
    f.state.tmdbStatus = 429;
    f.state.tmdbRetry = "12";
    await start();
    assert.equal((await finish()).status, "tmdb-rate-limit");
    assert((await state()).message.includes("TMDbへのアクセスが集中"));
    assert((await state()).message.includes("あと12秒"));
    assert.equal(f.state.tmdbCalls, 1);
    return { distinctUpstreamMessage: true };
  });
  await test("retry-after-denial-works", async () => {
    await reset();
    f.state.rpcResult = { allowed: false, retry_after_seconds: 1 };
    await start("制限中", "denied");
    assert.equal((await finish("denied")).status, "rate-limit");
    f.state.rpcResult = { allowed: true, retry_after_seconds: 0 };
    await start("再検索", "retry");
    assert.equal((await finish("retry")).status, "success");
    return { retryWorks: true };
  });
  for (const mode of ["limited", "unavailable"]) {
    await test(
      "details-" + mode + "-preserves-input-and-manual-save",
      async () => {
        await reset();
        await start();
        await finish();
        await page.locator("#synopsisInput").fill("手動で入力した概要");
        if (mode === "limited") {
          f.state.rpcResult = { allowed: false, retry_after_seconds: 9 };
        } else f.state.mode = "rpc-error";
        await page.locator("#titleSuggestions button").click();
        await page.waitForFunction(() => !newFormPendingDetails);
        const msg = await page.locator("#fetchStatus").textContent();
        assert(
          msg.includes(
            mode === "limited" ? "あと9秒" : "一時的に取得できません",
          ),
        );
        assert.equal(
          await page.locator("#synopsisInput").inputValue(),
          "手動で入力した概要",
        );
        assert((await state()).saveDisabled.every((v) => !v));
        await page.evaluate(() => saveMovie());
        assert.equal(await page.evaluate(() => saveCalls.length), 1);
        assert.equal(f.state.tmdbCalls, 1);
        return { manualSavePossible: true };
      },
    );
  }
  await test("late-429-does-not-replace-new-user-results", async () => {
    await reset();
    f.state.rpcResult = { allowed: false, retry_after_seconds: 37 };
    await page.evaluate(() => {
      testAuth.fetchMode = "late-response";
      window.releaseResponse = null;
    });
    await start("Aの古い制限", "old");
    await page.waitForFunction(() => typeof releaseResponse === "function");
    await reset("B");
    await start("Bの最新検索", "new");
    assert.equal((await finish("new")).status, "success");
    await page.evaluate(() => releaseResponse());
    assert.deepEqual((await state()).titles, ["模擬映画"]);
    assert.equal((await state()).message, "");
    return { stale429Ignored: true };
  });
  await test("html-css-and-form-layout-unchanged", async () => {
    await reset();
    const cp = require("node:child_process");
    const before = cp.execFileSync("git", ["show", "HEAD:index.html"], {
      cwd: root,
      encoding: "utf8",
    });
    const strip = (s) => s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    assert.equal(strip(source), strip(before));
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.scrollWidth > innerWidth
      ),
      false,
    );
    f.state.rpcResult = { allowed: false, retry_after_seconds: 17 };
    await start();
    await finish();
    await page.screenshot({
      path: path.join(out, `${engine}-${viewport.width}-rate-limit.png`),
      fullPage: true,
    });
    return { htmlCssIdentical: true, noHorizontalOverflow: true };
  });
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.equal(f.state.unexpected, 0);
  await context.close();
}
(async () => {
  const vm = require("node:vm"),
    { stripTypeScriptTypes } = require("node:module");
  const { fixture } = await import("./fixtures.mjs");
  f = await fixture();
  const { createClient } = require(
    require.resolve("@supabase/supabase-js", {
      paths: [process.env.MOVIE_LOG_TEST_DEPS || __dirname],
    }),
  );
  const code = fs.readFileSync(
    path.join(root, "supabase/functions/tmdb/index.ts"),
    "utf8",
  ).replace(/^import[^\n]+\n/, "");
  vm.runInNewContext(stripTypeScriptTypes(code), {
    createClient: (url, key, options = {}) =>
      createClient(url, key, {
        ...options,
        global: { fetch: f.fetch, ...options.global },
      }),
    Deno: { env: { get: (k) => f.env[k] }, serve: (h) => edgeHandler = h },
    fetch: f.fetch,
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  for (const engine of ["chromium", "webkit"]) {
    browser = await (engine === "chromium"
      ? chromium.launch({
        ...(process.env.MOVIE_LOG_TEST_CHROMIUM
          ? { executablePath: process.env.MOVIE_LOG_TEST_CHROMIUM }
          : {}),
        headless: true,
      })
      : webkit.launch({ headless: true }));
    for (
      const viewport of [{ width: 1440, height: 1000 }, {
        width: 390,
        height: 844,
      }, { width: 375, height: 667 }]
    ) {
      await run(engine, viewport);
    }
    await browser.close();
    browser = null;
  }
  assert.equal(blockedExternal, 0);
  fs.writeFileSync(
    path.join(out, "browser-results.json"),
    JSON.stringify(
      {
        tests: results,
        externalProductionRequests: 0,
        scope:
          "Actual frontend and transpiled Function with pinned SDK; crypto-verifying mock Auth/TMDb; only fake JWTs generated in memory.",
      },
      null,
      2,
    ),
  );
  console.log(
    "COMPLETE",
    results.length,
    "browser checks; external production requests: 0",
  );
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
