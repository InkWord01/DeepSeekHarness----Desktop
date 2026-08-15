// wcs-mirror.mjs — 本地 winCodeSign 镜像代理
// /winCodeSign-<ver>/winCodeSign-<ver>.7z -> 本地修复版；其他 -> GitHub 原始下载
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const PORT = 18765;
const LOCAL_ARCHIVE = "D:\\dsHarness\\dsh-desktop\\winCodeSign-2.6.0.7z";
const GH_BASE = "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url || "/");
  const m = urlPath.match(/\/winCodeSign-[^/]+\.7z$/);
  if (m) {
    // 提供本地修复版
    fs.readFile(LOCAL_ARCHIVE, (err, data) => {
      if (err) { res.writeHead(500); res.end("local archive missing: " + err.message); return; }
      res.writeHead(200, { "Content-Type": "application/x-7z-compressed", "Content-Length": data.length });
      res.end(data);
    });
    return;
  }
  // 其他请求转发到 GitHub
  const ghUrl = GH_BASE + urlPath.replace(/^\//, "");
  https.get(ghUrl, (up) => {
    const headers = { ...up.headers };
    delete headers["transfer-encoding"];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
  }).on("error", (e) => { res.writeHead(502); res.end("proxy error: " + e.message); });
});

server.listen(PORT, "127.0.0.1", () => console.log("wcs-mirror listening on " + PORT));