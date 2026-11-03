---
name: taobao-product-search
description: 淘宝商品查询工具（纯 HTTP MTOP 直连）。当用户需要搜索淘宝商品、查商品规格/SKU、按规格核价（真实价格而非引流价）、批量比价或配单、查购物记录（已买到的宝贝/订单列表）、查商品评价/买家秀时使用。触发词：淘宝搜一下、查淘宝商品、淘宝价格、SKU 核价、批量查商品、商品比价、我的订单、购物记录、淘宝评价、买家秀。返回结构化 JSON，含标题/价格/库存/店铺/SKU 树/订单明细/评价列表。
agent_created: true
---

# Taobao Product Search

## Overview

通过捆绑的 CLI（零 npm 依赖，Node >= 22）直连淘宝 MTOP H5 网关查询商品数据与购物记录。六个命令：`search`（关键词搜索）、`specs`（规格树）、`detail`（按 SKU 核价）、`batch`（批量）、`orders`（已买到的宝贝）、`reviews`（商品评价列表）。输出统一 `{ ok, operation, data, error, meta }` JSON 信封。

## 关键约束（务必遵守）

- **限速是刻意的**：相邻 MTOP 请求强制 1.5–3.0 秒随机间隔，跨进程排队。不要并发调用多次 CLI，不要试图绕过。批量 50 项 ≈ 2 分钟是正常速度；orders 每页 15 条，翻页同样受限速。
- **列表价 ≠ 实价**：search 返回的价格是引流初筛价（可能偏低也可能偏高）。给用户报价格前，必须对候选商品跑 `detail` 按 SKU 核价。
- **凭证即登录态**：Cookie 等同用户淘宝登录态，绝不把 cookie 内容写进回复、文件或命令回显。
- **订单号是字符串**：17 位订单号超 JS number 精度，解析一律用对象键；输出保持字符串。
- **失败处理**：`AUTH_REQUIRED` = Cookie 过期/未配置，提示用户从浏览器重新复制并更新 cookie 文件；`ITEM_UNAVAILABLE` = 商品下架；触发滑块不会自动重试（防风控升级），直接告知用户。

## 调用方式

运行捆绑脚本（Windows Git Bash 示例）：

```bash
node "C:/Users/卡车猫/.workbuddy/skills/taobao-product-search/scripts/taobao.mjs" search "关键词" --limit 10
```

包装器按以下优先级解析 Cookie，**分发后无需重新打包**：

1. 环境变量 `TAOBAO_COOKIE_FILE`（显式指定即独占）
2. **skill 同级的 `cookie.json`**（即 SKILL.md 旁边）——复制 `scripts/taobao-cli/cookie.example.json` 到 skill 根目录改名为 `cookie.json`、填入 Cookie 字符串即可
3. 主项目 `D:\项目\taobao-script-search\.runtime\mtop-cookies.json`（开发机回退，默认走这条）

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

# 批量（输入 JSON：{ "searches": [{"keyword": "...", "options": {"limit": 5}}], "products": [{"itemId": "...", "specs": [{"labels": ["..."], "qty": 10}]}] })
... batch --file <清单.json> [--output 结果.json]

# 购物记录（已买到的宝贝；服务端固定每页 15 条，tabCode 仅实测过 all）
... orders [--page 1] [--tab all] [--pages N] [--output 订单.json]
# 返回 orders[]: orderId（全精度字符串）/shopName/status/paid/total/discount/items[{title,skuText,quantity,price,auctionId,pic}]

# 商品评价（每页最多 20 条；total 是封顶值，真实量级看 totalFuzzy；追评只在 counts.Append 计数里）
... reviews <itemId> [--page 1] [--size 20] [--pages N] [--output 评价.json]
# 返回 rates[]: id/rateType（原样透传）/content/sku/skuId/date/userNick/creditLevel/elite/reply/pics[]，及 counts{Good,Normal,NotGood,Pic,Append,...}
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

### 典型工作流：评价口碑参考

1. 推荐商品前可对候选商品跑 `reviews <itemId> --size 20` 抽查第一页评价
2. 看 `counts`（好评/差评/带图/追评比例）与 `content` 常见抱怨点，辅助判断商品质量
3. 评价列表用于口碑参考，不参与价格核验

## 资源

- `scripts/taobao.mjs` — 入口包装器（Cookie 三级优先级解析，见上）
- `scripts/taobao-cli/` — 完整 CLI 源码（零依赖）；`cookie.example.json` 为配置模板
- `cookie.json`（可选，同级放置）— 使用者凭证，**不会**随初始包分发，放进后重新打包会被包含，注意
- 主项目仓库：`D:\项目\taobao-script-search`（GitHub: xiahao-china/taobao-script-search，分支 main）
