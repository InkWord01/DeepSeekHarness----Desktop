// afterPack.js — electron-builder afterPack 钩子
// 用 rcedit 给 exe 设置图标与版本信息（signAndEditExecutable=false 时的补偿）
"use strict";
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "win32") return;
  const exePath = path.join(appOutDir, packager.appInfo.productFilename + ".exe");
  const rcedit = path.join(__dirname, "..", "build", "tools", "rcedit-x64.exe");
  const icon = path.join(__dirname, "..", "build", "icon.ico");
  if (!fs.existsSync(rcedit)) { console.warn("[afterPack] rcedit not found, skip icon"); return; }
  if (!fs.existsSync(exePath)) { console.warn("[afterPack] exe not found:", exePath); return; }
  const version = packager.appInfo.version;
  const args = [exePath, "--set-icon", icon, "--set-version-string", "ProductName", "DeepSeek Harness Desktop", "--set-version-string", "FileDescription", "DeepSeek Harness 桌面客户端", "--set-version-string", "CompanyName", "DeepSeek", "--set-product-version", version, "--set-file-version", version];
  try {
    execFileSync(rcedit, args, { stdio: "pipe" });
    console.log("[afterPack] icon + version set:", exePath);
  } catch (e) {
    console.warn("[afterPack] rcedit failed:", e.message);
  }
};