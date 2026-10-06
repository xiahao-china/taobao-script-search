# Taobao Script Search

[![CI](https://github.com/xiahao-china/taobao-script-search/actions/workflows/ci.yml/badge.svg)](https://github.com/xiahao-china/taobao-script-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/release-Windows%2011%20x64-informational.svg)](docs/distribution.md)

使用 **JavaScript + Playwright 1.63.0** 查询淘宝，复用日常 Chrome 登录。独立常驻进程持有浏览器，CLI/SDK 只提交任务，不使用 Browser Use。

## 下载即用：Windows 11 x64

提供两个变体，目录内都只有 `taobao.js` 与 `SKILL.md`：

| 变体 | 目录 | 分发大小 | 内容 |
|---|---|---|---|
| 精简版（推荐） | `dist/taobao-search-win11-x64-lite/` | 约 55 MiB | Node 24.21.0 + Playwright 1.63.0 + 业务代码，**不含浏览器内核** |
| 完整版 | `dist/taobao-search-win11-x64/` | 约 311 MiB | 上述内容 + 便携 Chromium 153.0.8010.12 |

两者都用 Windows 自带 PowerShell，按同目录 SKILL.md 定义 `Invoke-Taobao`，再调用 `Invoke-Taobao search 'M3盘头螺丝' --limit 5`；无需安装 Node、执行 npm 或安装构建依赖。

首次运行流式校验、解压到 `%LOCALAPPDATA%/TaobaoSearch/`；随后复用缓存与常驻服务。浏览器按以下顺序复用，通常无需任何额外下载：

1. `TAOBAO_SEARCH_BUNDLED_CHROMIUM`（完整版由启动器注入）；
2. `taobao browser install` 装到 `%LOCALAPPDATA%/TaobaoSearch/browser/` 的内核；
3. 本机曾解出的完整版内核（`bundles/*/browser/`）；
4. 本机日常 Chrome，通过 CDP 连接复用登录。

四者都没有时，精简版会以 `BROWSER_NOT_FOUND` 退出并给出内核下载地址；自行下载 `chrome-win64.zip` 后执行 `taobao browser install <zip路径>` 即可，此后同一台机器上的所有变体都复用它。登录和日常 Chrome 调试授权仍需人工完成。运行后会产生缓存和资料目录。

构建者运行 `npm.cmd run build:win11` 同时产出两个变体，或用 `build:win11:full`、`build:win11:lite` 只构建其一。打包实现与限制见 [发布说明](docs/distribution.md)。

## 开发环境使用

需要 Node.js 24+ 和本机 Chrome。首次查询会自动启动服务；只有首次连接或 Chrome 重启后可能需要连接许可。

```powershell
Set-Location <克隆到本地的仓库目录>
node bin/taobao.js start --approval-timeout 600
node bin/taobao.js search "M3盘头螺丝" --limit 5
node bin/taobao.js specs 805012477549 --output artifacts/specs.json
node bin/taobao.js batch --file examples/batch.json --output artifacts/quotes.json
node bin/taobao.js status
```

从规格结果中选择明确的 `specId`，查询详情：

```powershell
node bin/taobao.js detail 805012477549 --spec-id "sku:实际返回的SKU_ID"
```

最后一行是参数形式说明，需替换为真实返回值。列表价格用于初筛；指定规格的详情才用于核价。

默认遇到登录/验证会等待人工完成，保留原任务并继续。进度写 stderr，结果写 stdout JSON；CLI 返回执行会话时应继续等待该会话，避免重复提交。`Ctrl+C` 可取消任务；服务继续保留。

退出服务时运行 `node bin/taobao.js stop`。这会断开脚本连接，保留日常 Chrome、登录和现有标签。服务最多保留 3 个自己的商品标签，超出时回收自己的最旧标签。

## 统一接口

```js
import { createTaobaoClient } from 'taobao-script-search';
const client = createTaobaoClient();
const list = await client.search('M3盘头螺丝', { limit: 5 });
const specs = await client.getSpecs('805012477549');
const chosen = specs.data.variants.find(value => value.label === 'M3*10(200个)');
const detail = await client.getDetail('805012477549', { specId: chosen.specId });
```

三个操作共用 `{ ok, operation, data, error, meta }` 输出。金额与 ID 使用字符串。`meta` 标注观察时间、是否缓存、价格依据和字段覆盖；无法确认的字段保持 `null`。

通过 `--refresh` 或 SDK 的 `{ forceRefresh: true }` 跳过结果缓存并刷新商品快照。批量刷新同一商品只刷新一次，再连续核多个规格。原始 SKU 数据可用时，直接按 SKU 读取价格；否则检查页面选中状态与价格更新，不能把上一个规格或起价当作目标价格。

## 五项优化

| 要求 | 实现 |
|---|---|
| 常驻进程，CLI 只提交任务 | Windows 命名管道、后台 Node 进程、任务队列 |
| 一次提交关键词、商品、规格 | `batch` 支持搜索与商品规格任务，按商品集中处理 |
| 数据满足条件立即返回 | 条件等待；不使用固定 1–1.2 秒睡眠 |
| 同商品打开一次，连续核规格 | 商品标签复用、快照复用、批量内连续选择 |
| 页面适配器分开，输出统一 | 独立搜索/详情/DOM/规格适配模块及统一结果封装 |

## 开发依赖和检查

```powershell
npm.cmd ci --ignore-scripts --registry=https://registry.npmjs.org --cache=.cache/npm
npm.cmd test
node scripts/verify-live.js
git add -A; npm.cmd run audit:publish
```

无需下载额外 Chromium；使用已安装 Chrome。最后一条会访问真实淘宝并核验示例商品；普通测试使用离线页面和独立临时 Chrome，不读取日常浏览器的 Cookie。`audit:publish` 检查暂存快照里的凭据、个人数据和本机路径，提交前先暂存目标文件；`npm run audit:publish -- --ref HEAD` 改为审计已提交树（CI 用法）。

服务参数在首次启动时生效；修改配置先 `stop` 再 `start`。常用参数见 `node bin/taobao.js --help`。

## 许可与协作

MIT 许可；打包内嵌组件各自保留上游许可。参与开发前请阅读 [贡献指南](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)；安全问题走 [SECURITY.md](SECURITY.md) 的私密渠道，不要在公开 issue 里贴凭据。

- [架构](docs/architecture.md) · [接口契约](docs/api-contract.md) · [项目结构](docs/project-structure.md)
- [验证记录](docs/validation.md) · [直接 HTTP 调研](docs/research/direct-api.md) · [发布说明](docs/distribution.md)
- [Skill](skills/taobao-search/SKILL.md) · [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [变更日志](CHANGELOG.md)

商品描述和参数只返回实际加载/识别到的字段，覆盖情况写入 `meta.coverage`；不把缺失信息包装成完整详情。
