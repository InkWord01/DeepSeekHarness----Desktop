// dsh-desktop-link - 浏览器端插件
// 在 DSH Web UI 侧边栏底部注入「下载桌面版」按钮，链接到桌面版 Release
"use strict";
window.__ModuleLoader__.load({
  id: "dsh-desktop-link",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");

    // 组件：下载桌面版按钮
    const DesktopLink = ({ wide }) => {
      return jsxRuntime.jsx("a", {
        href: "https://github.com/InkWord01/DeepSeekHarness----Desktop/releases",
        target: "_blank",
        rel: "noopener noreferrer",
        title: "DeepSeek Harness Desktop - 桌面客户端下载",
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 10px",
          borderRadius: "8px",
          color: "var(--dsw-alias-label-secondary, #9ca3af)",
          textDecoration: "none",
          fontSize: "13px",
          transition: "background .15s var(--ds-ease-in-out, ease)",
          cursor: "pointer"
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))"; },
        onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        children: [
          // 桌面图标（内联 SVG，避免依赖图标库）
          jsxRuntime.jsx("svg", {
            width: 16,
            height: 16,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            children: [
              jsxRuntime.jsx("rect", { x: 2, y: 4, width: 20, height: 14, rx: 2 }),
              jsxRuntime.jsx("path", { d: "M8 21h8M12 18v3" })
            ]
          }),
          wide ? jsxRuntime.jsx("span", { children: "下载桌面版" }) : null
        ]
      });
    };

    function apply(ctx) {
      ctx.effect(() => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-desktop-link",
        label: "Desktop Client",
        order: 0
      }, DesktopLink), "dsh-desktop-link: slot registration");
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});