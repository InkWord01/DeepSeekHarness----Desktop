// 准备可分发后端：resources/backend
// 1) 独立安装 @deepseek-ai/dsh 运行时依赖（--omit=dev，干净依赖树，按目标架构）
// 2) 复制/下载对应架构的 node.exe
// 用法: node scripts/prepare-backend.mjs [--arch x64|arm64]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, readdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BACKEND = join(ROOT, "resources", "backend");
const DSH_VERSION = process.env.DSH_VERSION || "^0.1.0-rc.6";

// ---- 解析架构参数 ----
const archArg = process.argv.find((a) => a.startsWith("--arch=")) || process.argv[process.argv.indexOf("--arch") + 1];
const TARGET_ARCH = archArg || "x64"; // x64 | arm64
if (!["x64", "arm64"].includes(TARGET_ARCH)) {
  console.error("ERROR: 不支持的架构: " + TARGET_ARCH + "（仅支持 x64 / arm64）");
  process.exit(1);
}
const NODE_VERSION = process.versions.node;
console.log("目标架构: " + TARGET_ARCH + "，Node 版本: " + NODE_VERSION);

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += statSync(full).size;
    }
  };
  walk(dir);
  return Math.round((total / 1e6) * 10) / 10;
}

function run(cmd, args, opts = {}) {
  const finalCmd = process.platform === "win32" && cmd.endsWith(".cmd") ? "cmd" : cmd;
  const finalArgs = process.platform === "win32" && cmd.endsWith(".cmd") ? ["/c", cmd, ...args] : args;
  console.log(">", finalCmd, finalArgs.join(" "));
  execFileSync(finalCmd, finalArgs, { stdio: "inherit", ...opts });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "dsh-desktop-build" } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error("下载失败 HTTP " + res.statusCode + ": " + url));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    });
    req.on("error", (e) => { file.close(); reject(e); });
  });
}

// ---- 1) 清理并重建 backend 目录 ----
rmSync(BACKEND, { recursive: true, force: true });
mkdirSync(BACKEND, { recursive: true });
writeFileSync(join(BACKEND, "package.json"), JSON.stringify({
  name: "dsh-desktop-backend",
  private: true,
  dependencies: { "@deepseek-ai/dsh": DSH_VERSION }
}, null, 2));

console.log("");
console.log("[1/4] 安装 dsh 运行时依赖（--omit=dev, --cpu=" + TARGET_ARCH + "）...");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
run(npmCmd, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--no-lockfile", "--cpu=" + TARGET_ARCH, "--os=win32"], { cwd: BACKEND });

// ---- 2) 裁剪多平台二进制（只保留目标架构） ----
const NM = join(BACKEND, "node_modules");
console.log("");
console.log("[2/4] 裁剪多平台二进制（保留 win32-" + TARGET_ARCH + "）...");
const kept = [];
const removed = [];
const ARCH_TAG = "win32-" + TARGET_ARCH;

// node-pty: 只保留目标架构 prebuild
const ptyPrebuilds = join(NM, "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const d of readdirSync(ptyPrebuilds, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== ARCH_TAG) {
      const sz = dirSize(join(ptyPrebuilds, d.name));
      rmSync(join(ptyPrebuilds, d.name), { recursive: true, force: true });
      removed.push("node-pty/prebuilds/" + d.name + " (" + sz + " MB)");
    }
  }
  kept.push("node-pty/prebuilds/" + ARCH_TAG);
}

// @img/sharp: 只保留目标架构
const imgDir = join(NM, "@img");
if (existsSync(imgDir)) {
  for (const d of readdirSync(imgDir, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.includes(ARCH_TAG)) {
      const sz = dirSize(join(imgDir, d.name));
      rmSync(join(imgDir, d.name), { recursive: true, force: true });
      removed.push("@img/" + d.name + " (" + sz + " MB)");
    }
  }
  kept.push("@img/" + (readdirSync(imgDir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).join(", ")));
}

// @vscode/ripgrep: 只保留目标架构
const rgDir = join(NM, "@vscode");
if (existsSync(rgDir)) {
  for (const d of readdirSync(rgDir, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.includes(ARCH_TAG)) {
      const sz = dirSize(join(rgDir, d.name));
      rmSync(join(rgDir, d.name), { recursive: true, force: true });
      removed.push("@vscode/" + d.name + " (" + sz + " MB)");
    }
  }
  kept.push("@vscode/" + (readdirSync(rgDir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).join(", ")));
}

console.log("  保留: " + kept.join(", "));
if (removed.length > 0) {
  console.log("  移除:");
  for (const r of removed) console.log("    - " + r);
} else {
  console.log("  无可移除项");
}

// ---- 3) node.exe（x64 复制系统，arm64 下载） ----
console.log("");
console.log("[3/4] 准备 node.exe (" + TARGET_ARCH + ") ...");
const targetNode = join(BACKEND, "node.exe");
if (TARGET_ARCH === "x64") {
  const sysNode = process.execPath;
  copyFileSync(sysNode, targetNode);
  console.log("已复制系统 node.exe ->", targetNode, "(" + (statSync(targetNode).size / 1e6).toFixed(1) + " MB)");
} else {
  // arm64: 从 nodejs.org 下载
  const zipName = "node-v" + NODE_VERSION + "-win-arm64.zip";
  const url = "https://nodejs.org/dist/v" + NODE_VERSION + "/" + zipName;
  const zipPath = join(ROOT, "resources", zipName);
  console.log("下载 " + url + " ...");
  await download(url, zipPath);
  console.log("下载完成，解压提取 node.exe ...");
  run(join(ROOT, "node_modules", "7zip-bin", "win", "x64", "7za.exe"), ["x", zipPath, "-y", "-o" + join(ROOT, "resources", "node-extract"), "node-v" + NODE_VERSION + "-win-arm64/node.exe"]);
  copyFileSync(join(ROOT, "resources", "node-extract", "node-v" + NODE_VERSION + "-win-arm64", "node.exe"), targetNode);
  rmSync(join(ROOT, "resources", "node-extract"), { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  console.log("已安装 arm64 node.exe ->", targetNode, "(" + (statSync(targetNode).size / 1e6).toFixed(1) + " MB)");
}

// ---- 4) 写元信息与校验 ----
writeFileSync(join(BACKEND, "backend.info.json"), JSON.stringify({
  dsh: DSH_VERSION,
  node: NODE_VERSION,
  arch: TARGET_ARCH,
  preparedAt: new Date().toISOString()
}, null, 2));

const dshBin = join(BACKEND, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!existsSync(dshBin)) {
  console.error("ERROR: 未找到", dshBin);
  process.exit(1);
}
console.log("");
console.log("[4/4] 完成 (" + TARGET_ARCH + ")");
console.log("  后端入口:", dshBin);
console.log("  node.exe:", targetNode);
console.log("  元信息:", join(BACKEND, "backend.info.json"));