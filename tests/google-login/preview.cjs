// Local design preview only. Auth is disabled; CSP blocks external resources.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const tailwind = process.env.MOVIE_LOG_TEST_TAILWIND;
assert(tailwind && fs.statSync(tailwind).isFile(), "Set MOVIE_LOG_TEST_TAILWIND to a local Tailwind bundle");
const fontDir = process.env.MOVIE_LOG_TEST_FONTS;
const manifest = fontDir ? JSON.parse(fs.readFileSync(path.join(fontDir, "manifest.json"), "utf8")) : {};
const fontFiles = new Set(Object.values(manifest));
const port = Number(process.env.MOVIE_LOG_PREVIEW_PORT || 8787);
assert(Number.isInteger(port) && port >= 0 && port <= 65535, "Invalid local port");

const mockAuth = `
  window.supabase = { createClient() { return { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithOAuth: async () => ({ data: null, error: { status: 400 } }),
    signInWithPassword: async () => ({ data: null, error: { status: 400 } }),
    signUp: async () => ({ data: null, error: { status: 400 } }),
    signOut: async () => ({ error: null }),
  }}; }};
  const previewMessage = () => {
    const message = document.getElementById('authMessage');
    message.textContent = 'デザイン確認用の画面です。実際の認証・登録は行いません。';
    message.dataset.kind = 'success'; message.hidden = false;
  };
  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'authForm') return;
    event.preventDefault(); event.stopImmediatePropagation(); previewMessage();
  }, true);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#authGoogleBtn')) return;
    event.preventDefault(); event.stopImmediatePropagation(); previewMessage();
  }, true);
`;

function html() {
  return fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/const projectUrl = "[^"]+";/, 'const projectUrl = "http://127.0.0.1/preview-auth-disabled";')
    .replace(/const publishableKey = "[^"]+";/, 'const publishableKey = "preview-disabled";')
    .replace(/<link\b[^>]*rel="preconnect"[^>]*>/gi, "")
    .replace(/href="(https:\/\/fonts.googleapis.com\/[^\"]+)"/g, (_, url) => `href="/__preview/font-css/${encodeURIComponent(manifest[url] || 'empty.css')}"`)
    .replace('src="https://cdn.tailwindcss.com"', 'src="/__preview/tailwind.js"')
    .replace(/src="https:\/\/cdn.jsdelivr.net\/npm\/@supabase\/supabase-js@[^\"]+"/, 'src="/__preview/auth-disabled.js"')
    .replace('<title>Movie Log</title>', '<title>Movie Log — ローカルデザイン確認・認証なし</title>');
}

const server = http.createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  const send = (type, body) => { response.setHeader("Content-Type", type); response.end(body); };
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); return response.end(); }
    if (pathname === "/" || pathname === "/index.html") return send("text/html; charset=utf-8", html());
    if (pathname === "/__preview/auth-disabled.js") return send("application/javascript", mockAuth);
    if (pathname === "/__preview/tailwind.js") return send("application/javascript", fs.readFileSync(tailwind));
    if (pathname.startsWith("/__preview/font-css/")) {
      const name = pathname.slice("/__preview/font-css/".length);
      if (name === "empty.css") return send("text/css", "");
      if (fontFiles.has(name) && name.endsWith(".css") && path.basename(name) === name) {
        let css = fs.readFileSync(path.join(fontDir, name), "utf8");
        for (const [url, file] of Object.entries(manifest)) css = css.split(url).join("/__preview/font/" + encodeURIComponent(file));
        return send("text/css", css);
      }
    }
    if (pathname.startsWith("/__preview/font/")) {
      const name = pathname.slice("/__preview/font/".length);
      if (fontFiles.has(name) && path.basename(name) === name) return send("font/woff2", fs.readFileSync(path.join(fontDir, name)));
    }
    if (pathname.startsWith("/assets/")) {
      const file = path.resolve(root, "." + pathname);
      if (file.startsWith(path.join(root, "assets") + path.sep) && fs.statSync(file).isFile()) {
        const type = { ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(file)];
        if (type) return send(type, fs.readFileSync(file));
      }
    }
  } catch (_) { /* Return no filesystem paths or source details. */ }
  response.writeHead(404); response.end();
});
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? "指定ポートは使用中です。既存サーバーは変更しません。" : "ローカル確認サーバーを開始できませんでした。");
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Local design preview: http://127.0.0.1:${server.address().port}/`);
  console.log("認証・登録なし。外部接続はCSPで制限。Ctrl+Cでこの確認サーバーだけを停止します。");
});
