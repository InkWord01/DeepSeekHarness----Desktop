// 准备可分发后端：resources/backend
// 1) 独立安装 @deepseek-ai/dsh 运行时依赖（--omit=dev，干净依赖树）
// 2) 复制一个 node.exe（优先系统 node）
// 用法: node scripts/prepare-backend.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";

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
  return Math.round(total / 1e6 * 10) / 10;
}
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BACKEND = join(ROOT, "resources", "backend");
const DSH_VERSION = process.env.DSH_VERSION || "^0.1.0-rc.6";

function run(cmd, args, opts = {}) {
  // Windows 上 .cmd 不能直接被 spawn，包一层 cmd /c
  const finalCmd = process.platform === "win32" && cmd.endsWith(".cmd") ? "cmd" : cmd;
  const finalArgs = process.platform === "win32" && cmd.endsWith(".cmd") ? ["/c", cmd, ...args] : args;
  console.log(">", finalCmd, finalArgs.join(" "));
  execFileSync(finalCmd, finalArgs, { stdio: "inherit", ...opts });
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
console.log("[1/3] 安装 dsh 运行时依赖（--omit=dev）...");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
run(npmCmd, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--no-lockfile"], { cwd: BACKEND });


// ---- 1.5) 裁剪多平台二进制（只保留 win32-x64，大幅减小安装包） ----
const NM = join(BACKEND, "node_modules");
console.log("");
console.log("[1.5/3] 裁剪多平台二进制（保留 win32-x64）...");
const kept = [];
const removed = [];

// node-pty: 只保留 win32-x64 prebuild
const ptyPrebuilds = join(NM, "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const d of readdirSync(ptyPrebuilds, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== "win32-x64") {
      const sz = dirSize(join(ptyPrebuilds, d.name));
      rmSync(join(ptyPrebuilds, d.name), { recursive: true, force: true });
      removed.push("node-pty/prebuilds/" + d.name + " (" + sz + " MB)");
    }
  }
  kept.push("node-pty/prebuilds/win32-x64");
}

// @img/sharp: 只保留 win32-x64（去掉 wasm32 等）
const imgDir = join(NM, "@img");
if (existsSync(imgDir)) {
  for (const d of readdirSync(imgDir, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.includes("win32-x64")) {
      const sz = dirSize(join(imgDir, d.name));
      rmSync(join(imgDir, d.name), { recursive: true, force: true });
      removed.push("@img/" + d.name + " (" + sz + " MB)");
    }
  }
}

// node-pty build 目录里的非 win32 产物
const ptyBuild = join(NM, "node-pty", "build", "Release");
if (existsSync(join(ptyBuild, "conpty"))) {
  // conpty 是 win32 专用，保留
}

// @vscode/ripgrep: 只保留 win32-x64
const rgDir = join(NM, "@vscode");
if (existsSync(rgDir)) {
  for (const d of readdirSync(rgDir, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.includes("win32-x64")) {
      const sz = dirSize(join(rgDir, d.name));
      rmSync(join(rgDir, d.name), { recursive: true, force: true });
      removed.push("@vscode/" + d.name + " (" + sz + " MB)");
    }
  }
}

console.log("  保留: " + kept.join(", "));
if (removed.length > 0) {
  console.log("  移除:");
  for (const r of removed) console.log("    - " + r);
} else {
  console.log("  无可移除项");
}

// ---- 2) node.exe ----
console.log("");
console.log("[2/3] 准备 node.exe ...");
const sysNode = process.execPath;
const targetNode = join(BACKEND, "node.exe");
copyFileSync(sysNode, targetNode);
console.log("已复制系统 node.exe ->", targetNode, "(" + (statSync(targetNode).size / 1e6).toFixed(1) + " MB)");

// ---- 3) 写元信息 ----
writeFileSync(join(BACKEND, "backend.info.json"), JSON.stringify({
  dsh: DSH_VERSION,
  node: process.versions.node,
  preparedAt: new Date().toISOString()
}, null, 2));

// ---- 校验 ----
const dshBin = join(BACKEND, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!existsSync(dshBin)) {
  console.error("ERROR: 未找到", dshBin);
  process.exit(1);
}
console.log("");
console.log("[3/3] 完成");
console.log("  后端入口:", dshBin);
console.log("  node.exe:", targetNode);
console.log("  元信息:", join(BACKEND, "backend.info.json"));