# 统一接口

SDK 导出 `createTaobaoClient(options)`；它是常驻服务客户端，短命进程结束后服务继续保留。

```js
const client = createTaobaoClient();
await client.search(keyword, options);
await client.getSpecs(itemId, options);
await client.getDetail(itemId, spec, options);
await client.batch(batchInput);
```

业务输出：

```js
{
  ok: true,
  operation: 'getDetail',
  data: { /* 下列业务字段 */ },
  error: null,
  meta: { provider, observedAt, cached, elapsedMs, manualWaitMs }
}
```

业务错误返回 `ok: false` 与 `{ code, message, details }`。IPC/启动错误可能抛出 `TaobaoError`。金额、商品 ID、SKU ID 和属性 ID 都保持字符串；缺失值为 `null`。

## search(keyword, options)

关键词必填。可选 `limit`（1–48）、`page`（正整数）、`sort`（default/price-asc/price-desc/sales）、`forceRefresh`。

`data` 包含 `keyword`、`page`、`sort`、`items`、`total`。每项包含 `itemId`、`title`、`url`、`imageUrl`、`shopName`、`salesText`、`priceText` 和 `priceSummary`。列表价的 `scope` 固定为 `item-summary`，不能当作选中规格价。

只有成功识别到页面的明确空结果才返回空列表；登录、验证、未知结构与超时均返回明确错误。

## getSpecs(itemId, options)

`data` 为 `{ itemId, groups, variants, mode }`。

- `groups`：`groupId`、名称以及 `values`，每个值含 `valueId`、标签、`available`。
- `variants`：真实存在的组合；包含 `specId`、可用时的真实 `skuId`、标签、完整 `selections`。
- `mode`：`variants`、`select-by-groups`、`single-variant` 或 `unknown`。

有结构化 SKU 数据时，`specId` 形如 `sku:553226711...`。只有 DOM 且为单规格组时，生成稳定的 `dom:...` 选择标识；这不是淘宝真实 SKU ID。多属性 DOM 页面不凭空生成笛卡尔积，调用方选择每个组的值，并在详情中核验合法组合。

## getDetail(itemId, spec, options)

选择方式须且只能提供一种：

```js
{ specId: 'getSpecs 返回的 ID' }
{ skuId: '真实 SKU ID' }
{ selections: [{ groupId: '...', valueId: '...' }, /* 每组一个 */] }
{ labels: ['完整精确标签'] } // 兼容文本选择，须唯一匹配并覆盖各组
{ kind: 'default' }         // 只用于已经确认的单规格商品
```

不存在或不属于该商品的 SKU、模糊标签、不可选属性、组合缺失都返回错误。

`data` 包含商品/规格标识、`specLabel`、`selections`、标题、链接、店铺、价格、库存、配送、参数、描述、图片和页面选中标签。价格含十进制 `amount`、`currency`、`basis`、原始显示文本、`scope: selected-spec` 及观察时间。

`basis: displayed` 表示解析的页面/接口显示价；文本明确有“优惠前”时原文保留在 `display`。仅券后/预估价格标为 `conditional`；未标明口径的接口价标为 `api-displayed`。这些均不等同于最终付款价。

`meta.priceEvidence` 为 `sku-id-map`、`selection-and-price-update` 或 `already-selected`；`meta.coverage` 标注库存、运费、参数及描述是否取得。当前描述和参数只返回已加载且识别到的内容，缺失时保持 `null`。

`stock` 保留接口的 quantity 值，可能有显示上限，不能用作包装件数。每包数量以选中规格标签及对应详情为准。

## 批量输入

```json
{
  "searches": [{ "keyword": "M3盘头螺丝", "options": { "limit": 5 } }],
  "products": [
    {
      "itemId": "805012477549",
      "options": { "forceRefresh": true },
      "specs": [{ "labels": ["M3*10(200个)"] }, { "labels": ["M3*6(500个)"] }]
    }
  ]
}
```

每个 product 先产生一项规格结果，然后产生每个 spec 的详情结果；输出按这份输入的顺序排列。也可提供 `tasks: [{ operation, params }]`，操作名为 search/getSpecs/getDetail，最多 200 项。

`searches` 一次最多 3 项；超出返回 `INVALID_ARGUMENT`。关键词搜索复用同一个搜索标签，连续提交会让页面在多个结果间反复跳转并触发风控，需要多个关键词时拆成多次调用、间隔 ≥25 秒。

批量输出的 `data` 包含各项完整 `results` 和 total/succeeded/failed。整体有失败时返回 `BATCH_PARTIAL_FAILURE`，保留已成功的结果。

## 常见错误

`INVALID_ARGUMENT`、`AUTH_REQUIRED`、`VERIFICATION_REQUIRED`、`DATA_TIMEOUT`、`ITEM_UNAVAILABLE`、`SKU_NOT_FOUND`、`SKU_UNAVAILABLE`、`SPEC_AMBIGUOUS`、`SPEC_UNAVAILABLE`、`SKU_SELECTION_FAILED`、`SKU_PRICE_UNCONFIRMED`、`CANCELLED`。

服务诊断命令为 start/status/job/stop。启动配置不随每次查询改变；需要更换配置时先停止再启动。
