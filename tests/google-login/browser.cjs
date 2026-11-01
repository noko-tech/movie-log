// All browser requests are fulfilled from local files / fixtures or aborted.
// No real Google, Supabase, database, or user data is used.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict"), { execFileSync } = require("node:child_process");
const zlib = require("node:zlib");
const deps = process.env.MOVIE_LOG_TEST_DEPS;
assert(deps && process.env.MOVIE_LOG_TEST_TAILWIND, "Set local dependency and Tailwind paths; see README.md");
const { chromium, webkit } = require(require.resolve("playwright", { paths: [deps] }));
const sdk = fs.readFileSync(path.join(deps, "@supabase/supabase-js/dist/umd/supabase.js"), "utf8");
const tailwind = fs.readFileSync(process.env.MOVIE_LOG_TEST_TAILWIND);
const fontDir = process.env.MOVIE_LOG_TEST_FONTS;
const fontManifest = fontDir ? JSON.parse(fs.readFileSync(path.join(fontDir, "manifest.json"), "utf8")) : {};
const root = path.resolve(__dirname, "../..");
const out = process.env.MOVIE_LOG_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), "movie-log-google-browser-"));
assert(!path.resolve(out).startsWith(root + path.sep), "Keep test artifacts outside the repository");
fs.mkdirSync(out, { recursive: true });
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const baseline = execFileSync("git", ["show", "HEAD:index.html"], { cwd: root, encoding: "utf8", maxBuffer: 2 ** 22 });
const productionUrl = new URL(source.match(/const siteUrl = "([^"]+)"/)[1]);
const localUrl = "http://localhost:8000/";
const mockProject = "http://localhost:8000/mock-supabase";
const sanitize = (html) => html
  .replace(/const projectUrl = "[^"]+";/, `const projectUrl = "${mockProject}";`)
  .replace(/const publishableKey = "[^"]+";/, 'const publishableKey = "local-test-public-placeholder";');
