---
name: taobao-product-search
description: 淘宝商品查询工具（纯 HTTP MTOP 直连）。当用户需要搜索淘宝商品、查商品规格/SKU、按规格核价（真实价格而非引流价）、查店铺信誉（天猫标识/DSR 评分/店铺标签）、查评价数量与默认好评占比、批量比价或配单、查购物记录（已买到的宝贝/订单列表）、查购物车当前内容（购物车里有什么/加购核对）、加入购物车（加购指定商品）、删除购物车商品（删掉不想要的加购条目）、在某家店铺内搜商品（店内搜索/搜本店）时使用。触发词：淘宝搜一下、查淘宝商品、淘宝价格、SKU 核价、店铺评分、天猫还是淘宝、评价多少、批量查商品、商品比价、我的订单、购物记录、购物车、加购了什么、加入购物车、帮我加购、删除购物车、删掉购物车里的、从购物车移除、店内搜索、这家店里搜。返回结构化 JSON，含标题/价格/库存/店铺/SKU 树/订单明细/购物车条目。
agent_created: true
---

# Taobao Product Search

## Overview

通过捆绑的 CLI（零 npm 依赖，Node >= 22）直连淘宝 MTOP H5 网关查询商品数据与购物记录。九个命令：`search`（关键词搜索）、`specs`（规格树）、`detail`（按 SKU 核价）、`shop-search`（店铺内搜索）、`batch`（批量）、`orders`（已买到的宝贝）、`cart-list`（购物车当前内容）、`cart-add`（加入购物车）、`cart-remove`（删除购物车条目）。输出统一 `{ ok, operation, data, error, meta }` JSON 信封。

## 关键约束（务必遵守）

- **限速是刻意的**：相邻 MTOP 请求强制 10–15 秒随机间隔（默认 `TAOBAO_MTOP_MIN_INTERVAL_MS=10000` + `TAOBAO_MTOP_JITTER_MS=5000`，可用环境变量覆盖但调小有风控风险），跨进程排队。不要并发调用多次 CLI，不要试图绕过。深翻页/连续核价时保持同一节奏，宁可慢不可密——2026-11 实测 2 秒级连发 25+ 次即触发淘宝风控。批量 50 项 ≈ 10 分钟是正常速度；orders 每页 15 条，翻页同样受限速。
- **禁止手拼未封装接口/参数**：不要用临时脚本直接调未封装的 MTOP 接口或自拼 `ttid`/`appVersion` 等参数。同一 Cookie 会话混入冲突的设备或协议指纹极易抬高账号风控分，甚至波及用户网页/App 端弹滑块。
- **禁止滥用 `--reviews` 与重复拉详情**：不要给所有候选默认带 `--reviews`，也不要对同一 `itemId` 反复跑 `specs` → `batch` → `detail`。高频拉 `pcdetail` 与评价接口会成倍推高风控密度，仅对最终锁定的 1–2 款按需查评价，同商品多规格用 `batch` 一次核完。
- **禁止无节制连翻 `orders`**：不要一次连续深翻 10+ 页订单，也不要短时间内密集累计数十次强登录态请求。`orders` 属强登录态隐私接口，实测数小时内叠加 20+ 页翻页与详情查询易触发账号侧风控；查旧订单先问大致时间跳页定位。
- **列表价 ≠ 实价**：search 返回的价格是引流初筛价（可能偏低也可能偏高）。给用户报价格前，必须对候选商品跑 `detail` 按 SKU 核价。
- **凭证即登录态**：Cookie 等同用户淘宝登录态，绝不把 cookie 内容写进回复、文件或命令回显。
- **订单号是字符串**：17 位订单号超 JS number 精度，解析一律用对象键；输出保持字符串。
- **失败处理**：`AUTH_REQUIRED` = Cookie 过期/未配置，提示用户从浏览器重新复制并更新 cookie 文件；`RISK_CONTROL` = 风控拦截（RGV587，请求指纹/频率问题，与登录态无关），**刻意不自动重试**（重试加重封禁）——等待几分钟、在浏览器正常访问一次 taobao.com 后再试；`ITEM_UNAVAILABLE` = 商品下架。batch 命中 AUTH/RISK 会立即终止剩余条目（`data.aborted`），处理后重跑。
- **请求日志**：`.runtime/log/mtop-request-log.jsonl` 每行一次真实请求（时间戳/接口/结果/限速等待 waitMs/耗时 ms），查节奏、复盘风控触发点用它；超 5MB 自动轮转同文件夹 `.old`，可整文件删除不影响功能。
- **操作日志**：`.runtime/log/mtop-operation-log.jsonl` 每行一次业务查询（时间戳/查询类型 search·specs·detail·orders·review-summary·shop-search·cart-list·cart-add·cart-remove·batch/入参/完整业务结果或错误码）。想回溯「当时搜了什么关键词、返回了哪些商品、详情价格多少、加购/删除了什么」看这份；两份日志同文件夹同轮转规则。

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
# detail 还会自动串联一次店铺接口，store 块附带 fansNum（粉丝数，数字）、
# ifHideFansNum（商家隐藏标志）、goldenSeller（金牌卖家）——粉丝数是店铺
# 选择的重要依据；店铺接口失败时静默降级，detail 本身不受影响。

