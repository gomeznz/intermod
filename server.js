// Zero-dependency static server for Railway (or anywhere with Node >= 18).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MOUNTS = { "/data/": path.join(root, "data"), "/": path.join(root, "public") };
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const cache = new Map(); // path -> { raw, gz, mtime }

function load(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const entry = { raw, gz: zlib.gzipSync(raw, { level: 9 }), mtime: st.mtimeMs, etag: `"${st.size}-${Math.round(st.mtimeMs)}"` };
  cache.set(file, entry);
  return entry;
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const mount = Object.keys(MOUNTS).find((m) => pathname.startsWith(m));
  const base = MOUNTS[mount];
  const file = path.normalize(path.join(base, pathname.slice(mount.length)));
  if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  const e = load(file);
  const headers = {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "cache-control": mount === "/data/" ? "public, max-age=86400" : "no-cache",
    etag: e.etag,
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
  };
  if (req.headers["if-none-match"] === e.etag) { res.writeHead(304, headers); return res.end(); }
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (gzip) headers["content-encoding"] = "gzip";
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : gzip ? e.gz : e.raw);
}).listen(PORT, () => console.log(`intermod listening on :${PORT}`));