const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "login-test@example.invalid", app_metadata: { provider: "google", providers: ["google"] }, user_metadata: {} };
const rows = [{
  id: "00000000-0000-4000-8000-000000000011", user_id: user.id,
  legacy_local_id: "google-login-fixture", title: "LOCAL TEST MOVIE", tmdb_id: null, media_type: "movie",
  poster_url: null, overview: "", rating: 4, favorite: false, status: "watched", genre: "Animation",
  year: 2023, runtime: 100, country: "JP", director: "", writer: "", cast: "", watch_date: "2023-01",
  comment: "", series_name: "", series_order: null, created_at: "2023-01-01T00:00:00Z", updated_at: "2023-01-01T00:00:00Z",
}];
function session() {
  const expires_at = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return { access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, exp: expires_at }) + ".local-test-signature", refresh_token: "local-test-refresh-only", expires_at, expires_in: 3600, token_type: "bearer", user };
}
const results = [];
let browser, currentCase;
let requestsHandled = 0, realNetworkRequests = 0;
async function test(name, fn) {
  if (process.env.MOVIE_LOG_TEST_FILTER && !name.includes(process.env.MOVIE_LOG_TEST_FILTER)) return;
  currentCase = name;
  await fn();
  results.push({ name, result: "PASS" });
  console.log("PASS", name);
}
async function open({ engine, width = 1440, height = 1000, url = localUrl, original = false, stored = false, mode = "normal", denyStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: engine === "webkit" && width < 600, hasTouch: width < 600, serviceWorkers: "block" });
  const calls = [], failures = [], errors = [], consoles = [];
  await context.addInitScript(({ stored, session, mode, denyStorage }) => {
    window.mockOAuthMode = mode;
    window.oauthCalls = [];
    if (stored) localStorage.setItem("sb-localhost-auth-token", JSON.stringify(session));
    if (denyStorage) {
      const prototype = Object.getPrototypeOf(sessionStorage);
      const get = prototype.getItem, set = prototype.setItem, remove = prototype.removeItem;
      prototype.getItem = function (...args) { if (this === sessionStorage) throw new Error("Blocked"); return get.apply(this, args); };
      prototype.setItem = function (...args) { if (this === sessionStorage) throw new Error("Blocked"); return set.apply(this, args); };
      prototype.removeItem = function (...args) { if (this === sessionStorage) throw new Error("Blocked"); return remove.apply(this, args); };
    }
  }, { stored, session: session(), mode, denyStorage });
  // No continue() / fallback(): none of these requests can leave the test process.
  await context.route("**/*", async (route) => {
    requestsHandled++;
    const request = route.request(), u = new URL(request.url());
    if (u.origin === "http://localhost:8000" && u.pathname.startsWith("/mock-supabase/")) {
      calls.push({ path: u.pathname, method: request.method(), query: u.searchParams });
      if (u.pathname.endsWith("/authorize")) return route.fulfill({ contentType: "text/html", body: "<title>Mock authorization</title><p>LOCAL MOCK AUTHORIZATION</p>" });
      if (u.pathname.endsWith("/user")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(user) });
      if (u.pathname.endsWith("/token") && u.searchParams.get("grant_type") === "password") return route.fulfill({ contentType: "application/json", body: JSON.stringify(session()) });
      if (u.pathname.endsWith("/logout")) return route.fulfill({ status: 204, body: "" });
      if (u.pathname.endsWith("/rest/v1/movie_logs") && ["GET", "HEAD"].includes(request.method())) return route.fulfill({ contentType: "application/json", body: request.method() === "HEAD" ? "" : JSON.stringify(rows), headers: { "Content-Range": "0-0/1" } });
      failures.push("unexpected mock operation " + request.method() + " " + u.pathname);
      return route.abort();
    }
    if (u.hostname === "cdn.jsdelivr.net") {
      const instrumentation = `
        const realCreateClient = window.supabase.createClient;
        window.supabase = { ...window.supabase, createClient(...args) {
          const client = realCreateClient(...args);
          window.mockClient = client;
          const realOAuth = client.auth.signInWithOAuth.bind(client.auth);
          client.auth.signInWithOAuth = async (args) => {
            window.oauthCalls.push(args);
            if (window.mockOAuthMode === 'error') return { data: null, error: { message: 'INTERNAL_DETAILS_MUST_NOT_APPEAR', status: 500 } };
            if (window.mockOAuthMode === 'throw') throw new Error('INTERNAL_DETAILS_MUST_NOT_APPEAR');
            if (window.mockOAuthMode === 'hold') return { data: { provider: 'google', url: '${mockProject}/auth/v1/authorize' }, error: null };
            return realOAuth(args);
          };
          return client;
        }};
      `;
      return route.fulfill({ contentType: "application/javascript", body: sdk + "\n" + instrumentation });
    }
    if (u.hostname === "cdn.tailwindcss.com") return route.fulfill({ contentType: "application/javascript", body: tailwind });
    if (fontManifest[u.href]) {
      const fontFile = path.resolve(fontDir, fontManifest[u.href]);
      assert(fontFile.startsWith(path.resolve(fontDir) + path.sep));
      return route.fulfill({ contentType: u.hostname === "fonts.googleapis.com" ? "text/css" : "font/woff2", body: fs.readFileSync(fontFile) });
    }
    if (u.hostname === "fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
    if ([new URL(url).origin, "http://localhost:8000", productionUrl.origin].includes(u.origin)) {
      if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html; charset=utf-8", body: sanitize(original ? baseline : source) });
      if (u.pathname.includes("/assets/")) {
        const name = decodeURIComponent(u.pathname.slice(u.pathname.indexOf("/assets/") + 1));
        const file = path.resolve(root, name);
        if (file.startsWith(path.join(root, "assets") + path.sep) && fs.existsSync(file)) {
          const type = { ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png" }[path.extname(file)];
          return route.fulfill({ contentType: type || "application/octet-stream", body: fs.readFileSync(file) });
        }
      }
    }
    failures.push("blocked unexpected browser request");
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => consoles.push(message.text()));
  page.testDiagnostics = () => ({ calls: calls.map(({ path, method }) => ({ path, method })), errors, failures });
  await page.goto(url);
  await ready(page, stored ? "authenticated" : "guest");
  return { context, page, calls, failures, errors, consoles };
}
async function ready(page, state) {
  try {
    await page.waitForFunction((state) => document.documentElement.dataset.authState === state, state, { timeout: 10000 });
  } catch (_) {
    const actual = await page.evaluate(() => ({ state: document.documentElement.dataset.authState, message: document.getElementById("authMessage").textContent, loading: document.getElementById("authLoading").textContent }));
    throw new Error(`Expected ${state}: ${JSON.stringify({ ...actual, ...page.testDiagnostics() })}`);
  }
  await page.waitForFunction(() => getComputedStyle(document.body).marginLeft === "0px");
  await page.evaluate(() => document.fonts.ready);
}
async function close(f) {
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.failures, []);
  assert(!f.consoles.join("\n").includes("INTERNAL_DETAILS_MUST_NOT_APPEAR"));
  await f.context.close();
}
async function geometry(page) {
  // Existing press animations must finish before comparing layout coordinates.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const card = document.querySelector(".auth-card").getBoundingClientRect();
    return Object.fromEntries([".auth-heading", "#authTitle", "#authEmail", "#authPassword", "#authSubmitBtn", "#authSwitchBtn"].map((selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x: r.x - card.x, y: r.y - card.y, width: r.width, height: r.height }];
    }));
  });
}
async function capture(page, name) {
  await page.waitForTimeout(150);
  return page.screenshot({ path: path.join(out, name), fullPage: true, animations: "disabled" });
}
// Same PNG comparison tolerance as tests/pages/browser.cjs: only rare 1/255
// image/GPU rounding is allowed. Layout, fonts, or content changes still fail.
function decodePng(buffer) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  let width, height, channels, offset = 8;
  const chunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert(data[8] === 8 && [2,6].includes(data[9]) && data[12] === 0);
      channels = data[9] === 2 ? 3 : 4;
    }
    if (type === "IDAT") chunks.push(data);
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks)), stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++]; assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? pixels[i-channels] : 0;
      const b = y ? pixels[i-stride] : 0, c = y && x >= channels ? pixels[i-stride-channels] : 0;
      const p = a + b - c, distances = [Math.abs(p-a),Math.abs(p-b),Math.abs(p-c)];
      const prediction = [0,a,b,Math.floor((a+b)/2),[a,b,c][distances.indexOf(Math.min(...distances))]][filter];
      pixels[i] = (raw[offset++] + prediction) & 255;
    }
  }
  return { width, height, channels, pixels };
}
function sameAppearance(left, right) {
  if (left.equals(right)) return;
  const a = decodePng(left), b = decodePng(right);
  assert.deepEqual([a.width,a.height,a.channels], [b.width,b.height,b.channels]);
  let changed = 0, maximum = 0;
  for (let i = 0; i < a.pixels.length; i += a.channels) {
    let delta = 0;
    for (let j = 0; j < a.channels; j++) delta = Math.max(delta, Math.abs(a.pixels[i+j]-b.pixels[i+j]));
    if (delta) changed++;
    maximum = Math.max(maximum, delta);
  }
  assert(maximum <= 1 && changed <= a.width * a.height * 0.0001,
    `View changed beyond rounding tolerance: ${changed} pixels, max delta ${maximum}`);
}
(async () => {
  for (const [engine, implementation] of [["chromium", chromium], ["webkit", webkit]]) {
    browser = await implementation.launch(engine === "chromium" && process.env.MOVIE_LOG_TEST_CHROMIUM ? { executablePath: process.env.MOVIE_LOG_TEST_CHROMIUM } : {});
    for (const [width, height] of [[1440,1000],[390,844],[375,667],[320,568]]) {
      await test(`${engine} ${width}: button, layout, touch and keyboard`, async () => {
        const old = await open({ engine, width, height, original: true });
        const f = await open({ engine, width, height, mode: "hold" });
        const currentGeometry = await geometry(f.page), originalGeometry = await geometry(old.page);
        for (const selector of Object.keys(originalGeometry).filter((selector) => selector !== "#authSwitchBtn")) {
          assert.deepEqual(currentGeometry[selector], originalGeometry[selector], "Existing LOGIN and inputs must retain their layout");
        }
        const button = f.page.locator("#authGoogleBtn"), box = await button.boundingBox();
        assert(box.width >= 180 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
        const layout = await f.page.evaluate(() => {
          const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
          const style = (selector) => getComputedStyle(document.querySelector(selector));
          return { login:rect('#authSubmitBtn'), divider:rect('.auth-divider'), google:rect('#authGoogleBtn'), link:rect('#authSwitchBtn'), note:rect('.auth-invite-note'),
            loginShadow:style('#authSubmitBtn').boxShadow, googleShadow:style('#authGoogleBtn').boxShadow,
            background:style('#authGoogleBtn').backgroundColor, border:style('#authGoogleBtn').borderColor,
            line:getComputedStyle(document.querySelector('.auth-divider'),'::before').height };
        });
        for (const key of ["x","width","height"]) assert(Math.abs(layout.login[key]-layout.google[key]) < 0.1, `Buttons must have equal ${key}`);
        assert(layout.login.bottom <= layout.divider.y && layout.divider.bottom <= layout.google.y && layout.google.bottom <= layout.link.y && layout.link.bottom <= layout.note.y);
        // Count the LOGIN button's visible 4px lower shadow, not just its box.
        // The text and both lines form one divider; its two outer gaps match.
        const aboveDivider = layout.divider.y - (layout.login.bottom + 4);
        const belowDivider = layout.google.y - layout.divider.bottom;
        assert(Math.abs(aboveDivider - belowDivider) < 0.1, "Visible divider gaps must be balanced");
        assert(Math.abs(aboveDivider - 12) < 0.1, "Keep the approved lower 12px gap");
        console.log(`GAP ${engine} ${width}: above=${aboveDivider}px below=${belowDivider}px`);
        assert.equal(layout.googleShadow, layout.loginShadow);
        assert.equal(layout.background, "rgb(255, 255, 255)");
        assert.equal(layout.border, "rgb(28, 28, 28)");
        assert.equal(layout.line, "1px");
        assert.equal(await f.page.locator('.auth-invite-note').textContent(), '現在、新規登録は招待制です');
        assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await button.textContent().then((s) => s.trim()), "Googleでログイン");
        await button.focus();
        assert(await button.evaluate((element) => element === document.activeElement && getComputedStyle(element).outlineStyle !== "none"));
        await button.evaluate((element) => element.blur());
        await capture(f.page, `${engine}-${width}-login.png`);
        if (width < 600) await button.tap();
        else { await button.focus(); await button.press("Enter"); }
        assert.equal(await f.page.evaluate(() => oauthCalls.length), 1);
        assert.equal((await button.boundingBox()).height, layout.login.height, "Busy label must not change button height");
        await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted:true })));
        await f.page.locator("#authSwitchBtn").click();
        await old.page.locator("#authSwitchBtn").click();
        assert(await button.isHidden());
        assert(await f.page.locator('.auth-divider').isHidden());
        assert(await f.page.locator('.auth-invite-note').isHidden());
        assert.deepEqual(await geometry(f.page), await geometry(old.page));
        await close(old); await close(f);
      });
    }
    await test(`${engine}: SDK Google call, no extra scopes, back restores controls`, async () => {
      const f = await open({ engine });
      await f.page.locator("#authGoogleBtn").click();
      await f.page.waitForURL((url) => url.pathname.endsWith("/authorize"));
      const authorize = f.calls.find((call) => call.path.endsWith("/authorize"));
      assert.equal(authorize.query.get("provider"), "google");
      assert.equal(authorize.query.get("redirect_to"), localUrl);
      assert(!authorize.query.has("scopes") && !authorize.query.has("access_type"));
      await f.page.goBack();
      await ready(f.page, "guest");
      assert(await f.page.locator("#authGoogleBtn").isEnabled());
      assert.match(await f.page.locator("#authMessage").textContent(), /Googleログインを完了していません/);
      await close(f);
    });
    await test(`${engine}: pending prevents double click; bfcache return resets`, async () => {
      const f = await open({ engine, mode: "hold" });
      await f.page.locator("#authGoogleBtn").click();
      await f.page.locator("#authGoogleBtn").dispatchEvent("click");
      assert.equal(await f.page.evaluate(() => oauthCalls.length), 1);
      assert(await f.page.locator("#authGoogleBtn").isDisabled());
      assert(await f.page.locator("#authSubmitBtn").isDisabled());
      assert.equal(await f.page.locator("#authGoogleBtn").getAttribute("aria-busy"), "true");
      await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      assert(await f.page.locator("#authGoogleBtn").isEnabled());
      await close(f);
    });
    for (const mode of ["error", "throw"]) await test(`${engine}: SDK ${mode} stays generic and retryable`, async () => {
      const f = await open({ engine, mode });
      await f.page.locator("#authGoogleBtn").click();
      await f.page.waitForFunction(() => !document.getElementById("authGoogleBtn").disabled);
      assert.match(await f.page.locator("#authMessage").textContent(), /開始できませんでした/);
      assert(!(await f.page.locator("#authMessage").textContent()).includes("INTERNAL"));
      await close(f);
    });
    for (const [name, suffix, expected] of [
      ["invite rejection", "#error=server_error&error_code=unexpected_failure&error_description=INTERNAL_DETAILS_MUST_NOT_APPEAR", /招待が必要/],
      ["provider cancellation", "#error=access_denied&error_code=provider_error&error_description=INTERNAL_DETAILS_MUST_NOT_APPEAR", /キャンセル/],
      ["query rejection", "?error=server_error&error_description=INTERNAL_DETAILS_MUST_NOT_APPEAR", /招待が必要/],
      ["email confirmation error", "#error=access_denied&error_code=otp_expired&error_description=INTERNAL_DETAILS_MUST_NOT_APPEAR", /確認リンク/],
    ]) await test(`${engine}: ${name}, no internal text in UI or URL`, async () => {
      const f = await open({ engine, url: localUrl + suffix });
      assert.match(await f.page.locator("#authMessage").textContent(), expected);
      assert(!(await f.page.locator("body").innerText()).includes("INTERNAL_DETAILS"));
      assert(!f.page.url().includes("error"));
      assert(await f.page.locator("#authGoogleBtn").isEnabled());
      assert(!f.calls.some((call) => call.path.endsWith("/rest/v1/movie_logs")));
      await close(f);
    });
    await test(`${engine}: Google callback restores SDK session, loads movies once, logs out`, async () => {
      const f = await open({ engine });
      await f.page.locator("#authGoogleBtn").click();
      await f.page.waitForURL((url) => url.pathname.endsWith("/authorize"));
      const token = session();
      const fragment = new URLSearchParams({ access_token: token.access_token, refresh_token: token.refresh_token, expires_in: "3600", token_type: "bearer" });
      await f.page.goto(localUrl + "#" + fragment);
      await ready(f.page, "authenticated");
      await f.page.waitForSelector(".movie-card");
      assert((await f.page.locator("body").innerText()).includes(rows[0].title));
      assert(!f.page.url().includes("access_token"));
      const reads = () => f.calls.filter((call) => call.path.endsWith("/rest/v1/movie_logs") && call.method === "GET").length;
      const count = reads();
      assert(count > 0);
      await f.page.evaluate(async () => {
        const { data } = await mockClient.auth.getSession();
        await mockClient.auth._notifyAllSubscribers("SIGNED_IN", data.session);
      });
      await f.page.waitForTimeout(100);
      assert.equal(reads(), count, "Duplicate auth notification must not reload movies");
      await f.page.reload();
      await ready(f.page, "authenticated");
      await f.page.locator("#accountMenuToggle").click();
      await f.page.locator("#authLogoutBtn").click();
      await ready(f.page, "guest");
      assert(await f.page.locator("#authGoogleBtn").isVisible());
      await close(f);
    });
    await test(`${engine}: existing password login works and returns same movie owner`, async () => {
      const f = await open({ engine });
      await f.page.locator("#authEmail").fill("login-test@example.invalid");
      await f.page.locator("#authPassword").fill("local-test-password-only");
      await f.page.locator("#authSubmitBtn").click();
      await ready(f.page, "authenticated");
      assert(await f.page.evaluate(async (id) => (await mockClient.auth.getSession()).data.session.user.id === id, user.id));
      assert(f.calls.some((call) => call.path.endsWith("/token")));
      await close(f);
    });
    await test(`${engine}: signed-in view matches committed baseline pixels`, async () => {
      const old = await open({ engine, stored: true, original: true });
      const f = await open({ engine, stored: true });
      await old.page.waitForSelector(".movie-card"); await f.page.waitForSelector(".movie-card");
      const a = await capture(old.page, `${engine}-baseline-movies.png`);
      const b = await capture(f.page, `${engine}-movies.png`);
      sameAppearance(a, b);
      await close(old); await close(f);
    });
    for (const url of ["http://127.0.0.1:8000/", "http://localhost:8001/", "http://localhost:8000/other/"]) await test(`${engine}: unsupported origin/path cannot fall back to production`, async () => {
      const f = await open({ engine, url });
      await f.page.locator("#authGoogleBtn").click();
      assert.equal(await f.page.evaluate(() => oauthCalls.length), 0);
      assert.match(await f.page.locator("#authMessage").textContent(), /このURLから/);
      await close(f);
    });
    await test(`${engine}: production return path is explicit (virtual URL, no network)`, async () => {
      const f = await open({ engine, url: productionUrl.href, mode: "hold" });
      await f.page.locator("#authGoogleBtn").click();
      assert.deepEqual(await f.page.evaluate(() => oauthCalls[0]), { provider: "google", options: { redirectTo: productionUrl.href } });
      await close(f);
    });
    await test(`${engine}: sessionStorage unavailable does not prevent Google start`, async () => {
      const f = await open({ engine, denyStorage: true, mode: "hold" });
      await f.page.locator("#authGoogleBtn").click();
      assert.equal(await f.page.evaluate(() => oauthCalls.length), 1);
      await close(f);
    });
    await browser.close(); browser = null;
  }
  console.log(`COMPLETE: ${results.length} checks; real network requests: ${realNetworkRequests}; intercepted: ${requestsHandled}`);
})().catch((error) => {
  console.error("FAIL", currentCase, error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ tests: results, realNetworkRequests, requestsHandled, scope: "Real SDK and browser; fake OAuth, Auth API and movie rows; no account linking test." }, null, 2));
  console.log("Artifacts:", out);
});
