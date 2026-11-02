import { TaobaoError, requireId } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { MtopClient, parseBody } from '../../core/mtop-client.js';
import { extractCatalog, resolveSpec, publicSpecs, skuPrice } from './specs.js';

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

function deepFind(nodes, test) {
  return nodes.find(test) || null;
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
    imageUrl: row.picUrl ?? row.pic_path ?? row.imageUrl ?? row.pic ?? null,
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
    if (label.includes('undefined') || selections.some(selection => !groups.find(group => group.groupId === selection.groupId)?.values.some(value => value.valueId === selection.valueId))) return [];
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
    });
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
  // 商品标题/店铺名与规格数据可能分布在不同层级，同一次响应里一并深搜提取。
  async fetchCatalog(itemId) {
    const attempts = [
      ['mtop.taobao.detail.getdetail', '6.0', { id: itemId, exParams: JSON.stringify({ id: itemId }) }],
      ['mtop.taobao.pcdetail.data.get', '1.0', {
        id: itemId, detail_v: '3.3.2',
        exParams: JSON.stringify({ id: itemId, domain: 'https://item.taobao.com', path_name: '/item.htm' }),
      }],
    ];
    let empty = false;
    for (const [api, version, data] of attempts) {
      const payload = await this.client.request(api, version, data);
      const catalog = extractCatalog(payload);
      if (catalog.skuBase || catalog.skuCore) {
        // item 对象不一定带 itemId 字段；skuBase/props 值对象只有 name，不会误匹配。
        const nodes = expand(payload);
        const itemNode = deepFind(nodes, node => typeof node?.title === 'string' && stripTags(node.title).length > 1);
        const sellerNode = deepFind(nodes, node => typeof node?.shopName === 'string' && node.shopName)
          || deepFind(nodes, node => typeof node?.shopNameText === 'string' && node.shopNameText)
          || deepFind(nodes, node => typeof node?.nick === 'string' && node.nick);
        return {
          ...catalog,
          item: {
            title: itemNode ? itemNode.title : null,
            images: Array.isArray(itemNode?.images) ? itemNode.images : null,
            shopName: sellerNode ? (sellerNode.shopName || sellerNode.shopNameText || sellerNode.nick) : null,
          },
        };
      }
      empty = true;
    }
    if (empty) return { skuBase: null, skuCore: null, itemId, item: null };
    throw new TaobaoError('ITEM_UNAVAILABLE', '商品已失效、下架或接口未返回数据。');
  }

  async getSpecs(itemId, options = {}, signal) {
    requireId(itemId);
    const catalog = await this.fetchCatalog(itemId);
    const specs = buildMtopSpecs(itemId, catalog);
    return { data: publicSpecs(specs), meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } };
  }

  async getDetail(itemId, spec, options = {}, signal) {
    requireId(itemId);
    const catalog = await this.fetchCatalog(itemId);
    const specs = buildMtopSpecs(itemId, catalog);
    const selection = resolveSpec(specs, spec);
    const price = skuPriceLoose(catalog, selection.skuId) || defaultPrice(catalog);
    if (!price) throw new TaobaoError('SKU_PRICE_UNCONFIRMED', '接口未返回该规格的价格，无法核验；不返回猜测值。');
    const imageUrls = Array.isArray(catalog.item?.images) ? catalog.item.images.map(String) : [];
    return {
      data: {
        itemId, specId: selection.specId, skuId: selection.skuId,
        specLabel: selection.label, selections: selection.selections,
        title: catalog.item?.title ? stripTags(catalog.item.title) : null,
        url: `https://item.taobao.com/item.htm?id=${itemId}`,
        shopName: catalog.item?.shopName || null,
        price: { amount: price.amount, currency: price.currency, basis: price.basis, display: price.display, scope: 'selected-spec', observedAt: new Date().toISOString() },
        stock: price.stock ?? null, shipping: null,
        attributes: specs.groups.map(group => ({ name: group.name, values: group.values.map(value => value.label) })),
        description: null, imageUrls,
        selectedLabels: selection.expected.map(value => value.label),
      },
      meta: {
        provider: selection.skuId ? 'mtop-http-sku' : 'mtop-http-default',
        observedAt: new Date().toISOString(),
        priceEvidence: selection.skuId ? 'sku-id-map' : 'default-sku',
        coverage: { stock: price.stock != null, shipping: false, attributes: specs.groups.length > 0, description: false },
      },
    };
  }

  async batch(input, signal) {
    const results = [];
    for (const entry of input.searches || []) {
      const { keyword, options } = typeof entry === 'string' ? { keyword: entry, options: {} } : entry;
      try { results.push({ kind: 'search', keyword, result: await this.search(keyword, options, signal) }); }
      catch (error) { results.push({ kind: 'search', keyword, error: { code: error.code || 'MTOP_ERROR', message: error.message } }); }
    }
    for (const product of input.products || []) {
      const specs = Array.isArray(product.specs) && product.specs.length ? product.specs : [null];
      for (const spec of specs) {
        try {
          const result = spec ? await this.getDetail(product.itemId, spec, {}, signal) : await this.getSpecs(product.itemId, {}, signal);
          results.push({ kind: spec ? 'detail' : 'specs', itemId: product.itemId, result });
        } catch (error) {
          results.push({ kind: spec ? 'detail' : 'specs', itemId: product.itemId, error: { code: error.code || 'MTOP_ERROR', message: error.message } });
        }
      }
    }
    return { data: { results }, meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } };
  }
}
