# Windows 11 x64 两文件分发

交付为 `dist/taobao-search-win11-x64/taobao.js` 和 `SKILL.md`。用户无需安装 Node、npm 包或浏览器，也无需管理员权限。用户端启动不下载任何组件。这里只发布 Windows 11 x64；本机验收环境为 Windows 11 专业版 10.0.22631，x64。

JS 是包含运行载荷的自包含发布文件，首行注释内携带 PowerShell 启动入口。调用方按 SKILL.md 在 Windows 自带 PowerShell 会话定义 Invoke-Taobao，然后提交 search/specs/detail/batch 等任务。不能直接用 node/cscript 执行这个文件；普通纯 JS 没有运行时无法自行执行。选择 PowerShell 是为了使用系统已有启动环境，并规避内嵌浏览器后的大文件 JScript 引擎限制。

## 构建

构建者安装开发依赖后运行 `npm.cmd run build:win11`，无需用户运行该命令。步骤：

1. webpack 将业务代码构建成 cli.cjs 和 daemon.cjs，不输出额外动态 chunk。
2. 收集固定版本 Node 24.21.0 Windows x64 运行时、Playwright 1.63.0 与其资源、对应的 Chrome for Testing 153.0.8010.12 和许可证。
3. Node 官方 ZIP 用固定 SHA-256 校验：158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541。
4. 为每个运行文件记录 SHA-256，压缩成一个 ZIP；整个 ZIP 再记录 SHA-256。
5. 把 ZIP 分行编码到 JS 注释内，与启动器合成一份文件；复制一份完整 SKILL.md。构建记录留在 artifacts/release，不属于用户发布包。

Playwright 的动态资源按 [webpack externals](https://webpack.js.org/configuration/externals/) 机制从**内嵌载荷的 node_modules** 加载，不依赖用户安装。构建时可以下载官方组件；用户端完全内置。Node 来自 [官方发行目录](https://nodejs.org/dist/v24.21.0/)，Chromium 来自 Playwright 官方构建下载服务。

## 运行

默认缓存根目录为 `%LOCALAPPDATA%/TaobaoSearch`，可通过 TAOBAO_SEARCH_CACHE_DIR 指定其他可写路径。

- bundles/<SHA-256>：解压出的便携运行时、业务代码、Playwright 资源、Chromium 与许可证。
- runtime：常驻进程 manifest、IPC 令牌和日志。
- browser-profile：便携浏览器长期资料，保留登录。

首次运行逐行解码，不一次读取整个 Base64；校验载荷、检查 ZIP 路径、解压、校验文件、写入 ready 标记后原子提交。并发首次运行使用命名 mutex。后续只读首行并复用 ready 目录，不重新解压。SHA-256 用于完整性检查，不等同于发布者数字签名。

通过 ProcessStartInfo 传递每个参数并分别读取 stdout/stderr，支持中文、空格和引号，不拼接 cmd.exe 命令。环境配置仅对子进程生效，不修改系统 PATH、注册表或 npm 配置。CLI 启动的常驻服务使用包内 node.exe 和 daemon.cjs；不会引用开发机上的项目目录。后台启动使用 Windows CreateProcess 的 DETACHED_PROCESS，并禁用句柄继承，防止服务持有调用方输出管道；辅助代码只使用 Windows 自带 PowerShell/.NET/Win32 API，后台窗口隐藏。

优先复用日常 Chrome，保留原有登录。日常 Chrome 仍需用户允许调试连接。没有 Chrome 时自动启动包内便携 Chromium；--portable-browser 可强制选择。便携浏览器有独立资料，第一次需登录，不能自动继承另一浏览器的 Cookie。

## 验收与边界

发布测试把仅有的两个文件复制到独立中文/空格路径，清除 Node 的 PATH/NODE_PATH 搜索位置，设置不可用代理，使用内嵌 Chromium 的离线页面执行搜索、规格与核价。验证常驻进程、单连接、单商品导航、输出/错误码、中文和引号、停止后保留浏览器和 Cookie。结果写入 artifacts/release/acceptance.json。

这不模拟全新 Windows 虚拟机；明确证明包内执行文件和依赖路径的独立性。PowerShell 或内嵌代码执行若被组织策略禁用，属于环境限制，不自动修改策略。下载即用不包含自动登录、自动通过验证或绕过浏览器连接授权。运行后会产生缓存文件，因此两个文件是分发形式。
