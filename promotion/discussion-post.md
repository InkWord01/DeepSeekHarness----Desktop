看到很多人在问"会考虑做系统原生 GUI 吗""做 MAC 原生 APP 吗"，我先来交一个 Windows 桌面的作业 🖥️

## DeepSeek Harness Desktop（DSH 桌面客户端）

把 DSH 打包成 Windows 桌面应用：**双击即用**，无需安装 Node.js、无需命令行、无需开浏览器。

### 特性

- **零配置**：内置 Node 运行时 + DSH 后端，装完即用
- **智能复用**：本机已有 3080 实例时自动复用（和浏览器 GUI 共存），否则自动起后端
- **托盘常驻**：关窗不退出，后端继续跑
- **随官方同步**：官方发新版后，改一个版本号重新打包即可跟随更新

### 下载

GitHub Release（安装包 177MB，内含完整后端）：
https://github.com/InkWord01/DeepSeekHarness----Desktop/releases

### 开源

MIT 协议，桌面壳源码全开放：https://github.com/InkWord01/DeepSeekHarness----Desktop

> 桌面壳是社区作品，界面与后端逻辑全部来自官方 DSH，桌面壳只负责窗口/托盘/进程管理。
> 有什么想要的桌面功能（自动更新、多窗口、快捷键等）欢迎提 Issue。

（另外：官方未来如果出原生 GUI，我这个壳就当垫脚石了，能帮官方探探路也好 😄）