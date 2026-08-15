// DeepSeek Harness Desktop - Electron main process
// 职责：单实例锁 → 探测/启动 DSH 后端 → 等待就绪 → 加载 UI → 托盘与生命周期管理
"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn, execFile } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080); // 默认 3080；环境变量可覆盖（测试/多开用）
const DSH_BOOT_MARKER = "__DSH_BOOT__"; // dsh web 注入 window 的标识，用于识别 DSH 页面
const IS_PACKAGED = app.isPackaged;

// ---------- 语言 ----------
// 根据系统语言选择界面文案（zh-CN / en）
const UI_LANG = (app.getLocale() || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
const I18N = {
  zh: {
    splashTitle: "DeepSeek Harness Desktop",
    splashSub: "正在启动 DSH 后端，请稍候…",
    trayTooltip: "DeepSeek Harness Desktop",
    trayShow: "显示主窗口",
    trayQuit: "退出",
    updateBalloonTitle: "官方 DSH 有新版本",
    updateBalloonContent: (latest, bundled) => `官方 DSH 已更新至 ${latest}（当前内置 ${bundled}）。\n桌面端可同步更新，详见 GitHub Releases。`,
    updTitle: "发现新版本",
    updMessage: (v) => `DeepSeek Harness Desktop ${v} 可用`,
    updDetail: "是否现在下载更新？下载完成后退出应用时自动安装。",
    updBtnDownload: "下载更新",
    updBtnLater: "以后再说",
    updDownloadedMsg: (v) => `${v} 已下载完成`,
    updDownloadedDetail: "退出应用时将自动安装新版本。",
    updBtnRestart: "立即重启更新",
    updBtnSoon: "稍后"
  },
  en: {
    splashTitle: "DeepSeek Harness Desktop",
    splashSub: "Starting DSH backend, please wait…",
    trayTooltip: "DeepSeek Harness Desktop",
    trayShow: "Show Window",
    trayQuit: "Quit",
    updateBalloonTitle: "Official DSH has a new version",
    updateBalloonContent: (latest, bundled) => `Official DSH updated to ${latest} (bundled: ${bundled}).\nSync the desktop client from GitHub Releases.`,
    updTitle: "Update Available",
    updMessage: (v) => `DeepSeek Harness Desktop ${v} is available`,
    updDetail: "Download now? It will install automatically when you quit the app.",
    updBtnDownload: "Download Update",
    updBtnLater: "Later",
    updDownloadedMsg: (v) => `${v} downloaded`,
    updDownloadedDetail: "It will install when you quit the app.",
    updBtnRestart: "Restart & Update",
    updBtnSoon: "Later"
  }
};
const T = I18N[UI_LANG];

let mainWindow = null;
let tray = null;
let backend = null; // { mode: "reuse" | "spawned", port, child?, logPath }
let isQuitting = false;
let backendReady = false;

// ---------- 单实例锁 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------- 后端定位 ----------
function resolveBackendPaths() {
  if (IS_PACKAGED) {
    const base = path.join(process.resourcesPath, "backend");
    return {
      node: path.join(base, "node.exe"),
      dshBin: path.join(base, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      base
    };
  }
  // 开发模式：项目 node_modules（npm i 后自带 @deepseek-ai/dsh）
  const base = path.join(__dirname, "..");
  return {
    node: process.env.DSH_DESKTOP_NODE || (process.platform === "win32" ? "node.exe" : "node"),
    dshBin: path.join(base, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    base
  };
}

// ---------- HTTP 探测（支持 http/https） ----------
const https = require("node:https");
function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host, timeout: 800 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

async function findFreePort(startPort) {
  let port = startPort;
  while (port < startPort + 200) {
    if (!(await isPortOpen(port))) return port;
    port++;
  }
  return 0; // 让后端自己挑（理论上不会到这）
}

// ---------- 后端生命周期 ----------
function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    // 先温和终止，再强制杀进程树
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function waitForBackend(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpGet(`http://127.0.0.1:${port}/`, 1200);
    if (res && res.status === 200 && res.body.includes(DSH_BOOT_MARKER)) return true;
    // 页面可能在构建中，先等端口通
    if (res && res.status !== undefined) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function probeExistingDSH() {
  const res = await httpGet(`http://127.0.0.1:${DEFAULT_PORT}/`, 1200);
  if (res && res.status === 200) {
    const looksLikeDSH = res.body.includes(DSH_BOOT_MARKER);
    if (looksLikeDSH) return DEFAULT_PORT;
    // 端口有服务但不是 DSH —— 不能复用
    return null;
  }
  return null;
}

async function startBackend() {
  const paths = resolveBackendPaths();
  if (!fs.existsSync(paths.dshBin)) {
    throw new Error(`未找到 DSH 后端入口: ${paths.dshBin}\n请先运行: npm install（开发模式）或重新安装应用（打包模式）`);
  }

  // 1) 先探测 3080 是否已有 DSH 实例在跑（复用，避免双后端写同一 DSH_HOME）
  const existing = await probeExistingDSH();
  if (existing) {
    backend = { mode: "reuse", port: existing };
    console.log(`[dsh-desktop] 复用已有 DSH 实例: http://127.0.0.1:${existing}`);
    return backend;
  }

  // 2) 自己启动一个后端
  const port = await findFreePort(DEFAULT_PORT);
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "backend.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n===== ${new Date().toISOString()} dsh backend start (port ${port}) =====\n`);

  const child = spawn(paths.node, [paths.dshBin, "web", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: os.homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  backend = { mode: "spawned", port, child, logPath, logStream };
  console.log(`[dsh-desktop] 启动 DSH 后端 (pid=${child.pid}) 于端口 ${port}，日志: ${logPath}`);

  child.on("exit", (code, signal) => {
    console.log(`[dsh-desktop] 后端进程退出 code=${code} signal=${signal}`);
    if (backend && backend.mode === "spawned" && !isQuitting) {
      // 后端意外退出：尝试通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend-status", { ok: false, port: backend.port });
      }
    }
  });

  const ready = await waitForBackend(port);
  if (!ready) {
    console.error("[dsh-desktop] 后端未能就绪，日志尾部：");
    try {
      const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-25).join("\n");
      console.error(tail);
    } catch {}
    throw new Error(`DSH 后端在 ${port} 端口未能在 60s 内就绪，请查看日志: ${logPath}`);
  }
  console.log(`[dsh-desktop] DSH 后端就绪: http://127.0.0.1:${port}`);
  backendReady = true;
  return backend;
}

async function stopBackend() {
  isQuitting = true;
  if (backend && backend.mode === "spawned") {
    const pid = backend.child && backend.child.pid;
    console.log(`[dsh-desktop] 停止自启后端 pid=${pid}`);
    try { backend.child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    await killProcessTree(pid);
    try { backend.logStream && backend.logStream.end(); } catch {}
  }
  backend = null;
}

// ---------- 窗口 ----------
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "DeepSeek Harness Desktop",
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    icon: IS_PACKAGED ? undefined : path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.loadURL(url);

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http://") || u.startsWith("https://")) shell.openExternal(u);
    return { action: "deny" };
  });
  // 新链接在系统浏览器打开
  mainWindow.webContents.on("will-navigate", (e, u) => {
    const base = `http://127.0.0.1:${backend ? backend.port : DEFAULT_PORT}`;
    if (!u.startsWith(base)) { e.preventDefault(); shell.openExternal(u); }
  });
}

// ---------- 托盘 ----------
function createTray() {
  const iconPath = IS_PACKAGED
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "..", "build", "icon.png");
  let icon = null;
  try { icon = nativeImage.createFromPath(iconPath); } catch {}
  if (!icon || icon.isEmpty()) {
    // 生成 1x1 占位图标
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(T.trayTooltip);
  const menu = Menu.buildFromTemplate([
    { label: T.trayShow, click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: "separator" },
    { label: T.trayQuit, click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ---------- IPC ----------
ipcMain.handle("app-info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  port: backend ? backend.port : null,
  mode: backend ? backend.mode : null,
  packaged: IS_PACKAGED
}));

// ---------- 启动加载窗口 ----------
let splashWindow = null;
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0f1115;color:#e5e7eb;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden}
    .logo{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#10b981);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff;animation:pulse 1.6s ease-in-out infinite}
    @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.06);opacity:.85}}
    .title{font-size:15px;font-weight:600}
    .sub{font-size:12px;color:#9ca3af}
    .bar{width:200px;height:4px;border-radius:2px;background:#1f2937;overflow:hidden}
    .bar i{display:block;height:100%;width:40%;border-radius:2px;background:linear-gradient(90deg,#2563eb,#10b981);animation:slide 1.2s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
  </style></head><body>
    <div class="logo">DSH</div>
    <div class="title">${T.splashTitle}</div>
    <div class="sub">${T.splashSub}</div>
    <div class="bar"><i></i></div>
  </body></html>`;
  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  splashWindow.once("ready-to-show", () => splashWindow.show());
}


// ---------- 自动更新 ----------
const GITHUB_REPO = "InkWord01/DeepSeekHarness----Desktop";
let updateChecked = false;

// 官方 DSH 版本检查（npm registry）
async function checkOfficialDshVersion() {
  try {
    const res = await httpGet("https://registry.npmjs.org/@deepseek-ai/dsh/latest", 5000);
    if (res && res.status === 200) {
      const data = JSON.parse(res.body);
      const latest = data.version;
      const bundled = readBundledDshVersion();
      if (bundled && latest && bundled !== latest && !isNewer(bundled, latest)) {
        console.log(`[dsh-desktop] 官方 DSH 新版本可用: ${latest} (当前内置: ${bundled})`);
        // 通过托盘提示（不打扰主界面）
        if (tray) {
          tray.displayBalloon({
            iconType: "info",
            title: T.updateBalloonTitle,
            content: T.updateBalloonContent(latest, bundled)
          });
        }
      }
    }
  } catch (e) {
    console.log("[dsh-desktop] 版本检查失败:", e.message);
  }
}

function isNewer(a, b) {
  // 简单语义化比较: a >= b 返回 true
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

function readBundledDshVersion() {
  try {
    const paths = resolveBackendPaths();
    const pkgPath = path.join(paths.base, "node_modules", "@deepseek-ai", "dsh", "package.json");
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    }
  } catch {}
  return null;
}

function setupAutoUpdate() {
  if (!IS_PACKAGED) return;
  autoUpdater.autoDownload = false; // 只提示，不自动下载（用户选择）
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    console.log("[dsh-desktop] 桌面端新版本可用:", info.version);
    const choice = dialog.showMessageBoxSync({
      type: "info",
      title: T.updTitle,
      message: T.updMessage(info.version),
      detail: T.updDetail,
      buttons: [T.updBtnDownload, T.updBtnLater],
      defaultId: 0
    });
    if (choice === 0) {
      autoUpdater.downloadUpdate();
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    const choice = dialog.showMessageBoxSync({
      type: "info",
      title: "Update",
      message: T.updDownloadedMsg(info.version),
      detail: T.updDownloadedDetail,
      buttons: [T.updBtnRestart, T.updBtnSoon],
      defaultId: 0
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (e) => console.log("[dsh-desktop] 更新检查失败:", e.message));
  // 启动 10 秒后检查（避免与后端启动抢资源）
  setTimeout(() => {
    if (updateChecked) return;
    updateChecked = true;
    autoUpdater.checkForUpdates().catch((e) => console.log("[dsh-desktop] 更新检查异常:", e.message));
  }, 10000);
}

// ---------- 应用生命周期 ----------
app.whenReady().then(async () => {
  let url;
  setupAutoUpdate();
  setTimeout(checkOfficialDshVersion, 15000); // 启动 15 秒后检查官方版本
  createSplash(); // 先显示启动画面，后端就绪后切换主窗口
  try {
    const b = await startBackend();
    url = `http://127.0.0.1:${b.port}/`;
  } catch (err) {
    console.error("[dsh-desktop] 启动失败:", err.message);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
    const dialog = require("electron").dialog;
    await dialog.showMessageBox({
      type: "error",
      title: "DeepSeek Harness 启动失败",
      message: "无法启动 DSH 后端",
      detail: String(err.message),
      buttons: ["退出"]
    });
    app.quit();
    return;
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
  createWindow(url);
  createTray();
});

// 关窗 → 最小化到托盘（后端继续跑）
app.on("window-all-closed", () => {
  // 不退出：托盘常驻，后端继续服务；用户从托盘"退出"才真正退出
});
app.on("before-quit", (e) => {
  if (!isQuitting) {
    e.preventDefault();
    stopBackend().finally(() => { app.exit(0); });
  }
});
app.on("activate", () => {
  if (mainWindow) mainWindow.show();
});