# 项目结构

当前实现为 Node.js 单包项目，使用 ESM 和 `package.json` 管理入口与依赖。日期：2026-10-06。仓库根目录即项目根目录。

```text
taobao-script-search/
├── package.json / package-lock.json    依赖、SDK、CLI、测试命令
├── README.md / CHANGELOG.md            使用说明与版本记录
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md / SECURITY.md   协作与安全约定
├── LICENSE                             MIT
├── .gitignore / .gitattributes / .editorconfig / .gitleaks.toml
├── .nvmrc / .github/                   固定 Node 24、CI、依赖更新、issue 模板
├── bin/taobao.js                       CLI 可执行入口
├── src/
│   ├── index.js                       公开 SDK
│   ├── cli.js                         参数、提交、JSON 输出
│   ├── core/
│   │   ├── config.js                  项目/运行目录和服务配置
│   │   ├── engine.js                  通用操作、缓存、批量分组
│   │   ├── errors.js                  统一结果与错误
│   │   └── money.js                   价格文本与口径
│   ├── browser/
│   │   ├── session.js                 日常 Chrome 连接与标签池
│   │   ├── chromium.js                内核解析、官方镜像地址与缺失提示
│   │   └── install.js                 解压用户自备内核到共享缓存
│   ├── service/
│   │   ├── daemon.js                  独立进程、任务队列和状态
│   │   ├── client.js                  自动启动、SDK、后台进程
│   │   └── protocol.js                命名管道 JSONL 协议
│   └── adapters/taobao/
│       ├── search.js                  搜索等待与结果适配
│       ├── detail.js                  商品复用、选规格、核价
│       ├── specs.js                   规格映射、真实 SKU、JSON 解析
│       ├── page.js                    通用页面等待、人工恢复、导航
│       └── dom/
│           ├── auth.js                登录/验证识别
│           ├── search.js              搜索页面选择器与提取
│           └── detail.js              详情选择器及页面数据提取
├── tests/                             离线适配与跨进程 Chrome 测试
├── examples/                          SDK 与批量 JSON 示例
├── scripts/
│   ├── verify-live.js                 真实站点验收
│   ├── build-release.js               两文件 Windows 11 x64 打包（full / lite）
│   ├── audit-publish.js               暂存快照的凭据/隐私/路径审计
│   └── probe-mtop.js                  直接 HTTP 研究探测
├── docs/                              架构、契约、验证、调研
├── packaging/                         webpack 双入口、PowerShell 启动器、JS 分发模板
├── skills/taobao-search/               两文件发布的 SKILL.md 源文档
├── dist/taobao-search-win11-x64/        taobao.js + SKILL.md（含内核），忽略提交
├── dist/taobao-search-win11-x64-lite/   taobao.js + SKILL.md（不含内核），忽略提交
├── legacy/
│   ├── python/                        原 Python 原型、测试和采购记录
│   ├── python-migration-draft/         未完成的旧包迁移草稿
│   └── migration-manifest.json         38 个移动文件的 SHA-256
├── artifacts/                         查询/研究结果，忽略提交
├── .runtime/                          进程令牌和日志，忽略提交
├── .cache/ / node_modules/             本地依赖缓存，忽略提交
└── .venv/                             保留的原型环境，忽略提交
```

职责依赖：`CLI / SDK → service client → daemon → engine → adapters / browser`。页面选择器留在适配器中，通用服务和协议不包含采购型号或固定商品 ID。示例和真实验收才使用本次螺丝商品。

原 Python 文件完整移入 `legacy/python/`；原 `outputs/` 保持在原型目录内，保留内部相对引用。移动后的 38 个文件已核对 SHA-256。旧 Python 包迁移未完成，作为草稿归档；现有运行入口均为 JS。

当前仓库已初始化为 Git 单分支 `main`，远端为 GitHub 公开仓库。发布内容由 `.gitignore` 排除运行时、原型与构建产物，并由 `npm run audit:publish` 做提交前审计。目录命名是本项目的职责划分，Node 的 ESM/包入口机制依据 [官方文档](https://nodejs.org/api/packages.html)。
