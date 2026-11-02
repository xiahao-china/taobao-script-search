# Taobao Script Search

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

纯 HTTP 直连淘宝 MTOP 网关的商品查询 CLI / SDK。**零浏览器依赖、零守护进程、零 npm 依赖**——读取本地 Cookie 缓存后直接请求 `h5api.m.taobao.com`，毫秒级返回 JSON。

## 工作原理

1. 淘宝 H5 前端拉数据用的是 MTOP 接口；签名算法固定为 `MD5(token & 时间戳 & appKey & data)`，约 50 行原生 Node 代码即可实现。
2. 匿名请求会被 RGV587 风控拦截，因此需要**已登录浏览器的 Cookie**（登录态字段 `unb`/`cookie2`/`sgcookie` 等）。
3. `_m_h5_tk` 签名令牌由脚本自动续签；登录态 Cookie 有效期数天~两周，失效时重新导入。

## 快速开始

```bash
# 1. 首次使用：浏览器 F12 → Application → Cookies → 复制 taobao.com 下的 Cookie 字符串
node bin/taobao.js sync-cookie --cookie-string "cookie2=...; unb=...; ..."
#    或从文件/管道导入：
node bin/taobao.js sync-cookie --stdin < cookie.txt

# 2. 查询
node bin/taobao.js search "M3盘头螺丝" --limit 5
node bin/taobao.js specs 786222261977
node bin/taobao.js detail 786222261977 --labels '["M3*8（200个）"]'
node bin/taobao.js batch --file 批量清单.json --output artifacts/quotes.json
```

批量清单格式（`searches` 与 `products` 可只留其一；单失败不影响其余任务）：

```json
{
  "searches": [
    { "keyword": "M3盘头螺丝", "options": { "limit": 5 } }
  ],
  "products": [
    {
      "itemId": "805012477549",
      "specs": [
        { "labels": ["M3*10(200个)"] },
        { "specId": "sku:实际返回的SKU_ID" }
      ]
    }
  ]
}
```

`specs` 缺省时该商品只返回规格树（getSpecs），适合先探再选。

Cookie 明文存于 `.runtime/mtop-cookies.json`（已 gitignore），等同登录态，不要提交或外发。

## 内置风控防护

- 相邻 MTOP 请求强制 **1.5–3.0 秒随机间隔**，跨进程经 `.runtime/mtop-pacing.json` 排队
- token 过期自动重签重试（仅一次，不重试风控拦截）
- 触发滑块 / 登录失效时明确报 `AUTH_REQUIRED`，不重试轰炸

## 统一接口

```js
import { createMtopClient } from 'taobao-script-search';
const client = createMtopClient();
const list = await client.search('M3盘头螺丝', { limit: 5 });
const specs = await client.getSpecs('786222261977');
const chosen = specs.data.variants.find(value => value.label === 'M3*8（200个）');
const detail = await client.getDetail('786222261977', { specId: chosen.specId });
```

所有操作共用 `{ ok, operation, data, error, meta }` 输出封装。金额与 ID 使用字符串；列表价格为引流初筛价，**指定规格的详情（`sku2info` 按 SKU 绑定）才用于核价**。`meta` 标注观察时间、价格依据与字段覆盖；无法确认的字段保持 `null`。

CLI 与 SDK 是同一实现（`search` / `getSpecs` / `getDetail` / `batch`）。接口输出契约见 [docs/api-contract.md](docs/api-contract.md)；目录说明见 [docs/project-structure.md](docs/project-structure.md)。

## 调试与测试（开发工具，均在 tools/）

- `npm test` — 本地逻辑回归（规格解析、Cookie 罐、单 SKU 边界）
- `npm run probe:mtop` — 匿名 MTOP 连通性探测（无 Cookie、有限请求）
- `node tools/debug-catalog.mjs` — dump 商品接口返回结构到 `.runtime/last-catalog.json`

## 许可

MIT。本工具仅用于个人物料查询，请控制请求频率、遵守平台规则。
