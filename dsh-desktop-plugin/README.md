# dsh-desktop-link（DSH 客户端插件）

在 DeepSeek Harness Web UI 的侧边栏底部添加「下载桌面版」入口，
链接到 DeepSeek Harness Desktop 的 GitHub Release。

## 安装（等 npm 发布后）

    dsh plugin --profile web add @inkword01/dsh-desktop-link

或通过 GitHub Packages：

    dsh plugin --profile web add @inkword01/dsh-desktop-link --registry https://npm.pkg.github.com/

## 本地开发测试

1. 将本目录链接进 DSH profile：

       cd $env:USERPROFILE\.dsh\profiles
       npm install --no-save <本目录绝对路径>

2. 在 profiles/web/cordis.patch.yml 中追加：

       - insert:
           - id: desktop-link
             name: dsh-desktop-link

3. 重启 dsh web，侧边栏底部出现「下载桌面版」按钮。

## 原理

- 声明 `dsh.client`（platform: web），被 `dsh-client-modules` 扫描进 `window.__DSH_BOOT__`
- `lib/client.js` 用 `window.__ModuleLoader__.load()` 注册到 `sidebar.footer.action` slot
- 组件渲染一个指向 Release 的链接按钮