# 附带评价计数（多 1 次请求）
... detail <itemId> --labels '["规格标签"]' --reviews
# reviewSummary: total（平台封顶值）/ totalFuzzy（"2000+"）/ foldedDefault
# （折叠的默认好评数）/ foldedRatio——占比高提示刷单嫌疑。
# 平台已隐藏中差评分项，拿不到好评/差分明细数量，也不要向用户编造。

# 店铺内搜索（在某家店铺里搜商品；店铺引用=完整 URL 或数字 shopId）
... shop-search "0805 电阻" https://shop131282813.taobao.com [--page 1] [--pages 1]
... shop-search "0805 电阻" 131282813
# 返回 items[]: itemId/title/priceText（现价，字体反爬已还原）/strikethroughText
# （划线价）/salesText（已售）/url/imageUrl；data.total（匹配总数）/pages。
# wid（店铺挂件号）自动从店铺页提取并缓存 .runtime/shop-wid.json；每次搜索
# 先抓一次店铺搜索页配对价格字体（同会话页面字体 × 搜索数据），价格解不出时
# priceText=null 且 priceUnknown=true（混合策略，不臆造）。昵称子域名
# （如 youxin-electronic.taobao.com）与数值子域名均可。
# meta.widSource：page=本次现取 / cache=缓存复用 / cache-degraded=页面被风控
# 或改版导致 wid 提取失败，用缓存 wid 降级搜索（此时价格必为 null）。

# 批量（输入 JSON：{ "searches": [{"keyword": "...", "options": {"limit": 5}}], "products": [{"itemId": "...", "specs": [{"labels": ["..."], "qty": 10}]}] })
... batch --file <清单.json> [--output 结果.json]
# 带 --output 时每完成一项即原子重写部分结果（ok:false + partial:true，
# 含已完成 results 与 succeeded/failed 统计）——中途 Ctrl+C 或命中
# AUTH/RISK 提前终止，已跑完的数据也在文件里；完整跑完后再被正常信封覆盖。

# 购物记录（已买到的宝贝；服务端固定每页 15 条，tabCode 仅实测过 all）
... orders [--page 1] [--tab all] [--pages N] [--output 订单.json]
# 返回 orders[]: orderId（全精度字符串）/shopName/status/paid/total/discount/items[{title,skuText,quantity,price,auctionId,pic}]

# 购物车当前内容（只读，1 次请求；mtop.trade.query.bag 5.0，登录态接口）
... cart-list
# 返回 items[]: cartId（购物车条目 ID，全精度字符串）/itemId/title/sku{skuId,title}
# （无规格商品为 null）/quantity/priceText（实价文案剥离，非列表引流价）/pic/url/
# shopName/shopId/isChecked/canCheck；shops[]（店铺名/shopId）；summary{itemCount,
# checkedCount,totalPriceText,totalDiscountText,submitTitle}。
# 购物车价格是加购时点价，可能与当前实价不同——报价前仍应以 detail 核价为准。

