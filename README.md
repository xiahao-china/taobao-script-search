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
# 1. 首次使用：复制根目录 cookie.example.json 为 cookie.json，
#    把 cookie 字段替换成你浏览器里 taobao.com 的完整 Cookie 字符串
cp cookie.example.json cookie.json

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

### 配置 Cookie

淘宝对匿名请求强制风控（RGV587 拦截），必须携带已登录浏览器的 Cookie：

1. 用 Chrome/Edge 登录 [taobao.com](https://www.taobao.com)
2. 按 F12 打开开发者工具 → **Network** 标签 → 刷新页面 → 点任意一个请求 → Request Headers 里的 `Cookie`，**整段复制**（也可从 Application → Cookies 面板逐条拼）
3. 复制根目录 `cookie.example.json` 为 `cookie.json`，把 `cookie` 字段的值整体替换为刚才的字符串，保存

`cookie.json` 已被 `.gitignore` 排除，**不会**被提交或上传；它等同你的登录态，也不要手动外发。查询时若未检测到登录态字段（`unb`/`cookie2`/`sgcookie`），CLI 会直接报 `AUTH_REQUIRED` 并给出配置指引，不会发起注定被拦的请求。

`cookie.json` 支持两种格式：简单格式 `{"cookie": "name=value; ..."}`（手动编辑推荐）与内部格式 `{"cookies": {...}}`（签名令牌自动续签后写回的形态，二者通用）。也可用 `taobao sync-cookie --cookie-string "..."` / `--stdin` 导入；已登录的令牌续签会自动写回同一文件。环境变量 `TAOBAO_COOKIE_FILE` 可指定其他路径。

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
