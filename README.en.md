# DeepSeek Harness Desktop (DSH Desktop Client)

<p align="center">
  <img src="build/icon.png" width="96" alt="DSH Desktop" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH Official" src="https://img.shields.io/badge/DSH-Official%20Repo-4D6BFE?style=flat-square&logo=deepseek&logoColor=white"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/releases"><img alt="Release" src="https://img.shields.io/github/v/release/InkWord01/DeepSeekHarness----Desktop?style=flat-square&color=10b981"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square"></a>
  <a href="https://github.com/InkWord01/DeepSeekHarness----Desktop/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/InkWord01/DeepSeekHarness----Desktop?style=flat-square&color=10b981"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH Stars" src="https://img.shields.io/github/stars/deepseek-ai/deepseek-harness?style=flat-square&label=DSH%20Stars&color=4D6BFE"></a>
</p>

Package [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as a **Windows desktop app**: double-click to run — no manual Node.js install, no CLI, no browser needed.

> This repository is an **unofficial desktop shell for DeepSeek Harness**. The frontend UI and backend logic come entirely from the official DSH; this project only provides the desktop experience layer: "start backend → open window → stay in tray".

## ✨ Features

- 🖥️ **Standalone desktop window**: no browser tab needed, dedicated taskbar/tray icon
- ⚙️ **Zero-config startup**: automatically detects and reuses an existing DSH instance (e.g. :3080 opened in a browser), otherwise starts the **bundled backend** (ships its own Node runtime and dsh dependencies — nothing to preinstall)
- 🧊 **Tray resident**: closing the window minimizes to tray while the backend keeps running; tray menu offers "Show Window / Quit"
- 🧹 **Clean exit**: only stops the backend process this app spawned; external DSH instances are untouched
- 🔄 **Sync with official releases**: rebuild with an updated `DSH_VERSION` to follow upstream (see below)

## 📦 Download & Usage

### Installer (Recommended)

Download the installer matching your CPU architecture from the **Releases** page (includes the DSH backend):

**Full build (recommended, zero prerequisites)** (~163MB, bundles the Node runtime):

- `DeepSeek-Harness-Desktop-<version>-x64.exe` — most Intel/AMD PCs
- `DeepSeek-Harness-Desktop-<version>-arm64.exe` — ARM devices (Snapdragon Windows, Apple Silicon Windows, etc.)

**Lite build (optional, when Node.js ≥ 22 is already installed)** (~120MB, no bundled Node; uses the system Node at runtime):

- `DeepSeek-Harness-Desktop-<version>-x64-lite.exe`
- `DeepSeek-Harness-Desktop-<version>-arm64-lite.exe`

> Not sure about your architecture? Task Manager → Performance → CPU shows it.
> Don't know whether Node.js is installed? Just pick the full build.

Run the setup wizard (custom install directory supported), then launch from the desktop/Start menu.

### First Launch

1. The app starts the bundled DSH backend automatically (~10-30s; log at `%APPDATA%\DeepSeek Harness Desktop\logs\backend.log`)
2. If a DSH instance is already running on `127.0.0.1:3080` (e.g. opened in a browser), the desktop app **reuses** it instead of starting another one
3. Session data and settings are shared with the Web version (stored in `~/.dsh`, managed by the DSH backend)

## 🤖 Automation (CI / Updates / Portable)

- **GitHub Actions auto-build**: pushing a `v*` tag builds x64 + arm64 installers and creates a draft Release (`.github/workflows/build.yml`); human review before publishing
- **Auto-update**: electron-updater prompts to download new GitHub releases
- **Official version reminder**: checks the latest `@deepseek-ai/dsh` on startup and shows a tray balloon when a new version is available
- **Portable build**: `npm run dist` also produces `*-portable.exe` (no install required)
- **Bilingual UI**: splash screen and tray menu follow the system language (zh/en)

## 📦 Installer Size Optimization

- Installer ~**163MB** (~600MB unpacked, includes full DSH backend + Node runtime)
- Multi-platform binaries are trimmed at build time (node-pty / sharp / ripgrep keep only win32-x64), shrinking the installer from 177MB to 163MB and unpacked size by ~80MB
- Electron locales trimmed to zh/en only (46MB → 1MB)
- Splash screen shown while the backend boots; main UI opens when ready

## 🛠️ Build from Source

### Requirements

- Windows 10/11 x64
- Node.js ≥ 20 (required on the build machine; end users don't need it)
- Network access (first build downloads Electron and npm dependencies)

### Steps

    git clone https://github.com/InkWord01/DeepSeekHarness----Desktop.git
    cd DeepSeekHarness----Desktop
    npm install
    npm run prepare:backend   # install the bundled backend (dsh runtime + node.exe) into resources/backend
    npm run dist              # produce release/DeepSeek Harness Desktop Setup <ver>.exe

Development: `npm run dev` (reuses an existing :3080 instance or starts the backend automatically).

> **Building without admin rights**: if the build machine cannot create symlinks (winCodeSign extraction errors), the project ships a workaround (`signAndEditExecutable: false` + an afterPack hook that writes icon/version). Just run `npm run dist`.

## 🔄 Syncing with Official DSH Releases

When the official DSH releases a new version, update this desktop app as follows:

1. Check the official version (e.g. `0.2.0`): <https://www.npmjs.com/package/@deepseek-ai/dsh>
2. Update the version in `devDependencies["@deepseek-ai/dsh"]` in `package.json`
3. Rebuild:

       npm install
       npm run prepare:backend
       npm run dist

4. Bump the `version` field and publish a new Release (attach the artifacts)

Users then get the latest official features by downloading the new desktop release.

## 🤝 Contribution Guide (read-only repo)

This is an **open-source read-only repository** (MIT License): everyone is welcome to **download, use, and learn** from it, but **direct pushes are not allowed** (only the maintainer can merge changes).

To contribute:

- File an **Issue** for bugs or feature requests
- Start a **Discussion** to share experiences
- For code: fork, develop, and contact the maintainer via an Issue for review and merge

## 📁 Project Structure

    src/main.js                 # Electron main process: backend, window, tray, lifecycle
    src/preload.js              # renderer bridge (read-only info)
    scripts/prepare-backend.mjs # builds the bundled backend (dsh dependency tree + node.exe)
    scripts/afterPack.js        # writes icon & version info after pack
    scripts/wcs-mirror.mjs      # local binary mirror proxy (optional build aid)
    build/                      # icon assets
    resources/backend/          # generated at build time: bundled DSH backend (not committed)
    release/                    # build output (not committed)

## ⚙️ Advanced Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `DSH_DESKTOP_PORT` | Override the backend port (multi-instance/testing) | `3080` |
| `DSH_VERSION` | Bundled dsh version for `npm run prepare:backend` | `^0.1.0-rc.6` |

## 📄 License

- This repo (desktop shell code): MIT License, see [LICENSE](LICENSE)
- The bundled DeepSeek Harness backend and UI are copyrighted by DeepSeek

## ⚠️ Disclaimer

This project is not affiliated with DeepSeek; it is a community-maintained desktop wrapper. Please comply with DeepSeek's terms of service and local laws.