# DeepSeek Harness Desktop（DSH 桌面客户端）

<p align="center">
  <img src="build/icon.png" width="96" alt="DSH Desktop" />
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH Official" src="https://img.shields.io/badge/DSH-Official%20Repo-4D6BFE?style=flat-square&logo=deepseek&logoColor=white"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/releases"><img alt="Release" src="https://img.shields.io/github/v/release/InkWord01/DeepSeekHarness----Desktop?style=flat-square&color=10b981"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/InkWord01/DeepSeekHarness----Desktop?style=flat-square&color=10b981"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH Stars" src="https://img.shields.io/github/stars/deepseek-ai/deepseek-harness?style=flat-square&label=DSH%20Stars&color=4D6BFE"></a>
</p>

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打包为
**Windows 桌面应用**：双击即用，无需手动安装 Node.js、无需命令行、无需打开浏览器。

> 本仓库是 **DeepSeek Harness 的非官方桌面壳**，前端界面与后端逻辑全部来自官方 DSH，
> 本项目只负责「启动后端 → 打开窗口 → 托盘常驻」的桌面体验层。

## ✨ 特性

- 🖥️ **独立桌面窗口**：无需浏览器标签页，任务栏/托盘独立图标
- ⚙️ **零配置启动**：自动探测并复用已有 DSH 实例（如浏览器打开的 :3080），
  否则自动启动**捆绑的后端**（自带 Node 运行时与 dsh 依赖，无需预装环境）
- 🧊 **托盘常驻**：关闭窗口最小化到托盘，后端继续运行；托盘菜单「显示主窗口 / 退出」
- 🧹 **干净退出**：退出时只终止本应用自启的后端进程，不影响外部 DSH 实例
- 🔄 **可随官方同步更新**：通过更新 `DSH_VERSION` 重新打包即可跟随官方新版本（见下文）

## 📦 下载与使用

### 方式一：安装版（推荐）

从 **Releases** 页面下载 `DeepSeek Harness Desktop Setup <版本>.exe`
（约 180MB，内置 DSH 后端与 Node 运行时），运行安装向导
（可自选安装目录），安装后从桌面/开始菜单启动。

### 首次启动

1. 应用自动启动内置的 DSH 后端（约 10-30 秒，日志在 `%APPDATA%\DeepSeek Harness Desktop\logs\backend.log`）
2. 若本机 `127.0.0.1:3080` 已有 DSH 在运行（比如浏览器开着 DSH），桌面端会**直接复用**，不会重复启动
3. 会话数据、设置与 Web 版完全一致（存储在 `~/.dsh`，由 DSH 后端统一管理）


## 📦 安装包体积优化

- 安装包约 **163MB**（解压后约 600MB，含完整 DSH 后端 + Node 运行时）
- 构建时自动裁剪多平台二进制（node-pty / sharp / ripgrep 仅保留 win32-x64），
  安装包从 177MB 降至 163MB，解压体积减少约 80MB
- Electron 语言包仅保留中文与英文（46MB → 1MB）
- 启动时显示加载画面，后端就绪后自动进入主界面

## 🛠️ 从源码构建

### 环境要求

- Windows 10/11 x64
- Node.js ≥ 20（构建机需要；最终用户不需要）
- 网络（首次构建需下载 Electron 与 npm 依赖）

### 构建步骤

    git clone https://github.com/InkWord01/DeepSeekHarness----Desktop.git
    cd DeepSeekHarness----Desktop
    npm install
    npm run prepare:backend   # 安装捆绑后端（dsh 运行时 + node.exe）到 resources/backend
    npm run dist              # 产出 release/DeepSeek Harness Desktop Setup <ver>.exe

开发调试：`npm run dev`（复用已有 3080 实例或自动启动后端）。

> **无管理员权限构建**：若构建机无法创建符号链接（winCodeSign 解压报错），
> 项目已内置规避方案（`signAndEditExecutable: false` + afterPack 钩子写入图标/版本），
> 直接 `npm run dist` 即可，无需额外处理。

## 🔄 随官方新版本同步更新

官方 DSH 发布新版本后，按以下步骤更新本桌面端：

1. 查看官方版本号（如 `0.2.0`）：<https://www.npmjs.com/package/@deepseek-ai/dsh>
2. 修改 `package.json` 中 `devDependencies["@deepseek-ai/dsh"]` 的版本号
3. 重新构建：

       npm install
       npm run prepare:backend
       npm run dist

4. 更新 `version` 字段并发布新的 Release（附上构建产物）

这样用户下载新版桌面端即可使用官方最新功能。

## 🤝 贡献指南（只读仓库）

本仓库为**开源只读仓库**：代码对所有人开放（MIT License），欢迎任何人
**下载、使用、学习**，但**不允许直接推送修改**（只有仓库维护者可以合并变更）。

如果你想改进：

- 提 **Issue**：报告问题、建议新功能
- 提 **Discussion**：交流使用心得
- 想贡献代码：请 Fork 后开发，通过 Issue 联系维护者，由维护者评估合并

## 📁 项目结构

    src/main.js                 # Electron 主进程：后端管理、窗口、托盘、生命周期
    src/preload.js              # 渲染进程桥（只读信息暴露）
    scripts/prepare-backend.mjs # 构建捆绑后端（dsh 依赖树 + node.exe）
    scripts/afterPack.js        # 打包后写入图标与版本信息
    scripts/wcs-mirror.mjs      # 本地二进制镜像代理（构建辅助，可选）
    build/                      # 图标资源
    resources/backend/          # 构建时生成：捆绑的 DSH 后端（不入库）
    release/                    # 构建输出（不入库）

## ⚙️ 高级配置

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DSH_DESKTOP_PORT` | 覆盖后端端口（多开/测试） | `3080` |
| `DSH_VERSION` | 构建捆绑的 dsh 版本（`npm run prepare:backend` 时） | `^0.1.0-rc.6` |

## 📄 许可证

- 本仓库（桌面壳代码）：MIT License，见 [LICENSE](LICENSE)
- 内置的 DeepSeek Harness 后端与界面：版权归 DeepSeek 官方所有

## ⚠️ 声明

本项目与 DeepSeek 官方无隶属关系，是社区维护的桌面封装。
使用时请遵守 DeepSeek 的服务条款与所在地区法律法规。