// Compare the unchanged working HTML with the generated site under /Movie-log/.
// All remote requests are intercepted; Supabase data is fake and read-only.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { chromium, webkit } = require(require.resolve("playwright", {
  paths: [process.env.MOVIE_LOG_TEST_DEPS || __dirname],
}));
const root = path.resolve(__dirname, "../..");
const site = process.env.MOVIE_LOG_PAGES_SITE, out = process.env.MOVIE_LOG_TEST_OUTPUT;
assert(site && out && process.env.MOVIE_LOG_TEST_TAILWIND, "Provide a generated site, temporary output and local Tailwind bundle");
fs.mkdirSync(out, { recursive: true });
const sdk = require.resolve("@supabase/supabase-js", { paths: [process.env.MOVIE_LOG_TEST_DEPS || __dirname] });
const sdkFile = [path.join(path.dirname(sdk), "umd/supabase.js"), path.resolve(path.dirname(sdk), "../umd/supabase.js")].find((file) => fs.existsSync(file));
assert(sdkFile, "A local Supabase UMD bundle is required");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const project = html.match(/const projectUrl = "([^"]+)"/)[1];
const storageKey = `sb-${new URL(project).hostname.split(".")[0]}-auth-token`;
const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "pages-test@example.invalid", user_metadata: {} };
const row = (n) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  user_id: user.id, legacy_local_id: `pages-mock-${n}`, tmdb_id: n, media_type: "movie",
  title: `表示確認 ${n}`, poster_url: "https://posters.example.invalid/mock.svg", overview: "模擬あらすじ",
  rating: 5, favorite: true, status: "watched", genre: "Animation", year: 2023, runtime: 100,
  country: "JP", director: "模擬監督", writer: "模擬脚本", cast: "模擬キャスト", watch_date: "2023-01",
  comment: "", series_name: "", series_order: null,
  created_at: "2023-01-01T00:00:00Z", updated_at: "2023-01-01T00:00:00Z",
});
const rows = [row(11), row(12), row(13)];
const contentType = (name) => ({ ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".txt": "text/plain" })[path.extname(name)] || "application/octet-stream";
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const base = pathname.startsWith("/Movie-log/") ? site : pathname.startsWith("/working/") ? root : null;
  if (!base) { res.writeHead(404); return res.end(); }
  const prefix = base === site ? "/Movie-log/" : "/working/";
  const relative = pathname.slice(prefix.length) || "index.html";
  const file = path.resolve(base, relative);
  if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end();
  }
  res.setHeader("Content-Type", contentType(file));
  res.end(fs.readFileSync(file));
});
let browser, origin, rejectedExternal = 0, mockedRequests = 0;
const results = [];
// PNG decoding uses only Node's standard library; no image-editing or install.
function decodePng(buffer) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  let width, height, channels, offset = 8;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert(data[8] === 8 && [2, 6].includes(data[9]) && data[12] === 0, "Unsupported screenshot PNG");
      channels = data[9] === 2 ? 3 : 4;
    }
    if (type === "IDAT") compressed.push(data);
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(compressed)), stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++]; assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? pixels[i - channels] : 0;
      const b = y ? pixels[i - stride] : 0, c = y && x >= channels ? pixels[i - stride - channels] : 0;
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = [a, b, c][distances.indexOf(Math.min(...distances))];
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth][filter];
      pixels[i] = (raw[offset++] + prediction) & 255;
    }
  }
  return { width, height, channels, pixels };
}
function appearanceDifference(source, published) {
  if (source.equals(published)) return { changedPixels: 0, maxChannelDifference: 0 };
  const a = decodePng(source), b = decodePng(published);
  assert.deepEqual([a.width, a.height, a.channels], [b.width, b.height, b.channels]);
  let changedPixels = 0, maxChannelDifference = 0;
  for (let i = 0; i < a.pixels.length; i += a.channels) {
    let delta = 0;
    for (let j = 0; j < a.channels; j++) delta = Math.max(delta, Math.abs(a.pixels[i + j] - b.pixels[i + j]));
    if (delta) changedPixels++;
    maxChannelDifference = Math.max(maxChannelDifference, delta);
  }
  // Allow only rare 1/255 image/GPU rounding differences, not layout changes.
  assert(maxChannelDifference <= 1 && changedPixels <= a.width * a.height * 0.0001, "Screenshot pixels differ beyond rounding tolerance");
  return { changedPixels, maxChannelDifference };
}
async function capture(engine, viewport, signedIn, prefix) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, serviceWorkers: "block" });
  const failures = [], localRequests = [], errors = [], mockRoutes = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "cdn.tailwindcss.com") return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(process.env.MOVIE_LOG_TEST_TAILWIND) });
    if (url.hostname === "cdn.jsdelivr.net") return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(sdkFile) });
    if (url.hostname === "fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
    if (url.origin === project) {
      mockedRequests++;
      mockRoutes.push({ path: url.pathname, method: request.method() });
      assert(["GET", "HEAD"].includes(request.method()), "No production or mock data writes are allowed");
      if (url.pathname.startsWith("/rest/v1/movie_logs")) return route.fulfill({ contentType: "application/json", body: request.method() === "HEAD" ? "" : JSON.stringify(rows), headers: { "Content-Range": "0-2/3", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range" } });
      if (url.pathname === "/auth/v1/user") return route.fulfill({ contentType: "application/json", body: JSON.stringify(user), headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (url.hostname === "posters.example.invalid") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#c4c1b7"/></svg>' });
    rejectedExternal++;
    return route.abort();
  });
  if (signedIn) await context.addInitScript(({ storageKey, user }) => {
    const expires_at = Math.floor(Date.now() / 1000) + 3600;
    const encoded = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = encoded({ alg: "HS256", typ: "JWT" }) + "." + encoded({ sub: user.id, exp: expires_at }) + ".fake-signature-for-local-test-only";
    localStorage.setItem(storageKey, JSON.stringify({ access_token: jwt, refresh_token: "local-test-only", expires_at, expires_in: 3600, token_type: "bearer", user }));
  }, { storageKey, user });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().startsWith(origin + prefix)) {
      localRequests.push(new URL(response.url()).pathname);
      if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  await page.goto(origin + prefix);
  try {
    await page.waitForFunction((state) => document.documentElement.dataset.authState === state, signedIn ? "authenticated" : "guest");
  } catch (_) {
    throw Error(JSON.stringify({ engine, viewport, signedIn, errors, mockRoutes, state: await page.evaluate(() => document.documentElement.dataset.authState), message: await page.locator("#authMessage").textContent() }));
  }
  await page.waitForFunction(() => getComputedStyle(document.body).marginLeft === "0px");
  const captures = {};
  async function snapshot(state) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const filename = `${engine}-${viewport.width}-${prefix.includes("Movie-log") ? "site" : "source"}-${state}.png`;
    captures[state] = await page.screenshot({ path: path.join(out, filename), animations: "disabled" });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow in ${state}`);
  }
  if (signedIn) {
    await page.waitForSelector(".movie-card");
    const selector = viewport.width >= 1024 ? "#desktopStatusCounts .watch-time-stat" : "#statusCounts .watch-time-stat";
    const mask = await page.locator(selector).evaluate((element) => getComputedStyle(element, "::after").maskImage || getComputedStyle(element, "::after").webkitMaskImage);
    assert(mask.includes("watchtime-line2.png"), "Effective mask must not use the deleted legacy image");
    await snapshot("list");
    await page.locator("#desktopAddBtn").click();
    await page.waitForSelector("#formView:not(.hidden)");
    await page.waitForSelector("#formView .poster-empty-icon:visible");
    await snapshot("new-entry");
  } else {
    await page.waitForSelector("#authForm:not([hidden])");
    await snapshot("login");
    await page.locator("#authSwitchBtn").click();
    await snapshot("signup");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert(!localRequests.some((url) => url.includes("watchtime-accent.png")));
  await context.close();
  return { captures, localRequests };
}
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "deploy/pages-files.json"), "utf8"));
  for (const name of manifest.files) {
    const response = await fetch(origin + "/Movie-log/" + name);
    assert.equal(response.status, 200);
    assert(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(root, name))));
  }
  for (const name of ["supabase/migrations/20261024000100_tmdb_rate_limit.sql", "supabase/functions/tmdb/index.ts", "tests/tmdb-rate-limit/browser.cjs", ".env", ".DS_Store", "movie-log-backup-20261025.json", "assets/ChatGPT 画像 2026年10月23日 09_22_46.png"]) {
    assert.equal((await fetch(origin + "/Movie-log/" + name)).status, 404);
  }
  for (const [engine, implementation] of [["chromium", chromium], ["webkit", webkit]]) {
    browser = await implementation.launch(engine === "chromium" ? { args: ["--disable-gpu"], ...(process.env.MOVIE_LOG_TEST_CHROMIUM ? { executablePath: process.env.MOVIE_LOG_TEST_CHROMIUM } : {}) } : {});
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
      for (const signedIn of [false, true]) {
        const source = await capture(engine, viewport, signedIn, "/working/");
        const published = await capture(engine, viewport, signedIn, "/Movie-log/");
        for (const state of Object.keys(source.captures)) {
          const difference = appearanceDifference(source.captures[state], published.captures[state]);
          results.push({ engine, viewport, state, ...difference, noLocal404: true, noHorizontalOverflow: true });
          console.log("PASS", engine, viewport.width, state);
        }
      }
    }
    // Both responsive rules must select the current asset at their exact boundaries.
    for (const width of [1023, 1024]) {
      await capture(engine, { width, height: 1000 }, true, "/Movie-log/");
      console.log("PASS", engine, width, "responsive mask boundary");
    }
    await browser.close(); browser = null;
  }
  assert.equal(rejectedExternal, 0);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ results, mockedRequests, rejectedExternal, productionRequests: 0, fonts: "Remote fonts blocked; same fallback fonts on both sides" }, null, 2));
  console.log("COMPLETE", results.length, "screenshot pairs within 1/255 rounding tolerance; 4 responsive boundary checks; production requests: 0");
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
});
