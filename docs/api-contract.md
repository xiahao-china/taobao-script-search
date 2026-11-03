# 统一接口

SDK 导出 `createMtopClient(options)`；纯 HTTP 直连 MTOP 网关，进程随调随退，无常驻服务。

```js
import { createMtopClient } from 'taobao-script-search';
const client = createMtopClient();
await client.search(keyword, options, signal);
await client.getSpecs(itemId, options, signal);
await client.getDetail(itemId, spec, options, signal);
await client.getOrders(options, signal);
await client.batch(batchInput, signal);
```

业务输出：

```js
{
  ok: true,
  operation: 'detail',
  data: { /* 下列业务字段 */ },
  error: null,
  meta: { provider, observedAt }
}
```

`meta.provider` 为 `mtop-http`（列表/规格）、`mtop-http-sku`（SKU 核价）或 `mtop-http-default`（默认规格）。业务错误返回 `ok: false` 与 `{ code, message, details }`。金额、商品 ID、SKU ID 和属性 ID 都保持字符串；缺失值为 `null`。

每个方法接受可选 `AbortSignal`（第三个参数 / batch 第二个参数），取消时抛 `CANCELLED`。

## search(keyword, options, signal)

关键词必填。可选 `limit`（1–48）、`page`（正整数）、`sort`（default/price-asc/price-desc/sales）。

`data` 包含 `keyword`、`page`、`sort`、`items`、`total`（恒为 null，搜索接口不分页总数）。每项包含 `itemId`、`title`、`url`、`imageUrl`、`shopName`、`salesText`、`priceText` 和 `priceSummary`。列表价的 `scope` 固定为 `item-summary`，是初筛展示价，**不能当作选中规格价**。

无结果抛 `NO_RESULTS`；登录态失效抛 `AUTH_REQUIRED`。

## getSpecs(itemId, options, signal)

`data` 为 `{ itemId, groups, variants, mode }`。

- `groups`：`groupId`、名称以及 `values`，每个值含 `valueId`、标签、`available`。
- `variants`：真实存在的组合；包含 `specId`（形如 `sku:553226711...`）、真实 `skuId`、标签、完整 `selections`。
- `mode`：`variants`、`select-by-groups` 或 `single-variant`。

## getDetail(itemId, spec, options, signal)

选择方式须且只能提供一种：

```js
{ specId: 'getSpecs 返回的 ID' }
{ skuId: '真实 SKU ID' }
{ selections: [{ groupId: '...', valueId: '...' }, /* 每组一个 */] }
{ labels: ['完整精确标签'] } // 须唯一匹配并覆盖各组
{ kind: 'default' }         // 只用于已经确认的单规格商品
```

不存在或不属于该商品的 SKU、模糊标签、不可选属性、组合缺失都返回错误。

**价格口径**：指定了具体 SKU（`skuId` 非空）时只采信 `sku2info` 中该 SKU 的价格；接口缺失该 SKU 价格时抛 `SKU_PRICE_UNCONFIRMED`，**绝不回退到商品默认/引流价**。仅 `{ kind: 'default' }` 才返回默认价（`scope: item-default`）。

`data` 包含商品/规格标识、`specLabel`、`selections`、标题、链接、店铺、价格、库存、参数、图片和选中标签。价格含十进制 `amount`、`currency`、`basis`、原始显示文本、`scope` 及观察时间。`basis: api-displayed` 表示接口显示价，不等同于最终付款价。`meta.priceEvidence` 为 `sku-id-map` 或 `default-sku`。

`stock` 保留接口的 quantity 值，可能有显示上限，不能用作包装件数。

## getOrders(options, signal)

购物记录（已买到的宝贝），接口 `mtop.taobao.order.queryboughtlistV2` v1.0。可选 `page`（正整数，默认 1）与 `tab`（订单页签码，仅实测过 `all`）。服务端固定每页 15 条。

```js
const result = await client.getOrders({ page: 1 }, signal);
// result.data: { page, tab, orders, pagination }
// pagination: { currentPage, totalPage, pageSize, totalNumber }
// orders[i]: {
//   orderId,   // 全精度订单号（字符串）
//   shopName, status,                    // 状态文案如「买家已付款」「交易成功」
//   paid, total, discount,               // 金额字符串（「￥x.xx」剥离而来），缺失为 null
//   items: [{ title, skuText, quantity, price, auctionId, pic }]
// }
```

订单号取自响应组件对象键（JSON number 会丢精度），17 位保持原样。`price` 取 `priceInfo` 中第一个可剥离的数值字段（actualTotalFee → realTotal → promotion → original）。无订单数据抛 `NO_RESULTS`；登录态失效抛 `AUTH_REQUIRED`。页间隔沿用全局限速，连续翻页请在调用方自控。

## batch(input, signal)

```json
{
  "searches": [{ "keyword": "M3盘头螺丝", "options": { "limit": 5 } }],
  "products": [
    {
      "itemId": "805012477549",
      "specs": [{ "labels": ["M3*10(200个)"] }, { "labels": ["M3*6(500个)"] }]
    }
  ]
}
```

- `specs` 省略或传 `[null]` 时该商品只产生一项规格树结果；每个 spec 产生一项详情结果。
- **同一商品的 catalog 只请求一次**，多规格在内存中复用解析。
- 输出 `data = { results, total, succeeded, failed }`；单项失败不影响其余项，失败项带 `error: { code, message }`，整体 `ok` 恒为 `true`（部分失败通过 `failed > 0` 表达）。

## 常见错误

`INVALID_ARGUMENT`、`AUTH_REQUIRED`（未配置 Cookie / 登录态失效 / 风控拦截）、`NETWORK_ERROR`、`NO_RESULTS`、`ITEM_UNAVAILABLE`、`SKU_NOT_FOUND`、`SKU_UNAVAILABLE`、`SPEC_AMBIGUOUS`、`SPEC_UNAVAILABLE`、`SKU_PRICE_UNCONFIRMED`、`DEFAULT_PRICE_UNCONFIRMED`、`CANCELLED`。
