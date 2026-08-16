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

// 开发模式（npm run dev）使用独立 userData：避免与已安装版共享单实例锁/缓存而互踢
if (!app.isPackaged && process.argv.includes("--dev")) {
  app.setPath("userData", path.join(app.getPath("userData"), "..", "dsh-desktop-dev"));
}
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
    updBtnSoon: "稍后",
    closeTitle: "关闭 DeepSeek Harness Desktop",
    closeMessage: "关闭窗口时希望怎么处理？",
    closeDetail: "最小化到托盘：应用与 DSH 后端继续在后台运行；直接退出：停止后端并完全退出应用。",
    btnTray: "最小化到托盘",
    btnQuit: "直接退出",
    btnCancel: "取消",
    closeRemember: "记住我的选择，下次不再询问",
    trayCloseBehavior: "关闭窗口时",
    trayCloseAsk: "每次询问",
    trayCloseTray: "最小化到托盘",
    trayCloseQuit: "直接退出"
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
    updBtnSoon: "Later",
    closeTitle: "Close DeepSeek Harness Desktop",
    closeMessage: "What should happen when the window is closed?",
    closeDetail: "Minimize to tray: app and DSH backend keep running in the background. Quit: stop the backend and exit completely.",
    btnTray: "Minimize to Tray",
    btnQuit: "Quit",
    btnCancel: "Cancel",
    closeRemember: "Remember my choice and don't ask again",
    trayCloseBehavior: "On window close",
    trayCloseAsk: "Ask every time",
    trayCloseTray: "Minimize to tray",
    trayCloseQuit: "Quit"
  }
};
const T = I18N[UI_LANG];

let mainWindow = null;
let tray = null;
let backend = null; // { mode: "reuse" | "spawned", port, child?, logPath }
let isQuitting = false;
let backendReady = false;
let quitRequested = false; // 退出只请求一次（防 close 事件链递归）

function requestQuit() {
  if (quitRequested) return;
  quitRequested = true;
  app.quit();
}

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

// ---------- Node 运行时解析（支持 Lite 包：无捆绑 node.exe 时回退系统 Node） ----------
const MIN_NODE_MAJOR = 22; // dsh 动态加载 TS 插件依赖 strip-type 特性（Node 22.6+），捆绑版本为 23.x

function resolveNodeBin(paths) {
  // 1) 捆绑的 node.exe（完整版）
  if (fs.existsSync(paths.node)) return paths.node;
  // 2) 显式指定（环境变量）
  if (process.env.DSH_DESKTOP_NODE) return process.env.DSH_DESKTOP_NODE;
  // 3) 系统 PATH 上的 node（Lite 包）
  return process.platform === "win32" ? "node.exe" : "node";
}

