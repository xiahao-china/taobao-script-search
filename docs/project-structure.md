# 项目结构

纯 HTTP MTOP 直连实现，Node.js 单包项目（ESM，零运行时依赖）。日期：2026-11-03。仓库根目录即项目根目录。

```text
taobao-script-search/
├── package.json / package-lock.json    脚本与元数据（无运行时依赖）
├── README.md / CHANGELOG.md            使用说明与版本记录
├── LICENSE                             MIT
├── .gitignore / .gitattributes / .editorconfig / .gitleaks.toml
├── bin/taobao.js                       CLI 可执行入口
├── src/                                运行时代码
│   ├── index.js                        公开 SDK（createMtopClient）
│   ├── cli.js                          参数解析、sync-cookie、JSON 输出
│   ├── core/
│   │   ├── mtop-client.js              MTOP 请求客户端：MD5 签名、token 自动续签、
│   │   │                               跨进程限速（5–10s 抖动，原子写入排队记录）、
│   │   │                               风控报错
│   │   ├── cookie-store.js             Cookie 罐：根目录 cookie.json（优先）与
│   │   │                               .runtime/mtop-cookies.json（回退）读写、
│   │   │                               Set-Cookie 合并、过期清理、Cookie 头构造
│   │   ├── config.js                   项目/运行时目录解析
│   │   ├── errors.js                   统一结果与错误（TaobaoError）
│   │   ├── json-body.js                apiStack 内嵌 JSON 字符串解析（parseBody）
│   │   ├── money.js                    价格文本与口径
│   │   └── url.js                      图片/链接协议归一化（normalizeUrl）
│   └── adapters/taobao/
│       ├── mtop.js                     search / specs / detail / orders /
│       │                               getReviewSummary / batch 纯 HTTP 实现；
│       │                               详情双保险 getdetail/6.0 → pcdetail.data.get/1.0
│       ├── specs.js                    规格解析通用件：extractCatalog、resolveSpec、
│       │                               skuPrice（纯函数）
│       └── orders.js                   订单组件流解析：mapOrder、extractOrders、
│                                       assertOrdersPayload（纯函数）
├── skill/                              WorkBuddy skill 分发源（SKILL.md +
│ │                                     scripts/taobao.mjs 包装器；npm run pkg 打包）
│   └── ...
├── tools/                              开发阶段工具（测试 + 调试 + 探测）
│   ├── mtop-local.test.js              本地逻辑回归：规格解析、Cookie 罐、订单解析、
│   │                                   单 SKU 边界
│   ├── export-orders-csv.mjs           全量购物记录导出 CSV（appVersion 3.0 扁平
│   │                                   组件流，断点续传）
│   ├── debug-catalog.mjs               接口返回结构 dump 到 .runtime/last-catalog.json
│   └── probe-mtop.js                   匿名 MTOP 连通性探测（无 Cookie）
├── docs/
│   ├── api-contract.md                 输出契约（字段与错误码）
│   ├── project-structure.md            本文件
│   └── research/direct-api.md          2026-10 直接 HTTP 调研归档
├── cookie.example.json                 Cookie 配置模板（进仓库）；复制为 cookie.json 使用
├── cookie.json                         使用者的 Cookie（gitignore，等同登录态，勿外发）
└── .runtime/                           本地运行时（gitignore）：
    ├── mtop-cookies.json               Cookie 缓存回退（未提供 cookie.json 时使用）
    ├── mtop-pacing.json                跨进程限速排队记录
    └── last-catalog.json               debug-catalog 的最近 dump
```

批量清单格式与 SDK 用法见 README；无 examples 目录。

历史说明：v0.2 及之前的 Playwright 常驻服务（`src/browser/`、`src/service/`、DOM 适配器、打包发布链）已在 v0.3 移除，由纯 HTTP MTOP 客户端替代；v0.3 同步合并 `scripts/`+`tests/` 为 `tools/`、移除 `examples/`。调研背景见 `docs/research/direct-api.md`。
