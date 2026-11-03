import { TaobaoError, requireId } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { MtopClient, parseBody } from '../../core/mtop-client.js';
import { normalizeUrl } from '../../core/url.js';
import { extractCatalog, resolveSpec, publicSpecs, skuPrice } from './specs.js';
import { assertOrdersPayload } from './orders.js';

const ORDER_TAB_PATTERN = /^[a-z_]{2,20}$/;
// 订单接口挂在「已买到的宝贝」页面上下文；网关要求登录请求标记（ecode=1）。
const ORDER_REQUEST = {
  extraParams: { ecode: '1', AntiCreep: 'true', AntiFlood: 'true', LoginRequest: 'true', ttid: '##h5' },
  referer: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
};
const ORDER_API = ['mtop.taobao.order.queryboughtlistV2', '1.0'];
// 评价计数接口：只要汇总字段，rateList 内容丢弃。
const RATE_API = ['mtop.taobao.rate.detaillist.get', '4.0'];

const SORTS = { default: '', 'price-asc': 'price-asc', 'price-desc': 'price-desc', sales: 'sale-desc' };
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const stripTags = value => clean(String(value || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '));

// apiStack 的 value 常是内嵌 JSON 字符串；深搜前先把对象字符串解开。
function expand(data) {
  const queue = [data], seen = new Set(), nodes = [];
  for (let visited = 0; queue.length && visited < 2000; visited++) {
    let value = queue.shift();
    if (typeof value === 'string' && value.trim().startsWith('{')) value = parseBody(value);
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    nodes.push(value);
    for (const child of Object.values(value).slice(0, 200)) if (typeof child === 'object' || typeof child === 'string') queue.push(child);
  }
  return nodes;
}

const ITEM_KEYS = ['itemId', 'item_id', 'id'];
const looksLikeItem = row => row && typeof row === 'object' &&
  ITEM_KEYS.some(key => /^\d{6,}$/.test(String(row[key] ?? '')));

function collectRows(data) {
  if (Array.isArray(data?.itemsArray)) return data.itemsArray;
  if (Array.isArray(data?.data?.itemsArray)) return data.data.itemsArray;
  for (const node of expand(data)) {
    for (const value of Object.values(node)) {
      if (Array.isArray(value) && value.length && value.some(looksLikeItem)) return value;
    }
  }
  return [];
}

function mapItem(row) {
  const itemId = String(row.itemId ?? row.item_id ?? row.id ?? '');
  if (!/^\d+$/.test(itemId)) return null;
  const priceText = typeof row.price === 'object' && row.price ? (row.price.priceText ?? null)
    : (row.showPrice ?? row.view_price ?? row.priceText ?? (typeof row.price === 'string' ? row.price : null)) ?? null;
  return {
    itemId,
    title: stripTags(row.title),
    priceText: priceText === null || priceText === undefined ? null : String(priceText),
    shopName: row.shopName ?? row.nick ?? row.shop_nick ?? row.seller?.shopName ?? null,
    salesText: row.view_sales ?? row.salesText ?? row.sales ?? null,
    url: `https://item.taobao.com/item.htm?id=${itemId}`,
    imageUrl: normalizeUrl(row.picUrl ?? row.pic_path ?? row.imageUrl ?? row.pic),
  };
}

// 店铺信誉块：sellerNode = pcdetail 顶层 seller（DSR 三项），
// storeNode = componentsVO.storeCardVO（质量三评分/综合分/信用等级/标签）。
// h5 getdetail 路径两者皆无 → 返回 null，detail 输出如实标 store:null。
export function buildStoreRecord(sellerNode, storeNode) {
  const sellerType = sellerNode?.sellerType ?? storeNode?.sellerType ?? null;
  const dsr = Array.isArray(sellerNode?.evaluates)
    ? sellerNode.evaluates.map(entry => ({
      type: entry.type ?? null,
      title: clean(entry.title),
      score: clean(entry.score),
      levelText: typeof entry.levelText === 'string' ? clean(entry.levelText) : null,
    })) : null;
  const scores = Array.isArray(storeNode?.evaluates)
    ? storeNode.evaluates.map(entry => ({ title: clean(entry.title), score: clean(entry.score) }))
    : null;
  const labels = Array.isArray(storeNode?.labelList)
    ? storeNode.labelList.map(entry => clean(entry?.contentDesc)).filter(Boolean) : null;
  if (!sellerType && !dsr && !scores && !labels) return null;
  return {
    sellerType,
    isTmall: sellerType === 'B',
    dsr,
    scores,
    overallScore: typeof storeNode?.overallScore === 'string' ? clean(storeNode.overallScore) : null,
    creditLevel: storeNode?.creditLevel ?? null,
    labels,
  };
}

// 与 DOM 版 buildSpecs 输出同构，但组/值全部来自 skuBase，无 DOM 参与。
export function buildMtopSpecs(itemId, catalog) {
  const props = Array.isArray(catalog.skuBase?.props) ? catalog.skuBase.props : [];
  const groups = props.map((prop, index) => ({
    groupId: String(prop.pid), name: clean(prop.name), index,
    values: (prop.values || []).map((value, valueIndex) => ({
      valueId: String(value.vid), label: clean(value.name), available: true, index: valueIndex,
    })),
  }));
  const nativeSkus = Array.isArray(catalog.skuBase?.skus) ? catalog.skuBase.skus : [];
  const variants = nativeSkus.flatMap(sku => {
    if (!sku.skuId || String(sku.skuId) === '0') return [];
    const selections = (sku.propPath || '').split(';').filter(Boolean).map(pair => {
      const [groupId, valueId] = pair.split(':');
      return { groupId, valueId };
    });
    if (selections.length !== groups.length) return [];
    const label = selections.map(selection => {
      const group = groups.find(group => group.groupId === selection.groupId);
      return group?.values.find(value => value.valueId === selection.valueId)?.label;
    }).join(' / ');
    // 只用存在性校验判定 label 有效性；不做 'undefined' 字符串判断，
    // 否则真实规格名恰好含该词时会被误杀。
    if (selections.some(selection => !groups.find(group => group.groupId === selection.groupId)?.values.some(value => value.valueId === selection.valueId))) return [];
    return [{ specId: `sku:${sku.skuId}`, skuId: String(sku.skuId), selections, label }];
  });
  if (!variants.length && !groups.length && nativeSkus.length === 1 && nativeSkus[0].skuId && String(nativeSkus[0].skuId) !== '0') {
    variants.push({ specId: `sku:${nativeSkus[0].skuId}`, skuId: String(nativeSkus[0].skuId), selections: [], label: '默认规格' });
  }
  // 无规格组的单 SKU 商品沿用 DOM 版的 mode，保证 kind=default 可解析。
  const mode = groups.length ? (variants.length ? 'variants' : 'select-by-groups') : 'single-variant';
  return { itemId, groups, variants, mode };
}

function defaultPrice(catalog) {
  const record = catalog.skuCore?.sku2info?.['0'];
  return recordPrice(record);
}

// skuPrice 依赖 parsePrice 对「title + 价格」整串的解析；MTOP 返回里
// priceTitle 有时是「淘金币可抵」之类的文案，直接单解析 priceText 兜底。
export function recordPrice(record) {
  const text = record?.price?.priceText;
  if (typeof text !== 'string') return null;
  const price = parsePrice([text]);
  return price ? { ...price, basis: 'api-displayed', stock: record.quantity ?? null } : null;
}

function skuPriceLoose(catalog, skuId) {
  if (!skuId || skuId === '0') return null;
  return skuPrice(catalog, skuId) || recordPrice(catalog.skuCore?.sku2info?.[skuId]);
}

export class MtopAdapter {
  constructor(options = {}) {
    this.options = { runtimeDir: null, ...options };
    this.client = options.client || new MtopClient(options);
  }

  async search(keyword, options = {}, signal) {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new TaobaoError('INVALID_ARGUMENT', '关键词不能为空。');
    keyword = keyword.trim();
    const params = { page: 1, limit: 20, sort: 'default', ...options };
    if (!Number.isInteger(params.page) || params.page < 1 || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 48 || !(params.sort in SORTS)) {
      throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数，limit 为 1–48，sort 为 default/price-asc/price-desc/sales。');
    }
    const data = await this.client.request('mtop.taobao.wsearch.appsearch', '1.0', {
      q: keyword, search_action: 'initiative', page: String(params.page),
      n: String(params.limit), sversion: '9.9.9', ...(SORTS[params.sort] ? { sort: SORTS[params.sort] } : {}),
    }, { signal });
    const items = collectRows(data).map(mapItem).filter(Boolean).slice(0, params.limit);
    if (!items.length) throw new TaobaoError('NO_RESULTS', '搜索接口未返回商品数据；可能是关键词无结果或返回结构变化。');
    return {
      data: {
        keyword, page: params.page, sort: params.sort,
        items: items.map(item => ({ ...item, priceSummary: { ...(parsePrice([item.priceText]) || { amount: null, display: item.priceText }), scope: 'item-summary' } })),
        total: null,
      },
      meta: { provider: 'mtop-http', observedAt: new Date().toISOString() },
    };
  }

  // 详情接口双保险：H5 getdetail 优先，拿不到 skuBase/skuCore 时退回 PC 接口。
  // 接口级失败（MTOP_ERROR/NETWORK_ERROR）同样降级到备用接口；取消与鉴权错误直接上抛。
  // 商品标题/店铺名与规格数据可能分布在不同层级，同一次响应里一并深搜提取。
  // 注意：H5 路径的响应里没有店铺信誉节点，store 恒为 null；store 数据只在
  // pcdetail 路径产出（README「店铺信誉」一节的 store:null 情形即由此而来）。
  async fetchCatalog(itemId, signal) {
    const attempts = [
      ['mtop.taobao.detail.getdetail', '6.0', { id: itemId, exParams: JSON.stringify({ id: itemId }) }],
      ['mtop.taobao.pcdetail.data.get', '1.0', {
        id: itemId, detail_v: '3.3.2',
        exParams: JSON.stringify({ id: itemId, domain: 'https://item.taobao.com', path_name: '/item.htm' }),
      }],
    ];
    let lastError = null;
    for (const [api, version, data] of attempts) {
      let payload;
      try {
        payload = await this.client.request(api, version, data, { signal });
      } catch (error) {
        // 取消/登录态失效/风控拦截都不值得换接口再试：前两者与接口无关，
        // RGV587 风控按请求指纹拦，H5 与 PC 接口走同一个网关指纹。
        if (error.code === 'CANCELLED' || error.code === 'AUTH_REQUIRED' || error.code === 'RISK_CONTROL') throw error;
        lastError = error;
        continue;
      }
      const catalog = extractCatalog(payload);
      if (catalog.skuBase || catalog.skuCore) {
        // item 对象不一定带 itemId 字段；skuBase/props 值对象只有 name，不会误匹配。
        // 店铺字段在不同响应层级名称不一，一趟扫描按优先级取出。
        // sellerNode：B 店带 shopName；C 店（集市/个人转卖）只有 sellerNick+sellerType+evaluates。
        // storeNode：B 店 storeCardVO 带 labelList+evaluates；C 店只剩 sellerType+creditLevel（无 evaluates）。
        const nodes = expand(payload);
        let itemNode = null, sellerNode = null, storeNode = null;
        for (const node of nodes) {
          if (!itemNode && typeof node?.title === 'string' && stripTags(node.title).length > 1) itemNode = node;
          if (!sellerNode) {
            if (typeof node?.shopName === 'string' && node.shopName) sellerNode = node;
            else if (Array.isArray(node?.evaluates) && node.sellerType) sellerNode = node;
            else if (typeof node?.shopNameText === 'string' && node.shopNameText) sellerNode = node;
            else if (typeof node?.nick === 'string' && node.nick) sellerNode = node;
          }
          if (!storeNode) {
            if (Array.isArray(node?.labelList) && Array.isArray(node?.evaluates)) storeNode = node;
            else if (node?.sellerType && node?.creditLevel != null && !Array.isArray(node?.evaluates)) storeNode = node;
          }
          if (itemNode && sellerNode && storeNode) break;
        }
        return {
          ...catalog,
          item: {
            title: itemNode ? itemNode.title : null,
            images: Array.isArray(itemNode?.images) ? itemNode.images : null,
            shopName: sellerNode ? (sellerNode.shopName || sellerNode.shopNameText || sellerNode.nick || sellerNode.sellerNick || null) : null,
          },
          store: buildStoreRecord(sellerNode, storeNode),
        };
      }
    }
    // 两次尝试都没解析出规格数据：明确按失效商品报错，不返回空壳 catalog。
    throw new TaobaoError('ITEM_UNAVAILABLE', '商品已失效、下架或接口未返回数据。',
      lastError ? { lastFallbackError: lastError.message } : null);
  }

  async getSpecs(itemId, options = {}, signal) {
    requireId(itemId);
    const catalog = await this.fetchCatalog(itemId, signal);
    const specs = buildMtopSpecs(itemId, catalog);
    return { data: publicSpecs(specs), meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } };
  }

  // 从已拉取的 catalog 解析单规格详情；batch 用它复用同商品的 catalog，避免重复请求。
  detailFromCatalog(catalog, itemId, spec) {
    const specs = buildMtopSpecs(itemId, catalog);
    const selection = resolveSpec(specs, spec);
    // 指定了具体 SKU 时只认 sku2info 里该 SKU 的价，缺失就明确报错；
    // 仅 default 模式（无 skuId）才允许回退到商品默认价——杜绝把引流价冒充规格价。
    const price = selection.skuId ? skuPriceLoose(catalog, selection.skuId) : defaultPrice(catalog);
    if (!price) {
      const code = selection.skuId ? 'SKU_PRICE_UNCONFIRMED' : 'DEFAULT_PRICE_UNCONFIRMED';
      throw new TaobaoError(code, selection.skuId
        ? '接口未返回该规格的价格，无法核验；不返回猜测值。'
        : '接口未返回商品默认价格，无法核验。');
    }
    const imageUrls = Array.isArray(catalog.item?.images) ? catalog.item.images.map(String) : [];
    return {
      data: {
        itemId, specId: selection.specId, skuId: selection.skuId,
        specLabel: selection.label, selections: selection.selections,
        title: catalog.item?.title ? stripTags(catalog.item.title) : null,
        url: `https://item.taobao.com/item.htm?id=${itemId}`,
        shopName: catalog.item?.shopName || null,
        store: catalog.store ?? null,
        price: { amount: price.amount, currency: price.currency, basis: price.basis, display: price.display, scope: selection.skuId ? 'selected-spec' : 'item-default', observedAt: new Date().toISOString() },
        stock: price.stock ?? null, shipping: null,
        attributes: specs.groups.map(group => ({ name: group.name, values: group.values.map(value => value.label) })),
        description: null, imageUrls,
        selectedLabels: selection.expected.map(value => value.label),
      },
      meta: {
        provider: selection.skuId ? 'mtop-http-sku' : 'mtop-http-default',
        observedAt: new Date().toISOString(),
        priceEvidence: selection.skuId ? 'sku-id-map' : 'default-sku',
        coverage: { stock: price.stock != null, shipping: false, attributes: specs.groups.length > 0, description: false, store: Boolean(catalog.store) },
      },
    };
  }

  async getDetail(itemId, spec, options = {}, signal) {
    requireId(itemId);
    const catalog = await this.fetchCatalog(itemId, signal);
    return this.detailFromCatalog(catalog, itemId, spec);
  }

  // 购物记录（已买到的宝贝）。服务端固定每页 15 条；page 为正整数，
  // tab 为订单页签（all/...），缺省 all。
  async getOrders(options = {}, signal) {
    const params = { page: 1, tab: 'all', ...options };
    if (!Number.isInteger(params.page) || params.page < 1) {
      throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数。');
    }
    if (!ORDER_TAB_PATTERN.test(params.tab)) {
      throw new TaobaoError('INVALID_ARGUMENT', 'tab 须为 2–20 位小写字母/下划线（已验证的值：all；其他页签码未经实测）。');
    }
    const payload = await this.client.request(ORDER_API[0], ORDER_API[1], {
      spm: 'a2141.7756461.2.6', page: params.page, tabCode: params.tab, appVersion: '1.0', appName: 'tborder',
    }, { signal, ...ORDER_REQUEST });
    const { orders, pagination } = assertOrdersPayload(payload);
    return {
      data: {
        page: params.page, tab: params.tab, orders, pagination,
      },
      meta: { provider: 'mtop-http-orders', observedAt: new Date().toISOString() },
    };
  }

  // 评价计数（1 次请求，rateList 内容丢弃）。total 是平台封顶值（2000/1000 等），
  // 真实数量级以 totalFuzzy 模糊文本为准；foldedDefault 为折叠的默认好评数，
  // 占比高提示刷单嫌疑。平台已隐藏差评数（hideBadCount），无中差评分项可取。
  async getReviewSummary(itemId, signal) {
    requireId(itemId);
    const payload = await this.client.request(RATE_API[0], RATE_API[1], {
      auctionNumId: itemId, currentPage: '1', pageSize: '10', orderType: '',
    }, { signal, referer: `https://item.taobao.com/item.htm?id=${itemId}` });
    // 汇总字段实测为字符串（"2000"/"1629"），统一转数字；解析不了保持 null。
    const toCount = value => {
      const num = Number(value);
      return Number.isFinite(num) && String(value).trim() !== '' ? num : null;
    };
    const total = toCount(payload?.total);
    const folded = toCount(payload?.foldCount);
    const fuzzy = [payload?.totalFuzzy, payload?.fuzzyRateCount].find(value => typeof value === 'string' && value) || null;
    return {
      data: {
        itemId,
        total,
        totalFuzzy: fuzzy,
        foldedDefault: folded,
        foldedRatio: total && folded !== null ? `${Math.round((folded / total) * 100)}%` : null,
        note: 'total 为平台封顶值，真实数量级见 totalFuzzy；foldedDefault 为折叠的默认好评数，占比高提示刷单嫌疑。',
      },
      meta: { provider: 'mtop-http-rate', observedAt: new Date().toISOString() },
    };
  }

  // 批量执行：单项失败不影响其余项；但登录态失效（AUTH_REQUIRED）或风控拦截
  // （RISK_CONTROL）会立即终止整批——那两种状态下继续请求只会逐项重复失败
  // 并持续累积坏指纹（登录态体检：不带坏状态去撞接口）。
  async batch(input, signal) {
    const results = [];
    const isFatal = error => error.code === 'AUTH_REQUIRED' || error.code === 'RISK_CONTROL';
    let aborted = null;
    const noteFatal = error => {
      if (isFatal(error) && !aborted) aborted = { code: error.code, message: error.message };
    };
    for (const entry of input.searches || []) {
      if (aborted) break;
      const { keyword, options } = typeof entry === 'string' ? { keyword: entry, options: {} } : entry;
      try { results.push({ kind: 'search', keyword, result: await this.search(keyword, options, signal) }); }
      catch (error) { results.push({ kind: 'search', keyword, error: { code: error.code || 'MTOP_ERROR', message: error.message } }); noteFatal(error); }
    }
    for (const product of input.products || []) {
      if (aborted) break;
      const specs = Array.isArray(product.specs) && product.specs.length ? product.specs : [null];
      // 同商品只拉一次 catalog，多规格在内存里复用——否则 N 个规格 = N 次详情请求。
      let catalog = null;
      try {
        requireId(product.itemId);
        catalog = await this.fetchCatalog(product.itemId, signal);
      } catch (error) {
        for (const spec of specs) results.push({ kind: spec ? 'detail' : 'specs', itemId: product.itemId, error: { code: error.code || 'MTOP_ERROR', message: error.message } });
        noteFatal(error);
        continue;
      }
      for (const spec of specs) {
        try {
          const result = spec ? this.detailFromCatalog(catalog, product.itemId, spec) : { data: publicSpecs(buildMtopSpecs(product.itemId, catalog)), meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } };
          results.push({ kind: spec ? 'detail' : 'specs', itemId: product.itemId, result });
        } catch (error) {
          results.push({ kind: spec ? 'detail' : 'specs', itemId: product.itemId, error: { code: error.code || 'MTOP_ERROR', message: error.message } });
          if (isFatal(error)) { noteFatal(error); break; }
        }
      }
    }
    const failed = results.filter(item => item.error).length;
    return {
      data: {
        results, total: results.length, succeeded: results.length - failed, failed,
        ...(aborted ? {
          aborted,
          note: `批量在第 ${results.length} 项后提前终止（${aborted.code}）：登录态失效或风控拦截时继续执行只会逐项重复失败，剩余条目未执行。处理后重跑即可。`,
        } : {}),
      },
      meta: { provider: 'mtop-http', observedAt: new Date().toISOString() },
    };
  }
}
