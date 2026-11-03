---
name: taobao-product-search
description: 淘宝商品查询工具（纯 HTTP MTOP 直连）。当用户需要搜索淘宝商品、查商品规格/SKU、按规格核价（真实价格而非引流价）、查店铺信誉（天猫标识/DSR 评分/店铺标签）、查评价数量与默认好评占比、批量比价或配单、查购物记录（已买到的宝贝/订单列表）时使用。触发词：淘宝搜一下、查淘宝商品、淘宝价格、SKU 核价、店铺评分、天猫还是淘宝、评价多少、批量查商品、商品比价、我的订单、购物记录。返回结构化 JSON，含标题/价格/库存/店铺/SKU 树/订单明细。
agent_created: true
---

# Taobao Product Search

## Overview

通过捆绑的 CLI（零 npm 依赖，Node >= 22）直连淘宝 MTOP H5 网关查询商品数据与购物记录。五个命令：`search`（关键词搜索）、`specs`（规格树）、`detail`（按 SKU 核价）、`batch`（批量）、`orders`（已买到的宝贝）。输出统一 `{ ok, operation, data, error, meta }` JSON 信封。

## 关键约束（务必遵守）

- **限速是刻意的**：相邻 MTOP 请求强制 5–10 秒随机间隔（默认 `TAOBAO_MTOP_MIN_INTERVAL_MS=5000` + `TAOBAO_MTOP_JITTER_MS=5000`，可用环境变量覆盖但调小有风控风险），跨进程排队。不要并发调用多次 CLI，不要试图绕过。深翻页/连续核价时保持同一节奏，宁可慢不可密——2026-11 实测 2 秒级连发 25+ 次即触发淘宝风控。批量 50 项 ≈ 6 分钟是正常速度；orders 每页 15 条，翻页同样受限速。
- **列表价 ≠ 实价**：search 返回的价格是引流初筛价（可能偏低也可能偏高）。给用户报价格前，必须对候选商品跑 `detail` 按 SKU 核价。
- **凭证即登录态**：Cookie 等同用户淘宝登录态，绝不把 cookie 内容写进回复、文件或命令回显。
- **订单号是字符串**：17 位订单号超 JS number 精度，解析一律用对象键；输出保持字符串。
- **失败处理**：`AUTH_REQUIRED` = Cookie 过期/未配置，提示用户从浏览器重新复制并更新 cookie 文件；`RISK_CONTROL` = 风控拦截（RGV587，请求指纹/频率问题，与登录态无关），**刻意不自动重试**（重试加重封禁）——等待几分钟、在浏览器正常访问一次 taobao.com 后再试；`ITEM_UNAVAILABLE` = 商品下架。batch 命中 AUTH/RISK 会立即终止剩余条目（`data.aborted`），处理后重跑。

## 调用方式

运行捆绑脚本（Windows Git Bash 示例）：

```bash
node "<skill目录>/scripts/taobao.mjs" search "关键词" --limit 10
```

包装器按以下优先级解析 Cookie，**分发后无需重新打包**：

1. 环境变量 `TAOBAO_COOKIE_FILE`（显式指定即独占）
2. **skill 同级的 `cookie.json`**（即 SKILL.md 旁边）——复制 `scripts/taobao-cli/cookie.example.json` 到 skill 根目录改名为 `cookie.json`、填入 Cookie 字符串即可
3. 主项目 `<TAOBAO_PROJECT_ROOT 或开发机默认路径>\.runtime\mtop-cookies.json`（开发机回退，默认走这条；换机/分发时设 `TAOBAO_PROJECT_ROOT` 指向主项目）

⚠️ 若把填好的 `cookie.json` 放进 skill 后再执行打包，真实凭证会被打进 zip——对外分发前先移走它。

### 命令速查

```bash
# 搜索（返回 itemId/title/priceText/shopName 等）
... search "0805电阻 10K" --limit 10 [--page 1] [--sort default]

# 规格树（返回 variants 数组，每项含 specId/skuId/label）
... specs <itemId>

# 按 SKU 核价（三种指定方式二选一）
... detail <itemId> --spec-id <specId>
... detail <itemId> --labels '["规格标签"]'
# detail 输出自带 store 块：sellerType（B=天猫 / C=淘宝集市）+ isTmall、
# DSR 三项分（含同行水平）、质量三评分、综合分、信用等级、店铺标签
# （好评率/发货时效等）。store 数据只在 PC 详情接口路径产出；H5 路径
# 与个人转卖商品均为 null（meta.coverage.store 据实标记）。

# 附带评价计数（多 1 次请求）
... detail <itemId> --labels '["规格标签"]' --reviews
# reviewSummary: total（平台封顶值）/ totalFuzzy（"2000+"）/ foldedDefault
# （折叠的默认好评数）/ foldedRatio——占比高提示刷单嫌疑。
# 平台已隐藏中差评分项，拿不到好评/差分明细数量，也不要向用户编造。

# 批量（输入 JSON：{ "searches": [{"keyword": "...", "options": {"limit": 5}}], "products": [{"itemId": "...", "specs": [{"labels": ["..."], "qty": 10}]}] })
... batch --file <清单.json> [--output 结果.json]

# 购物记录（已买到的宝贝；服务端固定每页 15 条，tabCode 仅实测过 all）
... orders [--page 1] [--tab all] [--pages N] [--output 订单.json]
# 返回 orders[]: orderId（全精度字符串）/shopName/status/paid/total/discount/items[{title,skuText,quantity,price,auctionId,pic}]
```

（上表 `...` 代表 `node "<skill路径>/scripts/taobao.mjs"`）

### 典型工作流：帮用户找商品并核价

1. 用用户描述的关键词 `search`（关键词用空格组合：品类 + 关键参数，如「游标卡尺 0.02 不锈钢」）
2. 从结果挑 2~4 个标题匹配的候选，逐个 `specs` 看规格档位
3. 对用户要的规格 `detail` 核实价与库存，对比后给推荐（附 itemId 与链接 `https://item.taobao.com/item.htm?id=<itemId>`）
4. 顺带核对规格档位的价格差（同一链接不同规格价差可能一倍以上）

### 典型工作流：购物记录统计

1. `orders --pages N --output orders.json` 拉取近 N 页（约 15×N 条，按需估算页数）
2. 订单级字段（paid）只聚合一次；按月/按店/按金额区间统计前先按 orderId 去重

## 资源

- `scripts/taobao.mjs` — 入口包装器（Cookie 三级优先级解析，见上）
- `scripts/taobao-cli/` — 完整 CLI 源码（零依赖）；`cookie.example.json` 为配置模板
- `cookie.json`（可选，同级放置）— 使用者凭证，**不会**随初始包分发，放进后重新打包会被包含，注意
- 主项目仓库：`D:\项目\taobao-script-search`（GitHub: xiahao-china/taobao-script-search，分支 main）
