// DeepSeek Harness Desktop - preload
// 只暴露只读信息与窗口控制，不开放 Node 能力（沙箱 + contextIsolation）
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  getInfo: () => ipcRenderer.invoke("app-info"),
  onBackendStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("backend-status", handler);
    return () => ipcRenderer.removeListener("backend-status", handler);
  },
  // 自绘标题栏窗口控制
  windowControls: {
    minimize: () => ipcRenderer.invoke("win-minimize"),
    toggleMaximize: () => ipcRenderer.invoke("win-maximize-toggle"),
    close: () => ipcRenderer.invoke("win-close"),
    isMaximized: () => ipcRenderer.invoke("win-is-maximized"),
    onMaximizedChange: (cb) => {
      const handler = (_e, maximized) => cb(maximized);
      ipcRenderer.on("win-maximized-changed", handler);
      return () => ipcRenderer.removeListener("win-maximized-changed", handler);
    }
  }
});

// ---------- 自绘标题栏主题同步 ----------
// 标题栏背景 = 页面 body 背景色；符号色按背景亮度取深/浅纯色（跟随主题，无系统强调色）
function currentBodyBg() {
  try { return getComputedStyle(document.body).backgroundColor; } catch { return ""; }
}

function applyTitlebarStyle() {
  const tb = document.getElementById("dsh-titlebar");
  if (!tb) return;
  const bg = currentBodyBg();
  if (bg) tb.style.background = bg;
  const m = /^(?:rgba?)\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bg || "");
  if (m) {
    const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
    tb.style.color = lum > 0.55 ? "#1f2937" : "#e5e7eb";
  }
}

// 使用统计等毛玻璃面板：强制实色背景（跟随页面背景），禁 blur —— 浅色皮肤下保证可读
function rgbToSolid(rgb) {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb || "");
  if (!m) return null;
  return "rgb(" + m[1] + ", " + m[2] + ", " + m[3] + ")";
}
function solidifyGlassPanels() {
  const solid = rgbToSolid(currentBodyBg());
  if (!solid) return;
  for (const el of document.querySelectorAll('[class*=us-shell], [class*=glass], [class*=Glass]')) {
    el.style.background = solid;
    el.style.backdropFilter = "none";
    el.style.webkitBackdropFilter = "none";
  }
}

// 会话标题 / 模式 / 模型 → 标题栏左侧三段（· 分隔；无内容的段连同分隔符隐藏）
let lastSegKey = "";
function cleanSegText(el) {
  if (!el) return "";
  const t = (el.getAttribute("title") || el.textContent || "").trim();
  return t.replace(/\s+/g, " ");
}
function syncSessionTitle() {
  const tb = document.getElementById("dsh-titlebar");
  if (!tb) return;
  const titleEl = tb.querySelector(".dsh-tb-title");
  if (!titleEl) return;
  const header = document.querySelector("header, [class*=wSkVaW_header]");
  let title = "", mode = "", model = "";
  if (header) {
    const h = header.getBoundingClientRect();
    const hidden = header.classList.contains("wSkVaW_headerHidden") || h.height === 0;
    if (!hidden) {
      // 会话标题：面包屑最后一个（crumbCurrent），退化为 h1/h2/title
      const crumb = header.querySelector("[class*=crumbCurrent], [class*=crumb]:last-child");
      title = cleanSegText(crumb) || cleanSegText(header.querySelector("h1, h2, [class*=title], [class*=Title], [class*=sessionName]"));
      // 模式：agent preset / mode 按钮（title 属性优先）
      const modeBtn = header.querySelector("[class*=preset], [class*=Preset], [class*=agentPreset], [class*=mode]");
      if (modeBtn) mode = cleanSegText(modeBtn);
      // 模型：模型选择器按钮
      const modelBtn = header.querySelector("[class*=model], [class*=Model]");
      if (modelBtn) model = cleanSegText(modelBtn);
    }
  }
  if (!title) title = "DeepSeek Harness Desktop";
  const segs = [title, mode, model];
  const key = JSON.stringify(segs);
  if (key === lastSegKey) return;
  lastSegKey = key;
  const parts = {
    title: titleEl.querySelector('[data-part="title"]'),
    mode: titleEl.querySelector('[data-part="mode"]'),
    model: titleEl.querySelector('[data-part="model"]'),
    sep1: titleEl.querySelector('[data-part="sep1"]'),
    sep2: titleEl.querySelector('[data-part="sep2"]')
  };
  parts.title.textContent = title;
  parts.mode.textContent = mode;
  parts.model.textContent = model;
  parts.mode.style.display = mode ? "" : "none";
  parts.model.style.display = model ? "" : "none";
  parts.sep1.style.display = mode ? "" : "none";
  parts.sep2.style.display = model ? "" : "none";
  titleEl.title = [title, mode, model].filter(Boolean).join(" · ");
}

// 最大化图标切换（□ ↔ ❐）
function updateMaxIcon(maximized) {
  const btn = document.querySelector("#dsh-titlebar .dsh-tb-btn[data-act=max] svg path");
  if (btn) btn.setAttribute("d", maximized ? "M3.5 3.5h7v7h-7zM6 10.5v2h6.5V6h-2" : "M3 3h10v10H3z");
  const maxBtn = document.querySelector("#dsh-titlebar .dsh-tb-btn[data-act=max]");
  if (maxBtn) maxBtn.title = maximized ? "还原" : "最大化";
}

function refreshAll() {
  applyTitlebarStyle();
  solidifyGlassPanels();
  syncSessionTitle();
  syncPanelChrome();
}

// 已处理过的右侧面板：背景跟随主内容背景（主题/皮肤切换时更新）
function syncPanelChrome() {
  const solid = rgbToSolid(currentBodyBg());
  if (!solid) return;
  for (const el of document.querySelectorAll('[data-dsh-tb-fixed]')) {
    el.style.background = solid;
  }
}

// 聊天流式输出时 body 变化极频繁：rAF 节流，避免频繁全量计算
let refreshPending = false;
function scheduleRefresh() {
  if (refreshPending) return;
  refreshPending = true;
  requestAnimationFrame(() => { refreshPending = false; refreshAll(); });
}

function initTitlebarWatcher() {
  try {
    refreshAll();
    updateMaxIcon(true); // 占位，随后用真实状态修正
    // body 样式/类变化（主题、皮肤切换）→ 同步标题栏
    new MutationObserver(scheduleRefresh).observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
    new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true }); // 会话标题/面板出现
    new MutationObserver(scheduleRefresh).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    // 最大化状态
    window.dshDesktop.windowControls.isMaximized().then(updateMaxIcon).catch(() => {});
    window.dshDesktop.windowControls.onMaximizedChange(updateMaxIcon);
    window.addEventListener("dsh-max-changed", (e) => updateMaxIcon(!!e.detail.maximized));
  } catch {}
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => {
    // 标题栏 DOM 由主进程在 did-finish-load 注入，稍后重试直至出现
    applyTitlebarStyle();
    initTitlebarWatcher();
  });
} else {
  applyTitlebarStyle();
  initTitlebarWatcher();
}

// 标题栏注入可能晚于 preload：轮询等待
let tbRetries = 0;
const tbTimer = setInterval(() => {
  if (document.getElementById("dsh-titlebar")) {
    refreshAll();
    window.dshDesktop.windowControls.isMaximized().then(updateMaxIcon).catch(() => {});
    clearInterval(tbTimer);
  } else if (++tbRetries > 50) {
    clearInterval(tbTimer);
  }
}, 200);
