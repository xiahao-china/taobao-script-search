# Windows 11 x64 两文件分发

交付为两个变体，每个目录都只有 `taobao.js` 和 `SKILL.md`：

| 变体 | 目录 | 载荷 | 分发大小 |
|---|---|---|---|
| `full` | `dist/taobao-search-win11-x64/` | Node + Playwright + 业务代码 + 便携 Chromium | 约 311 MiB |
| `lite` | `dist/taobao-search-win11-x64-lite/` | Node + Playwright + 业务代码 | 约 55 MiB |

用户无需安装 Node、npm 包或浏览器，也无需管理员权限。`full` 在任何机器上都能离线自持；`lite` 不含内核，靠复用本机 Chrome 或用户自备内核，体积约为 `full` 的六分之一。这里只发布 Windows 11 x64；本机验收环境为 Windows 11 专业版 10.0.22631，x64。

JS 是包含运行载荷的自包含发布文件，首行注释内携带 PowerShell 启动入口。调用方按 SKILL.md 在 Windows 自带 PowerShell 会话定义 Invoke-Taobao，然后提交 search/specs/detail/batch 等任务。不能直接用 node/cscript 执行这个文件；普通纯 JS 没有运行时无法自行执行。选择 PowerShell 是为了使用系统已有启动环境，并规避内嵌浏览器后的大文件 JScript 引擎限制。

## 内核解析

启动器只给 `full` 变体注入 `TAOBAO_SEARCH_BUNDLED_CHROMIUM`。运行时按 `src/browser/chromium.js` 的顺序选内核，第一个命中者胜出：

1. `TAOBAO_SEARCH_BUNDLED_CHROMIUM`（`full` 变体的包内内核）；
2. `%LOCALAPPDATA%/TaobaoSearch/browser/chrome-win64/chrome.exe`，由 `taobao browser install` 安装；
3. 同机任一变体已解出的内核（`bundles/*/browser/chrome-win64/chrome.exe`）；
4. 本机日常 Chrome，走 CDP 连接复用其登录。

前三条都落空时（`lite` 变体在没装 Chrome 的机器上），命令以 `BROWSER_NOT_FOUND` 结束，`error.details.downloadUrls` 给出 Chrome for Testing 与 Playwright CDN 两个官方地址，`error.details.installCommand` 给出安装命令。下载 `chrome-win64.zip` 后执行 `taobao browser install <zip路径>`，内核落在共享缓存里，此后同机所有变体直接复用，不再需要联网。

`browser install` 也接受已经解压好的目录；解压走 `[IO.Compression.ZipFile]::ExtractToDirectory`，因此不传播 Mark-of-the-Web 区域标识，`chrome.exe` 启动时不会触发 SmartScreen 提示。安装采用"先复制到 `.partial` 再改名"，失败不会破坏已装好的内核。

## 构建

构建者安装开发依赖后运行 `npm.cmd run build:win11`（两个变体一起产出），或 `build:win11:full` / `build:win11:lite` 只构建其一。无需用户运行该命令。步骤：

1. webpack 将业务代码构建成 cli.cjs 和 daemon.cjs，不输出额外动态 chunk；两个变体共用这一次构建。
2. 收集固定版本 Node 24.21.0 Windows x64 运行时、Playwright 1.63.0 与其资源、许可证，缓存到 `.cache/release-build/runtime/`。
3. `full` 另外收集对应的 Chrome for Testing 153.0.8010.12，缓存到 `.cache/release-browser/`。
4. Node 官方 ZIP 用固定 SHA-256 校验：158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541。
5. 为每个运行文件记录 SHA-256，压缩成一个 ZIP；整个 ZIP 再记录 SHA-256。
6. 把 ZIP 分行编码到 JS 注释内，与启动器合成一份文件；复制一份完整 SKILL.md。构建记录留在 artifacts/release 的 `build-full.json` / `build-lite.json`，不属于用户发布包。

构建过程每 30 秒打印一次已耗时的步骤名（Chromium 下载、压缩、Base64 编码），Base64 编码另按 10% 报进度，便于分辨"慢"和"卡死"。

Playwright 的动态资源按 [webpack externals](https://webpack.js.org/configuration/externals/) 机制从**内嵌载荷的 node_modules** 加载，不依赖用户安装。构建时可以下载官方组件；用户端完全内置。Node 来自 [官方发行目录](https://nodejs.org/dist/v24.21.0/)，Chromium 来自 Playwright 官方构建下载服务或 Chrome for Testing 官方存储桶。

## 运行

默认缓存根目录为 `%LOCALAPPDATA%/TaobaoSearch`，可通过 TAOBAO_SEARCH_CACHE_DIR 指定其他可写路径。

- bundles/<SHA-256>：解压出的便携运行时、业务代码、Playwright 资源与许可证；`full` 变体还含 Chromium。变体内容不同，哈希不同，可安全共存。
- browser：`taobao browser install` 安装的内核，供所有变体共享。
- runtime：常驻进程 manifest、IPC 令牌和日志。
- browser-profile：便携浏览器长期资料，保留登录。

首次运行逐行解码，不一次读取整个 Base64；校验载荷、检查 ZIP 路径、解压、校验文件、写入 ready 标记后原子提交。并发首次运行使用命名 mutex。后续只读首行并复用 ready 目录，不重新解压。SHA-256 用于完整性检查，不等同于发布者数字签名。

通过 ProcessStartInfo 传递每个参数并分别读取 stdout/stderr，支持中文、空格和引号，不拼接 cmd.exe 命令。环境配置仅对子进程生效，不修改系统 PATH、注册表或 npm 配置。CLI 启动的常驻服务使用包内 node.exe 和 daemon.cjs；不会引用开发机上的项目目录。后台启动使用 Windows CreateProcess 的 DETACHED_PROCESS，并禁用句柄继承，防止服务持有调用方输出管道；辅助代码只使用 Windows 自带 PowerShell/.NET/Win32 API，后台窗口隐藏。

优先复用日常 Chrome，保留原有登录。日常 Chrome 仍需用户允许调试连接。没有 Chrome 时使用解析到的便携内核（`full` 自带，或 `lite` 已安装的）；`--portable-browser` 可强制选择。便携浏览器有独立资料，第一次需登录，不能自动继承另一浏览器的 Cookie。

## 验收与边界

发布测试对两个变体分别验收。`full`：把仅有的两个文件复制到独立中文/空格路径，清除 Node 的 PATH/NODE_PATH 搜索位置，设置不可用代理，使用内嵌 Chromium 的离线页面执行搜索、规格与核价，验证常驻进程、单连接、单商品导航、输出/错误码、中文和引号、停止后保留浏览器和 Cookie、载荷被篡改时报校验错误。`lite`：同样隔离环境并额外遮蔽 `PROGRAMFILES`/`PROGRAMFILES(X86)`，断言不携带 `browser/` 目录、`browser info` 无可用内核、查询以 `BROWSER_NOT_FOUND` 结束且错误信息含官方下载地址、按文档用 `browser install` 装好归档后即被复用。结果分别写入 artifacts/release/acceptance.json 和 acceptance-lite.json。

这不模拟全新 Windows 虚拟机；明确证明包内执行文件和依赖路径的独立性。PowerShell 或内嵌代码执行若被组织策略禁用，属于环境限制，不自动修改策略。下载即用不包含自动登录、自动通过验证或绕过浏览器连接授权。运行后会产生缓存文件，因此两个文件是分发形式。