# 加入购物车（写操作；PC 网页端点 cart.taobao.com/add_cart_item.htm + 回读核对）
... cart-add <商品ID> [--sku-id <规格ID>] [--quantity 1]
# 无规格商品不传 --sku-id；有规格商品传 specs 输出的 skuId（⚠️ sku 路径有开源
# 参照但未实测，首次对 sku 商品加购建议加购后 cart-list 人工复核）。
# 加购后自动回读 query.bag 核对：entryFound=true 为确认成功（meta.verification=
# query-bag-confirmed）；quantity 为本次加入数量。重复加购同商品=数量累加。
# 前提：Cookie 须含 _tb_token_（浏览器登录态自带）；响应 cartQuantity 是网关
# 全量计数（含失效条目），与 cart-list 条目数不一致是常态，不要互相换算。

# 删除购物车条目（写操作，不可逆；mtop.trade.update.bag 4.0 + 回读核对，3 次请求）
... cart-remove <cartId>
# cartId 用 cart-list 输出的条目 ID（item_<cartId>）。删除后自动回读核对：
# entryGone=true 为确认成功（meta.verification=query-bag-confirmed），remainingCount
# 为删除后剩余条目数。条目不存在报 NO_RESULTS。走 dinamicx 链接协议（query.bag
# 拉树取签名 → 构造 payload POST update.bag → 回读），全程全局限速。
```

（上表 `...` 代表 `node "<skill路径>/scripts/taobao.mjs"`）

### 典型工作流：帮用户找商品并核价

1. 用用户描述的关键词 `search`（关键词用空格组合：品类 + 关键参数，如「游标卡尺 0.02 不锈钢」）
2. 从结果挑 2~4 个标题匹配的候选，逐个 `specs` 看规格档位
3. 对用户要的规格 `detail` 核实价与库存，对比后给推荐（附 itemId 与链接 `https://item.taobao.com/item.htm?id=<itemId>`）
4. 顺带核对规格档位的价格差（同一链接不同规格价差可能一倍以上）

### 典型工作流：店内搜索比价

1. 用户指定店铺（或先 `detail` 任意该店商品，输出里店铺 URL 可能缺失——直接问用户要店铺链接更快）
2. `shop-search <关键词> <店铺URL或shopId>` 拉店内候选（现价已还原，划线价可对比折扣）
3. 候选商品仍按全局规矩跑 `detail` 按 SKU 核价后再推荐——店内列表价同样可能 ≠ 实价

### 典型工作流：购物记录统计

1. `orders --pages N --output orders.json` 拉取近 N 页（约 15×N 条，按需估算页数）
2. 订单级字段（paid）只聚合一次；按月/按店/按金额区间统计前先按 orderId 去重

### 典型工作流：加购核对

1. `cart-list` 看购物车现有内容（避免重复加购/核对价格与规格）
2. 用户确认要加购的商品后，`cart-add <商品ID> [--sku-id <规格ID>]` 加购——命令自带回读核对，报告 entryFound 与购物车内数量；加购是写操作，只做用户明确指定的商品，绝不批量或顺手加购
3. 重复加购同商品 = 数量累加（不产生重复条目）；改数量请让用户在购物车里手动处理

### 典型工作流：删除购物车条目

1. `cart-list` 确认要删条目的 cartId（按 itemId/标题/店铺匹配用户描述）
2. 报给用户确认后再 `cart-remove <cartId>`——**删除不可逆**，必须逐条经用户明确确认，绝不批量清理
3. 输出 entryGone=true 即确认成功；用户说「把购物车清空」这类请求仍建议用户手动全选删除

## 资源

- `scripts/taobao.mjs` — 入口包装器（Cookie 三级优先级解析，见上）
- `scripts/taobao-cli/` — 完整 CLI 源码（零依赖）；`cookie.example.json` 为配置模板
- `cookie.json`（可选，同级放置）— 使用者凭证，**不会**随初始包分发，放进后重新打包会被包含，注意
- 主项目仓库：`D:\项目\taobao-script-search`（GitHub: xiahao-china/taobao-script-search，分支 main）