function checkNodeVersion(nodeBin) {
  return new Promise((resolve) => {
    execFile(nodeBin, ["--version"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /v(\d+)\.(\d+)\.(\d+)/.exec(String(stdout || "").trim());
      resolve(m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: String(stdout).trim() } : null);
    });
  });
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
    // 只认 200（后端完全就绪）；5xx/4xx/连接失败都继续等待
    if (res && res.status === 200) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function probeExistingDSH() {
  // 健康校验：连续探测（实例可能正处于启动/退出中），只认 200 + 引导标记
  for (let i = 0; i < 3; i++) {
    const res = await httpGet(`http://127.0.0.1:${DEFAULT_PORT}/`, 1200);
    if (res && res.status === 200 && res.body.includes(DSH_BOOT_MARKER)) {
      return DEFAULT_PORT;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return null; // 无服务 / 服务非 DSH / 一直未就绪 —— 都不能复用
}

async function startBackend() {
  const paths = resolveBackendPaths();
  if (!fs.existsSync(paths.dshBin)) {
    throw new Error(`未找到 DSH 后端入口: ${paths.dshBin}\n请先运行: npm install（开发模式）或重新安装应用（打包模式）`);
  }

  // 解析 Node 运行时（完整版用捆绑 node.exe；Lite 版回退系统 Node）并校验版本
  const nodeBin = resolveNodeBin(paths);
  const nodeVer = await checkNodeVersion(nodeBin);
  if (!nodeVer) {
    throw new Error("未检测到可用的 Node.js 运行时。\n请安装 Node.js " + MIN_NODE_MAJOR + "+（https://nodejs.org），或下载包含 Node 的完整版安装包。");
  }
  if (nodeVer.major < MIN_NODE_MAJOR) {
    throw new Error("当前 Node.js 版本过低（" + nodeVer.raw + "），需要 Node.js " + MIN_NODE_MAJOR + "+。\n请升级 Node.js，或下载包含 Node 的完整版安装包。");
  }
  console.log("[dsh-desktop] Node 运行时: " + (fs.existsSync(paths.node) ? "bundled " : "system ") + nodeVer.raw);

  // 1) 先探测 3080 是否已有 DSH 实例在跑（复用，避免双后端写同一 DSH_HOME）
  const existing = await probeExistingDSH();
  if (existing) {
    backend = { mode: "reuse", port: existing };
    console.log(`[dsh-desktop] 复用已有 DSH 实例: http://127.0.0.1:${existing}`);
    startReuseWatchdog(); // C5: 复用的实例失联时自动切换为自启后端
    return backend;
  }

  // 2) 自己启动一个后端
  const port = await findFreePort(DEFAULT_PORT);
  if (!port) {
    throw new Error(`端口 ${DEFAULT_PORT}~${DEFAULT_PORT + 199} 全部被占用，无法启动 DSH 后端。\n请关闭占用这些端口的程序后重试。`);
  }
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "backend.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n===== ${new Date().toISOString()} dsh backend start (port ${port}) =====\n`);

  const child = spawn(nodeBin, [paths.dshBin, "web", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: os.homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  backend = { mode: "spawned", port, child, logPath, logStream };
  console.log(`[dsh-desktop] 启动 DSH 后端 (pid=${child.pid}) 于端口 ${port}，日志: ${logPath}`);

  child.on("exit", (code, signal) => onBackendExit(child, code, signal));

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


// ---- C3: 后端意外退出自动重启（指数退避 1s/2s/4s…封顶 30s，成功后自动恢复页面） ----
let backendRestartTimer = null;
let backendRestarting = false; // 防止重启过程中再次触发 spawn（竞态）

// C5: 复用实例健康看护 —— 失联（探测失败）即切换为自启后端并走自动重启
let reuseWatchdog = null;
function startReuseWatchdog() {
  stopReuseWatchdog();
  reuseWatchdog = setInterval(async () => {
    if (isQuitting || !backend || backend.mode !== "reuse") return;
    const res = await httpGet(`http://127.0.0.1:${backend.port}/`, 1200);
    const healthy = res && res.status === 200 && res.body.includes(DSH_BOOT_MARKER);
    if (healthy) return;
    console.log("[dsh-desktop] 复用的 DSH 实例失联，切换为自启后端");
    backend.mode = "spawned"; // 让自动重启路径接管（由我们 spawn 新进程）
    backendReady = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-status", { ok: false, port: backend.port });
    }
    scheduleBackendRestart(1);
  }, 5000);
}
function stopReuseWatchdog() {
  if (reuseWatchdog) { clearInterval(reuseWatchdog); reuseWatchdog = null; }
}

function onBackendExit(child, code, signal) {
  console.log(`[dsh-desktop] 后端进程退出 code=${code} signal=${signal}`);
  // 只处理"当前活跃后端"的退出（重启成功后旧进程的 exit 事件不再触发恢复）
  if (isQuitting || !backend || backend.mode !== "spawned" || backend.child !== child) return;
  backendReady = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("backend-status", { ok: false, port: backend.port });
  }
  scheduleBackendRestart(1);
}

function scheduleBackendRestart(attempt) {
  if (isQuitting || !backend || backend.mode !== "spawned") return;
  const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
  console.log(`[dsh-desktop] 后端将在 ${(delay / 1000).toFixed(0)}s 后重启（第 ${attempt} 次尝试）`);
  backendRestartTimer = setTimeout(() => doRestartBackend(attempt), delay);
}

async function doRestartBackend(attempt) {
  backendRestartTimer = null;
  if (backendRestarting) return; // 已有重启在进行（旧子进程退出事件可能在等待期间再次触发）
  backendRestarting = true;
  stopReuseWatchdog();
  if (isQuitting || !backend || backend.mode !== "spawned") { backendRestarting = false; return; }
  const oldPort = backend.port;
  try {
    // 旧进程可能还残留（未退干净）：先杀掉再起新进程，避免双后端争用 DSH_HOME
    try { if (backend.child) backend.child.kill(); } catch {}
    const port = await findFreePort(oldPort);
    if (!port) throw new Error("端口全部被占用");
    const paths = resolveBackendPaths();
    const nodeBin = resolveNodeBin(paths);
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "backend.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n===== ${new Date().toISOString()} dsh backend RESTART (port ${port}, attempt ${attempt}) =====\n`);
    const child = spawn(nodeBin, [paths.dshBin, "web", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: os.homedir(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    backend.child = child;
    backend.port = port;
    backend.logStream = logStream;
    console.log(`[dsh-desktop] 重启后端 (pid=${child.pid}) 于端口 ${port}`);
    child.on("exit", (code, signal) => onBackendExit(child, code, signal));
    const ready = await waitForBackend(port, 30000);
    if (!ready) throw new Error("后端未能在 30s 内就绪");
    backendReady = true;
    console.log(`[dsh-desktop] 后端重启成功: http://127.0.0.1:${port}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-status", { ok: true, port });
      // 无论端口是否变化都重载页面：前端的 RPC/WS 连接已随旧进程断开，重载重连（会话状态在 DSH_HOME 持久化）
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && backend && backend.port === port) {
          mainWindow.loadURL(`http://127.0.0.1:${port}/`);
        }
      }, 600);
    }
  } catch (err) {
    console.error("[dsh-desktop] 后端重启失败:", err.message);
    if (attempt >= 10) {
      console.error("[dsh-desktop] 连续 10 次重启失败，停止自动恢复（请退出应用后重试）");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend-status", { ok: false, fatal: true, port: backend.port });
      }
      return;
    }
    scheduleBackendRestart(attempt + 1);
  } finally {
    backendRestarting = false;
  }
}

async function stopBackend() {
  isQuitting = true;
  stopReuseWatchdog();
  if (backendRestartTimer) { clearTimeout(backendRestartTimer); backendRestartTimer = null; }
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

// ---------- 关闭行为（询问 / 记忆偏好 / 托盘） ----------
let closePref = null; // null=每次询问 | "tray" | "quit"

function closePrefFile() {
  return path.join(app.getPath("userData"), "close-preference.json");
}

function loadClosePref() {
  try {
    const data = JSON.parse(fs.readFileSync(closePrefFile(), "utf8"));
    if (data && (data.mode === "tray" || data.mode === "quit")) closePref = data.mode;
  } catch {}
}

function saveClosePref(mode) {
  closePref = mode;
  try {
    fs.writeFileSync(closePrefFile(), JSON.stringify({ mode, savedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.log("[dsh-desktop] 保存关闭偏好失败:", err.message);
  }
}

function hideToTray() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

async function handleWindowClose(e) {
  if (isQuitting) return; // 应用正在退出，放行默认行为
  if (closePref === "tray") { e.preventDefault(); hideToTray(); return; }
  if (closePref === "quit") { requestQuit(); return; }
  // 每次询问
  e.preventDefault();
  let result;
  try {
    result = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: T.closeTitle,
      message: T.closeMessage,
      detail: T.closeDetail,
      buttons: [T.btnTray, T.btnQuit, T.btnCancel],
      defaultId: 0,
      cancelId: 2, // Esc/取消 = 不做任何事（不隐藏、不退出、不保存偏好）
      noLink: true,
      checkboxLabel: T.closeRemember,
      checkboxChecked: false
    });
  } catch {
    hideToTray(); // 对话框异常时保守处理：最小化到托盘
    return;
  }
  if (result.response === 2) return; // 用户取消关闭：窗口保持原样
  if (result.checkboxChecked) saveClosePref(result.response === 0 ? "tray" : "quit");
  if (result.response === 0) hideToTray();
  else requestQuit();
}

// ---------- 标题栏（无边框 + 网页内自绘，颜色跟随 DSH 主题） ----------
const TITLEBAR_HEIGHT = 40;

// 窗口控制 IPC：自绘标题栏按钮 → 主进程
function registerWindowControlsIpc() {
  for (const ch of ["win-minimize", "win-maximize-toggle", "win-close", "win-is-maximized"]) {
    try { ipcMain.removeHandler(ch); } catch {}
  }
  ipcMain.handle("win-minimize", () => { mainWindow && mainWindow.minimize(); });
  ipcMain.handle("win-maximize-toggle", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("win-close", () => { mainWindow && mainWindow.close(); }); // 走 handleWindowClose（询问/偏好）
  ipcMain.handle("win-is-maximized", () => !!(mainWindow && mainWindow.isMaximized()));
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
    ...(process.platform === "win32" ? { frame: false } : {}), // Windows：无边框，标题栏由网页自绘（颜色完全跟随主题）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  // 关闭时按偏好处理（询问 / 托盘 / 退出）
  mainWindow.on("close", handleWindowClose);
  // 最大化状态推送：自绘标题栏更新图标（只挂一次，reload 不会累积）
  mainWindow.on("maximize", () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send("win-maximized-changed", true); });
  mainWindow.on("unmaximize", () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send("win-maximized-changed", false); });
  // 页面加载后注入桌面适配资源（独立文件，可单独语法检查，无模板字符串转义陷阱）
  const injectFile = (name) => fs.readFileSync(path.join(__dirname, "inject", name), "utf8");
  mainWindow.webContents.on("did-finish-load", () => {
    // 1) 样式（标题栏安全区 / 自绘标题栏 / 面板与设置弹窗适配 / 侧边栏修复）
    try {
      mainWindow.webContents.insertCSS(injectFile("styles.css").replaceAll("__TB_H__", String(TITLEBAR_HEIGHT)));
    } catch {}
    // 2) 自绘标题栏 DOM + 按钮事件
    mainWindow.webContents.executeJavaScript(injectFile("titlebar.js"))
      .then(() => console.log("[dsh-desktop] 自绘标题栏已注入"))
      .catch((err) => console.log("[TB-INJECT-ERR]", err.message));
    // 3) 页面适配器（面板对齐 / 设置弹窗居中 / rAF 节流 + mutation 过滤）
    mainWindow.webContents.executeJavaScript(injectFile("adapters.js").replaceAll("__TB_H__", String(TITLEBAR_HEIGHT)))
      .then(() => console.log("[dsh-desktop] 页面适配器已注入"))
      .catch((err) => console.log("[PANEL-FIX-ERR]", err.message));
  });

  mainWindow.loadURL(url);


  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http://") || u.startsWith("https://")) shell.openExternal(u);
    return { action: "deny" };
  });
  // 新链接在系统浏览器打开（严格同源校验：startsWith 前缀匹配可被 127.0.0.1:3080.evil.com 绕过）
  mainWindow.webContents.on("will-navigate", (e, u) => {
    const port = String(backend ? backend.port : DEFAULT_PORT);
    let allow = false;
    try {
      const parsed = new URL(u);
      allow = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && (parsed.port === port || (parsed.port === "" && port === "80"));
    } catch {}
    if (!allow) { e.preventDefault(); shell.openExternal(u); }
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

  // 独立构建函数：radio 状态始终按当前 closePref 渲染，切换后重建刷新
  const buildTrayMenu = () => {
    const mode = closePref || "ask";
    return Menu.buildFromTemplate([
      { label: T.trayShow, click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: "separator" },
      {
        label: T.trayCloseBehavior,
        submenu: [
          {
            label: T.trayCloseAsk, type: "radio", checked: mode === "ask",
            click: () => { closePref = null; try { fs.rmSync(closePrefFile(), { force: true }); } catch {}; tray.setContextMenu(buildTrayMenu()); }
          },
          {
            label: T.trayCloseTray, type: "radio", checked: mode === "tray",
            click: () => { saveClosePref("tray"); tray.setContextMenu(buildTrayMenu()); }
          },
          {
            label: T.trayCloseQuit, type: "radio", checked: mode === "quit",
            click: () => { saveClosePref("quit"); tray.setContextMenu(buildTrayMenu()); }
          }
        ]
      },
      { type: "separator" },
      { label: T.trayQuit, click: () => { requestQuit(); } }
    ]);
  };
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ---------- IPC ----------
registerWindowControlsIpc();

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
  loadClosePref(); // 读取记忆的关闭行为偏好
  registerWindowControlsIpc(); // 幂等：重复注册由 ipcMain 覆盖
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