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
      buttons: [T.btnTray, T.btnQuit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: T.closeRemember,
      checkboxChecked: false
    });
  } catch {
    hideToTray(); // 对话框异常时保守处理：最小化到托盘
    return;
  }
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
  // 页面加载后同步一次主题到标题栏；preload 观察器负责后续变化
  mainWindow.webContents.on("did-finish-load", () => {
    // 1) 标题栏安全区：DSH 页面顶部让出 TITLEBAR_HEIGHT（内容不被自绘标题栏遮挡）
    // 2) 自绘标题栏样式（颜色由 preload 观察器实时同步页面背景）
    // 3) 收起模式（rail）下底部按钮区：缩小按钮、拉直间距，避免插件按钮互相挤压/溢出
    try {
      mainWindow.webContents.insertCSS(`
      body > div:first-of-type { padding-top: ${TITLEBAR_HEIGHT}px !important; box-sizing: border-box !important; }
      /* ---- 自绘标题栏 ---- */
      #dsh-titlebar { position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_HEIGHT}px; z-index: 2147483646; display: flex; align-items: center; justify-content: space-between; -webkit-app-region: drag; user-select: none; }
      #dsh-titlebar .dsh-tb-title { padding-left: 14px; font-size: 12px; letter-spacing: .2px; opacity: .85; display: flex; align-items: center; gap: 7px; min-width: 0; pointer-events: none; }
      #dsh-titlebar .dsh-tb-title .dsh-tb-seg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
      #dsh-titlebar .dsh-tb-title .dsh-tb-sep { opacity: .45; flex: none; }
      #dsh-titlebar .dsh-tb-controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
      #dsh-titlebar .dsh-tb-btn { width: 46px; height: 100%; border: none; margin: 0; padding: 0; background: transparent; color: inherit; display: flex; align-items: center; justify-content: center; cursor: default; outline: none; }
      #dsh-titlebar .dsh-tb-btn:hover { background: rgba(128,128,128,.22); }
      #dsh-titlebar .dsh-tb-btn:active { background: rgba(128,128,128,.34); }
      #dsh-titlebar .dsh-tb-btn svg { width: 14px; height: 14px; }
      /* ---- 收起模式侧边栏底部按钮修复 ---- */
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] { gap: 0 !important; align-items: center !important; }
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] button,
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] [class*="us-nav"] {
        width: 24px !important; height: 24px !important;
        min-width: 24px !important; min-height: 24px !important;
        margin: 0 auto !important; padding: 0 !important;
        flex: 0 0 24px !important;
      }
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] [class*="footerActions"],
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] [class*="entryRow"] {
        flex-direction: column !important; width: 24px !important;
        margin: 0 !important; padding: 0 !important; gap: 0 !important;
      }
      [class*="hHd-Xa_collapsed"] [class*="hHd-Xa_footArea"] [class*="us-nav"] { margin-left: 0 !important; }
      /* 第三方侧边栏的悬浮收起/展开按钮（top≈3px）会与自绘标题栏重叠：下移到标题栏下方 */
      [class*="toggleCluster"], [class*="ToggleCluster"], [class*="floating-expand"] { top: 44px !important; }
      [class*="toggleCluster"] svg, [class*="ToggleCluster"] svg { width: 14px !important; height: 14px !important; }
      /* 右侧面板容器（CSS Modules 统一 _panel 后缀）：去掉左分隔线与阴影，消除与主内容的"隔阂" */
      [class$="_panel"], [class*="_panel "] { border-left: none !important; box-shadow: none !important; }
      /* 使用统计面板：彻底去除毛玻璃（禁 blur + 完全不透明背景；JS 会按 body 背景色覆盖 inline 样式） */
      [class*="us-shell"], [class*="us-shell"] * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background-blend-mode: normal !important; }
      [class*="us-shell"] { background-color: rgb(247, 248, 250) !important; }
      [class*="us-shell"] [class*="us-top"], [class*="us-shell"] [class*="us-scroll"] { background: transparent !important; }
      `);
    } catch {}
    // 注入自绘标题栏 DOM + 按钮事件
    mainWindow.webContents.executeJavaScript(`(() => {
      if (document.getElementById('dsh-titlebar')) return;
      const NS = 'http://www.w3.org/2000/svg';
      const icon = (d) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.2'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); return s; };
      const tb = document.createElement('div');
      tb.id = 'dsh-titlebar';
      const title = document.createElement('div');
      title.className = 'dsh-tb-title';
      title.innerHTML = '<span class="dsh-tb-seg" data-part="title"></span><span class="dsh-tb-sep" data-part="sep1">·</span><span class="dsh-tb-seg" data-part="mode" style="max-width:180px"></span><span class="dsh-tb-sep" data-part="sep2">·</span><span class="dsh-tb-seg" data-part="model" style="max-width:200px"></span>';
      const ctrl = document.createElement('div');
      ctrl.className = 'dsh-tb-controls';
      const mk = (act, d, tip) => { const b = document.createElement('button'); b.className = 'dsh-tb-btn'; b.title = tip; b.appendChild(icon(d)); b.dataset.act = act; ctrl.appendChild(b); return b; };
      const btnMin = mk('min', 'M2 8h12', '最小化');
      const btnMax = mk('max', 'M3 3h10v10H3z', '最大化');
      const btnClose = mk('close', 'M4 4l8 8M12 4l-8 8', '关闭');
      tb.appendChild(title); tb.appendChild(ctrl);
      document.body.appendChild(tb);
      // 初始背景：直接读取 body 背景色（preload 观察器随后负责实时更新）
      const tbBg = getComputedStyle(document.body).backgroundColor;
      if (tbBg) tb.style.background = tbBg;
      btnMin.addEventListener('click', () => window.dshDesktop && window.dshDesktop.windowControls.minimize());
      btnMax.addEventListener('click', async () => { if (window.dshDesktop) { const m = await window.dshDesktop.windowControls.toggleMaximize(); window.dispatchEvent(new CustomEvent('dsh-max-changed', { detail: { maximized: m } })); } });
      btnClose.addEventListener('click', () => window.dshDesktop && window.dshDesktop.windowControls.close());
    })()`).catch((err) => console.log("[TB-INJECT-ERR]", err.message));
    // 贴顶的 fixed 大面板（第三方侧边栏/面板插件）下移标题栏高度，保持与主内容水平对齐
    mainWindow.webContents.executeJavaScript(`(() => {
      const H = ${TITLEBAR_HEIGHT};
      function fixPanels() {
        // 注意：此处位于模板字符串中，禁用正则字面量（转义会被 JS 吞掉导致 SyntaxError）
        var bgRaw = String(getComputedStyle(document.body).backgroundColor || '');
        var bgParts = bgRaw.replace('rgba(', '').replace('rgb(', '').replace(')', '').split(',');
        var solid = bgParts.length >= 3 ? 'rgb(' + bgParts[0].trim() + ',' + bgParts[1].trim() + ',' + bgParts[2].trim() + ')' : '';
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 150 || r.width > 800 || r.height < 200 || r.bottom > window.innerHeight + 10) continue; // 面板形态：宽 150-800、高 ≥200
          const isRightEdge = r.right >= window.innerWidth - 10;
          const isTopEdge = r.top <= 10;
          // 右侧贴边面板：去掉左边缘分隔线/阴影 + 背景统一为主内容背景（消除"隔阂"缝隙）
          if (isRightEdge) {
            el.style.borderLeft = 'none';
            el.style.boxShadow = 'none';
            if (solid) el.style.background = solid;
          }
          // 贴顶面板：下移标题栏高度（幂等：插件若重置 top，下次运行会再次下移）
          if (isTopEdge) {
            const curTop = parseFloat(cs.top) || 0;
            if (curTop < H - 2) {
              el.style.top = (curTop + H) + 'px';
              el.style.height = (r.height - H) + 'px';
            }
            if (el.dataset) el.dataset.dshTbFixed = '1';
          }
        }
      }
      fixPanels();
      // 面板可能延迟挂载：定时重试（500ms / 2s / 5s / 12s）
      [500, 2000, 5000, 12000].forEach((ms) => setTimeout(fixPanels, ms));
      try { new MutationObserver(fixPanels).observe(document.body, { childList: true, subtree: true }); } catch {}
    })()`).catch((err) => console.log("[PANEL-FIX-ERR]", err.message));
    // 最大化状态推送：自绘标题栏更新图标
    mainWindow.on("maximize", () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send("win-maximized-changed", true); });
    mainWindow.on("unmaximize", () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send("win-maximized-changed", false); });
  });

  mainWindow.loadURL(url);

;

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