// 准备可分发后端：resources/backend
// 1) 独立安装 @deepseek-ai/dsh 运行时依赖（--omit=dev，干净依赖树）
// 2) 复制一个 node.exe（优先系统 node）
// 用法: node scripts/prepare-backend.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync } from "node:fs";
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