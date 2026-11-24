import { TaobaoError, requireId, checkAbort, getErrorCode, getErrorMessage } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { MtopClient, withOperationLog, reserveSlot, appendRequestLog } from '../../core/mtop-client.js';
import { loadCookies, saveCookies, mergeSetCookies, cookieHeader } from '../../core/cookie-store.js';
import { normalizeUrl } from '../../core/url.js';
import { expandNodes, extractCatalogFromNodes, resolveSpec, publicSpecs, skuPrice } from './specs.js';
import { assertOrdersPayload } from './orders.js';
import { assertCartPayload, parseAddCartResult, buildRemoveUpdateData } from './cart.js';
import type {
  BatchCallbacks,
  BatchData,
  BatchErrorSummary,
  BatchInput,
  BatchResultItem,
  CartAddData,
  CartAddOptions,
  CartListData,
  CartRemoveData,
  CatalogShopInfo,
  DetailData,
  ExtractedCatalog,
  FetchLike,
  FetchedCatalog,
  InternalSpecs,
  MtopClientLike,
  MtopClientOptions,
  MtopRequestOptions,
  OrdersData,
  OrdersOptions,
  PublicSpecs,
  RawSkuInfoEntry,
  ResponseLike,
  ReviewSummaryData,
  SdkResult,
  SearchData,
  SearchItem,
  SearchOptions,
  SearchSort,
  SkuPriceResult,
  SpecInput,
  SpecSelection,
  SpecVariant,
  StoreRecord,
} from '../../types.js';

const ORDER_TAB_PATTERN = /^[a-z_]{2,20}$/;
// 订单接口挂在「已买到的宝贝」页面上下文；网关要求登录请求标记（ecode=1）。
const ORDER_REQUEST: Pick<MtopRequestOptions, 'extraParams' | 'referer'> = {
  extraParams: { ecode: '1', AntiCreep: 'true', AntiFlood: 'true', LoginRequest: 'true', ttid: '##h5' },
  referer: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
};
const ORDER_API = ['mtop.taobao.order.queryboughtlistV2', '1.0'] as const;
// 评价计数接口：只要汇总字段，rateList 内容丢弃。
const RATE_API = ['mtop.taobao.rate.detaillist.get', '4.0'] as const;
// 购物车内容接口：挂在 H5 购物车页面上下文，同样要求登录请求标记（ecode=1）。
const CART_API = ['mtop.trade.query.bag', '5.0'] as const;
// update.bag 4.0：购物车统一写接口（删除/改数量/勾选等），dinamicx 链接协议，POST。
const UPDATE_BAG_API = ['mtop.trade.update.bag', '4.0'] as const;
const CART_REQUEST: Pick<MtopRequestOptions, 'extraParams' | 'referer'> = {
  extraParams: { ecode: '1', AntiCreep: 'true', AntiFlood: 'true', LoginRequest: 'true', ttid: '##h5' },
  referer: 'https://main.m.taobao.com/cart/index.html',
};
// 加购走 PC 网页端点（非 MTOP）：cart.taobao.com/add_cart_item.htm，GBK 响应。
// 2026-11-14 实测：最小参数 item_id + quantity + _tb_token_ 即成功（无需 2016 年
// 资料里的 opp/ct/nekot），响应为 GBK HTML 内嵌 TB.Detail.CartResult JSON。
const CART_ADD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CART_ADD_GBK = new TextDecoder('gbk');

const SORTS: Readonly<Record<SearchSort, string>> = {
  default: '',
  'price-asc': 'price-asc',
  'price-desc': 'price-desc',
  sales: 'sale-desc',
};

const clean = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();
const stripTags = (value: unknown): string => clean(String(value || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '));

const ITEM_KEYS = ['itemId', 'item_id', 'id'] as const;
const looksLikeItem = (row: unknown): row is Record<string, unknown> =>
  Boolean(row && typeof row === 'object'
    && ITEM_KEYS.some(key => /^\d{6,}$/.test(String((row as Record<string, unknown>)[key] ?? ''))));

function collectRows(data: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(data?.itemsArray)) return data.itemsArray as Record<string, unknown>[];
  const nested = data?.data as Record<string, unknown> | undefined;
  if (Array.isArray(nested?.itemsArray)) return nested.itemsArray as Record<string, unknown>[];
  for (const node of expandNodes(data, { maxNodes: 2000, maxChildren: 200 })) {
    for (const value of Object.values(node)) {
      if (Array.isArray(value) && value.length && value.some(looksLikeItem)) {
        return value as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function mapItem(row: Record<string, unknown>): Omit<SearchItem, 'priceSummary'> | null {
  const itemId = String(row.itemId ?? row.item_id ?? row.id ?? '');
  if (!/^\d+$/.test(itemId)) return null;
  const priceObj = row.price && typeof row.price === 'object' ? (row.price as Record<string, unknown>) : null;
  const priceText = priceObj
    ? (priceObj.priceText ?? null)
    : (row.showPrice ?? row.view_price ?? row.priceText ?? (typeof row.price === 'string' ? row.price : null)) ?? null;
  const seller = row.seller && typeof row.seller === 'object' ? (row.seller as Record<string, unknown>) : null;
  const shopName = row.shopName ?? row.nick ?? row.shop_nick ?? seller?.shopName ?? null;
  const salesText = row.view_sales ?? row.salesText ?? row.sales ?? null;
  return {
    itemId,
    title: stripTags(row.title),
    priceText: priceText === null || priceText === undefined ? null : String(priceText),
    shopName: shopName === null || shopName === undefined ? null : String(shopName),
    salesText: salesText === null || salesText === undefined ? null : String(salesText),
    url: `https://item.taobao.com/item.htm?id=${itemId}`,
    imageUrl: normalizeUrl(row.picUrl ?? row.pic_path ?? row.imageUrl ?? row.pic),
  };
}

// 店铺信誉块：sellerNode = pcdetail 顶层 seller（DSR 三项），
// storeNode = componentsVO.storeCardVO（质量三评分/综合分/信用等级/标签）。
// h5 getdetail 路径两者皆无 → 返回 null，detail 输出如实标 store:null。
export function buildStoreRecord(
  sellerNode: Record<string, unknown> | null | undefined,
  storeNode: Record<string, unknown> | null | undefined,
): StoreRecord | null {
  const sellerTypeRaw = sellerNode?.sellerType ?? storeNode?.sellerType ?? null;
  const sellerType = typeof sellerTypeRaw === 'string' ? sellerTypeRaw : null;
  const dsr = Array.isArray(sellerNode?.evaluates)
    ? (sellerNode.evaluates as Record<string, unknown>[]).map(entry => ({
      type: typeof entry.type === 'string' ? entry.type : null,
      title: clean(entry.title),
      score: clean(entry.score),
      levelText: typeof entry.levelText === 'string' ? clean(entry.levelText) : null,
    }))
    : null;
  const scores = Array.isArray(storeNode?.evaluates)
    ? (storeNode.evaluates as Record<string, unknown>[]).map(entry => ({
      title: clean(entry.title),
      score: clean(entry.score),
    }))
    : null;
  const labels = Array.isArray(storeNode?.labelList)
    ? (storeNode.labelList as Array<Record<string, unknown> | null>)
      .map(entry => clean(entry?.contentDesc))
      .filter(Boolean)
    : null;
  if (!sellerType && !dsr && !scores && !labels) return null;
  const creditLevel = storeNode?.creditLevel;
  return {
    sellerType,
    isTmall: sellerType === 'B',
    dsr,
    scores,
    overallScore: typeof storeNode?.overallScore === 'string' ? clean(storeNode.overallScore) : null,
    creditLevel: typeof creditLevel === 'string' || typeof creditLevel === 'number' ? creditLevel : null,
    labels,
  };
}

// 与 DOM 版 buildSpecs 输出同构，但组/值全部来自 skuBase，无 DOM 参与。
export function buildMtopSpecs(itemId: string, catalog: Pick<ExtractedCatalog, 'skuBase'>): InternalSpecs {
  const props = Array.isArray(catalog.skuBase?.props) ? catalog.skuBase.props : [];
  const groups = props.map((prop, index) => ({
    groupId: String(prop.pid),
    name: clean(prop.name),
    index,
    values: (prop.values || []).map((value, valueIndex) => ({
      valueId: String(value.vid),
      label: clean(value.name),
      available: true,
      index: valueIndex,
    })),
  }));
  const nativeSkus = Array.isArray(catalog.skuBase?.skus) ? catalog.skuBase.skus : [];
  const variants: SpecVariant[] = nativeSkus.flatMap(sku => {
    if (!sku.skuId || String(sku.skuId) === '0') return [];
    const selections: SpecSelection[] = (sku.propPath || '').split(';').filter(Boolean).map(pair => {
      const [groupId = '', valueId = ''] = pair.split(':');
      return { groupId, valueId };
    });
    if (selections.length !== groups.length) return [];
    const label = selections.map(selection => {
      const group = groups.find(g => g.groupId === selection.groupId);
      return group?.values.find(v => v.valueId === selection.valueId)?.label;
    }).join(' / ');
    // 只用存在性校验判定 label 有效性；不做 'undefined' 字符串判断，
    // 否则真实规格名恰好含该词时会被误杀。
    if (selections.some(selection => !groups.find(g => g.groupId === selection.groupId)?.values.some(v => v.valueId === selection.valueId))) return [];
    return [{ specId: `sku:${sku.skuId}`, skuId: String(sku.skuId), selections, label }];
  });
  const firstSku = nativeSkus[0];
  if (!variants.length && !groups.length && nativeSkus.length === 1 && firstSku?.skuId && String(firstSku.skuId) !== '0') {
    variants.push({ specId: `sku:${firstSku.skuId}`, skuId: String(firstSku.skuId), selections: [], label: '默认规格' });
  }
  // 无规格组的单 SKU 商品沿用 DOM 版的 mode，保证 kind=default 可解析。
  const mode = groups.length ? (variants.length ? 'variants' : 'select-by-groups') : 'single-variant';
  return { itemId, groups, variants, mode };
}

function defaultPrice(catalog: Pick<ExtractedCatalog, 'skuCore'>): SkuPriceResult | null {
  const record = catalog.skuCore?.sku2info?.['0'];
  return recordPrice(record);
}

// skuPrice 依赖 parsePrice 对「title + 价格」整串的解析；MTOP 返回里
// priceTitle 有时是「淘金币可抵」之类的文案，直接单解析 priceText 兜底。
export function recordPrice(record: RawSkuInfoEntry | null | undefined): SkuPriceResult | null {
  const text = record?.price?.priceText;
  if (typeof text !== 'string') return null;
  const price = parsePrice([text]);
  return price ? { ...price, basis: 'api-displayed', stock: record?.quantity ?? null } : null;
}

function skuPriceLoose(catalog: Pick<ExtractedCatalog, 'skuCore'>, skuId: string | null | undefined): SkuPriceResult | null {
  if (!skuId || skuId === '0') return null;
  return skuPrice(catalog, skuId) || recordPrice(catalog.skuCore?.sku2info?.[skuId]);
}

export interface MtopAdapterOptions extends MtopClientOptions {
  client?: MtopClientLike;
}

export class MtopAdapter {
  readonly options: MtopAdapterOptions & { runtimeDir: string | null };
  readonly client: MtopClientLike;

  constructor(options: MtopAdapterOptions = {}) {
    this.options = { runtimeDir: null, ...options };
    this.client = options.client || new MtopClient(options);
  }

  // 操作日志包装器：每次业务查询落一行（查询类型/入参/完整业务结果或错误），
  // 与 mtop-client 的 HTTP 请求日志互补。日志是旁路，写失败不影响查询本身。
  async withLog<T extends { data?: unknown }>(operation: string, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return withOperationLog(this.options.runtimeDir, operation, params, 'MTOP_ERROR', fn);
  }

  async search(keyword: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SdkResult<SearchData>> {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new TaobaoError('INVALID_ARGUMENT', '关键词不能为空。');
    keyword = keyword.trim();
    const params = { page: 1, limit: 20, sort: 'default' as SearchSort, ...options };
    if (!Number.isInteger(params.page) || params.page < 1 || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 48 || !(params.sort in SORTS)) {
      throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数，limit 为 1–48，sort 为 default/price-asc/price-desc/sales。');
    }
    return this.withLog('search', { keyword, ...params }, async () => {
      const data = await this.client.request('mtop.taobao.wsearch.appsearch', '1.0', {
        q: keyword, search_action: 'initiative', page: String(params.page),
        n: String(params.limit), sversion: '9.9.9', ...(SORTS[params.sort] ? { sort: SORTS[params.sort] } : {}),
      }, { signal });
      const items = collectRows(data).map(mapItem).filter((item): item is Omit<SearchItem, 'priceSummary'> => item !== null).slice(0, params.limit);
      if (!items.length) throw new TaobaoError('NO_RESULTS', '搜索接口未返回商品数据；可能是关键词无结果或返回结构变化。');
      return {
        data: {
          keyword, page: params.page, sort: params.sort,
          items: items.map(item => ({
            ...item,
            priceSummary: { ...(parsePrice([item.priceText]) || { amount: null, display: item.priceText }), scope: 'item-summary' as const },
          })),
          total: null,
        },
        meta: { provider: 'mtop-http', observedAt: new Date().toISOString() },
      };
    });
  }

  // 详情接口双保险：PC pcdetail 优先（实测含完整 skuBase/skuCore/店铺信誉/shopUrl，
  // H5 getdetail 6.0 实测 360/360 缺 skuBase 均回退到 pcdetail，反转顺序可少打一半请求并降低风控暴露），
  // 拿不到 skuBase/skuCore 时再降级 H5 接口。
  // 接口级失败（MTOP_ERROR/NETWORK_ERROR）同样降级到备用接口；取消、鉴权与风控错误直接上抛。
  // 商品标题/店铺名与规格数据可能分布在不同层级，同一次响应里一并深搜提取。
  // 注意：若降级到 H5 路径，响应里没有店铺信誉节点，store 为 null。
  async fetchCatalog(itemId: string, signal?: AbortSignal): Promise<FetchedCatalog> {
    const attempts: readonly [string, string, Record<string, unknown>][] = [
      ['mtop.taobao.pcdetail.data.get', '1.0', {
        id: itemId, detail_v: '3.3.2',
        exParams: JSON.stringify({ id: itemId, domain: 'https://item.taobao.com', path_name: '/item.htm' }),
      }],
      ['mtop.taobao.detail.getdetail', '6.0', { id: itemId, exParams: JSON.stringify({ id: itemId }) }],
    ];
    let lastError: unknown = null;
    for (let idx = 0; idx < attempts.length; idx++) {
      const attempt = attempts[idx];
      if (!attempt) continue;
      const [api, version, data] = attempt;
      const nextApi = attempts[idx + 1]?.[0] ?? null;
      let payload: Record<string, unknown>;
      try {
        payload = await this.client.request(api, version, data, { signal });
      } catch (error: unknown) {
        // 取消/登录态失效/风控拦截都不值得换接口再试：前两者与接口无关，
        // RGV587 风控按请求指纹拦，PC 与 H5 接口走同一个网关指纹。
        const code = getErrorCode(error);
        if (code === 'CANCELLED' || code === 'AUTH_REQUIRED' || code === 'RISK_CONTROL') throw error;
        lastError = error;
        if (nextApi) {
          const now = Date.now();
          await appendRequestLog(this.options.runtimeDir, {
            t: now, ts: new Date(now).toISOString(), api: 'catalog-fallback',
            itemId, fromApi: api, toApi: nextApi, ok: false, reason: getErrorCode(error, 'MTOP_ERROR'),
          });
        }
        continue;
      }
      const nodes = expandNodes(payload, { maxNodes: 2000, maxChildren: 200 });
      const catalog = extractCatalogFromNodes(nodes);
      if (catalog.skuBase || catalog.skuCore) {
        // item 对象不一定带 itemId 字段；skuBase/props 值对象只有 name，不会误匹配。
        // 店铺字段在不同响应层级名称不一，复用同一趟展开的 nodes 按优先级取出。
        // sellerNode：B 店带 shopName；C 店（集市/个人转卖）只有 sellerNick+sellerType+evaluates。
        // storeNode：B 店 storeCardVO 带 labelList+evaluates；C 店只剩 sellerType+creditLevel（无 evaluates）。
        let itemNode: Record<string, unknown> | null = null;
        let sellerNode: Record<string, unknown> | null = null;
        let storeNode: Record<string, unknown> | null = null;
        let shopIds: { sellerId: string; shopId: string } | null = null;
        let shopUrl: string | null = null;
        for (const node of nodes) {
          if (!itemNode && typeof node.title === 'string' && stripTags(node.title).length > 1) itemNode = node;
          if (!sellerNode) {
            if (typeof node.shopName === 'string' && node.shopName) sellerNode = node;
            else if (Array.isArray(node.evaluates) && node.sellerType) sellerNode = node;
            else if (typeof node.shopNameText === 'string' && node.shopNameText) sellerNode = node;
            else if (typeof node.nick === 'string' && node.nick) sellerNode = node;
          }
          if (!storeNode) {
            if (Array.isArray(node.labelList) && Array.isArray(node.evaluates)) storeNode = node;
            else if (node.sellerType && node.creditLevel != null && !Array.isArray(node.evaluates)) storeNode = node;
          }
          // seller 节点带数字型 sellerId+shopId（仅 pcdetail 路径），供粉丝数串联查询用。
          if (!shopIds && node.sellerId != null && node.shopId != null) {
            shopIds = { sellerId: String(node.sellerId), shopId: String(node.shopId) };
          }
          // 店铺 URL（pcdetail 路径，如 https://shop131282813.taobao.com/category.htm）：
          // 店铺内搜索（shop-search）凭它定位子域名；C 店可能只有 pcShopUrl。
          if (!shopUrl) {
            if (typeof node.shopUrl === 'string' && node.shopUrl) shopUrl = node.shopUrl;
            else if (typeof node.pcShopUrl === 'string' && node.pcShopUrl) {
              shopUrl = node.pcShopUrl.startsWith('//') ? `https:${node.pcShopUrl}` : node.pcShopUrl;
            }
          }
          if (itemNode && sellerNode && storeNode && shopIds && shopUrl) break;
        }
        const shop: CatalogShopInfo | null = (shopIds || shopUrl)
          ? { ...(shopIds ?? {}), ...(shopUrl ? { shopUrl } : {}) }
          : null;
        const resolvedShopName = sellerNode
          ? (sellerNode.shopName || sellerNode.shopNameText || sellerNode.nick || sellerNode.sellerNick || null)
          : null;
        return {
          ...catalog,
          sourceApi: api,
          shop,
          item: {
            title: typeof itemNode?.title === 'string' ? itemNode.title : null,
            images: Array.isArray(itemNode?.images) ? itemNode.images : null,
            shopName: resolvedShopName != null ? String(resolvedShopName) : null,
          },
          store: buildStoreRecord(sellerNode, storeNode),
        };
      }
      if (nextApi) {
        const now = Date.now();
        await appendRequestLog(this.options.runtimeDir, {
          t: now, ts: new Date(now).toISOString(), api: 'catalog-fallback',
          itemId, fromApi: api, toApi: nextApi, ok: false, reason: 'missing-sku',
        });
      }
    }
    // 两次尝试都没解析出规格数据：明确按失效商品报错，不返回空壳 catalog。
    throw new TaobaoError('ITEM_UNAVAILABLE', '商品已失效、下架或接口未返回数据。',
      lastError ? { lastFallbackError: getErrorMessage(lastError) } : null);
  }

  async getSpecs(itemId: string, _options: Record<string, unknown> = {}, signal?: AbortSignal): Promise<SdkResult<PublicSpecs>> {
    requireId(itemId);
    return this.withLog('specs', { itemId }, async () => {
      const catalog = await this.fetchCatalog(itemId, signal);
      const specs = buildMtopSpecs(itemId, catalog);
      return { data: publicSpecs(specs), meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } };
    });
  }

  // 从已拉取的 catalog 解析单规格详情；batch 用它复用同商品的 catalog，避免重复请求。
  detailFromCatalog(catalog: FetchedCatalog, itemId: string, spec: SpecInput): SdkResult<DetailData> {
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
        shop: catalog.shop ?? null,
        store: catalog.store ?? null,
        price: {
          amount: price.amount, currency: price.currency, basis: price.basis, display: price.display,
          scope: selection.skuId ? 'selected-spec' : 'item-default', observedAt: new Date().toISOString(),
        },
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

  // 店铺级增强信息（粉丝数/金牌卖家）：pcdetail 响应本身不含这些字段，
  // 需凭 seller 节点的 sellerId+shopId 额外调一次 impression.logo.get（走全局限速）。
  // 粉丝数是店铺选择的关键依据，因此 detail 串联查询；失败不打断 detail——
  // 它是增强字段，拿不到就保持原 store 不变。取消/鉴权/风控错误照常上抛。
  async enrichStoreFans(catalog: FetchedCatalog, signal?: AbortSignal): Promise<FetchedCatalog> {
    const { sellerId, shopId } = catalog.shop ?? {};
    if (!sellerId || !shopId) return catalog;
    let payload: Record<string, unknown>;
    try {
      payload = await this.client.request('mtop.taobao.shop.impression.logo.get', '1.0',
        { sellerId, shopId }, { signal });
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'CANCELLED' || code === 'AUTH_REQUIRED' || code === 'RISK_CONTROL') throw error;
      return catalog;
    }
    const result = payload?.result as Record<string, unknown> | undefined;
    if (!result || result.fansNum == null) return catalog;
    const fans = {
      fansNum: typeof result.fansNum === 'number' ? result.fansNum : String(result.fansNum),
      ifHideFansNum: Boolean(result.ifHideFansNum),
      goldenSeller: Boolean(result.goldenSeller),
    };
    const baseStore: StoreRecord = catalog.store ?? {
      sellerType: null, isTmall: false, dsr: null, scores: null, overallScore: null, creditLevel: null, labels: null,
    };
    catalog.store = { ...baseStore, ...fans };
    return catalog;
  }

  async getDetail(itemId: string, spec: SpecInput, _options: Record<string, unknown> = {}, signal?: AbortSignal): Promise<SdkResult<DetailData>> {
    requireId(itemId);
    return this.withLog('detail', { itemId, spec: spec ?? null }, async () => {
      const catalog = await this.fetchCatalog(itemId, signal);
      await this.enrichStoreFans(catalog, signal);
      return this.detailFromCatalog(catalog, itemId, spec);
    });
  }

  // 购物记录（已买到的宝贝）。服务端固定每页 15 条；page 为正整数，
  // pages（1–50，默认 1）支持从 page 起连续翻页合并（页间隔走全局限速），
  // tab 为订单页签（all/...），缺省 all。
  async getOrders(options: OrdersOptions = {}, signal?: AbortSignal): Promise<SdkResult<OrdersData>> {
    const params = { page: 1, pages: 1, tab: 'all', ...options };
    if (!Number.isInteger(params.page) || params.page < 1) {
      throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数。');
    }
    if (!Number.isInteger(params.pages) || params.pages < 1 || params.pages > 50) {
      throw new TaobaoError('INVALID_ARGUMENT', 'pages 须为 1–50 的整数。');
    }
    if (!ORDER_TAB_PATTERN.test(params.tab)) {
      throw new TaobaoError('INVALID_ARGUMENT', 'tab 须为 2–20 位小写字母/下划线（已验证的值：all；其他页签码未经实测）。');
    }
    return this.withLog('orders', { page: params.page, pages: params.pages, tab: params.tab }, async () => {
      const fetchOne = async (pageNo: number) => {
        const payload = await this.client.request(ORDER_API[0], ORDER_API[1], {
          spm: 'a2141.7756461.2.6', page: pageNo, tabCode: params.tab, appVersion: '1.0', appName: 'tborder',
        }, { signal, ...ORDER_REQUEST });
        return assertOrdersPayload(payload);
      };
      if (params.pages === 1) {
        const { orders, pagination } = await fetchOne(params.page);
        return {
          data: { page: params.page, tab: params.tab, orders, pagination },
          meta: { provider: 'mtop-http-orders', observedAt: new Date().toISOString() },
        };
      }
      // 连续翻页：逐页请求合并。空页即止；有分页元数据时到 totalPage 提前收尾；
      // 翻过最后一页时接口会抛 NO_RESULTS——非首轮捕获后视为正常到末页，保留已拉取数据。
      const merged = [];
      let lastPagination = null;
      for (let offset = 0; offset < params.pages; offset++) {
        let pageResult;
        try {
          pageResult = await fetchOne(params.page + offset);
        } catch (error: unknown) {
          if (getErrorCode(error) === 'NO_RESULTS' && offset > 0 && lastPagination) break;
          throw error;
        }
        lastPagination = pageResult.pagination;
        merged.push(...pageResult.orders);
        const totalPage = pageResult.pagination.totalPage;
        if (!pageResult.orders.length || (typeof totalPage === 'number' && Number.isInteger(totalPage) && params.page + offset >= totalPage)) break;
      }
      if (!lastPagination) throw new TaobaoError('NO_RESULTS', '订单接口未返回订单数据。');
      return {
        data: { page: params.page, tab: params.tab, orders: merged, pagination: lastPagination },
        meta: { provider: 'mtop-http-orders', observedAt: new Date().toISOString() },
      };
    });
  }

  // 购物车原始组件树（内部公共请求）：getCartList / addToCart 回读 / removeFromCart 共用，
  // 避免写操作内部回读时在操作日志里多写一条嵌套的 cart-list 记录。
  private async fetchCartPayload(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.request(CART_API[0], CART_API[1], {
      isPage: true, extStatus: 0, netType: 0,
      exParams: JSON.stringify({ mergeCombo: true, version: '1.1.1', globalSell: 1 }),
    }, { signal, ...CART_REQUEST });
  }

  // 购物车内容（只读）。返回条目列表 + 店铺列表 + 结算汇总；
  // 与 orders 同为登录态接口，走 ecode=1 请求标记。
  async getCartList(signal?: AbortSignal): Promise<SdkResult<CartListData>> {
    return this.withLog('cart-list', {}, async () => {
      const payload = await this.fetchCartPayload(signal);
      const cart = assertCartPayload(payload);
      return {
        data: cart,
        meta: { provider: 'mtop-http-cart', observedAt: new Date().toISOString() },
      };
    });
  }

  // 加入购物车（写操作）：PC 网页端点一次请求 + 回读 query.bag 一次核对。
  // 前提：Cookie 须含 _tb_token_（PC 登录 CSRF 令牌，浏览器登录态自带）。
  // 带规格商品须传 skuId；skuId 路径有开源参照（clawhub/QGB）但未实测，
  // 失败时会如实报错并保留服务端响应原文供排查。
  async addToCart(itemId: string, { skuId = null, quantity = 1 }: CartAddOptions = {}, signal?: AbortSignal): Promise<SdkResult<CartAddData>> {
    requireId(itemId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new TaobaoError('INVALID_ARGUMENT', 'quantity 须为 1–999 的整数。');
    }
    if (skuId != null && !/^\d+$/.test(String(skuId))) {
      throw new TaobaoError('INVALID_ARGUMENT', 'skuId 须为纯数字（specs 命令输出的 skuId）。');
    }
    return this.withLog('cart-add', { itemId, skuId: skuId ?? null, quantity }, async () => {
      const store = await loadCookies(this.options.runtimeDir);
      const token = store.cookies._tb_token_?.value;
      if (!token) {
        throw new TaobaoError('AUTH_REQUIRED',
          'Cookie 缺少 _tb_token_（PC 登录 CSRF 令牌），无法加购。请从浏览器重新复制完整 Cookie 并更新 cookie.json。');
      }
      checkAbort(signal);
      // 限速与超时配置均以 MtopClient.options 为准（默认 10000+5000ms / 15000ms），
      // 缺省再回退 adapter.options，避免默认调用时 minIntervalMs 为 undefined 击穿全局限速。
      const minIntervalMs = this.client.options?.minIntervalMs ?? this.options.minIntervalMs ?? 10000;
      const jitterMs = this.client.options?.jitterMs ?? this.options.jitterMs ?? 5000;
      const waitStart = Date.now();
      await reserveSlot(this.options.runtimeDir, minIntervalMs, jitterMs, signal);
      const waitMs = Date.now() - waitStart;
      checkAbort(signal);
      const params = new URLSearchParams({
        item_id: String(itemId),
        quantity: String(quantity),
        _tb_token_: token,
        ...(skuId ? { sku_id: String(skuId) } : {}),
      });
      const url = `https://cart.taobao.com/add_cart_item.htm?${params}`;
      // 日志脱敏：绝不把 _tb_token_ 写入请求日志。
      const logParams = new URLSearchParams(params);
      logParams.set('_tb_token_', 'REDACTED');
      const logUrl = `https://cart.taobao.com/add_cart_item.htm?${logParams}`;
      const timeoutMs = this.client.options?.timeoutMs ?? this.options.timeoutMs ?? 15000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const fetchSignal = signal
        ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, signal]) : signal)
        : timeoutSignal;
      const fetchFn: FetchLike = this.client.fetch || (globalThis.fetch as unknown as FetchLike);
      const started = Date.now();
      const logAttempt = async (outcome: Record<string, unknown>): Promise<void> => {
        await appendRequestLog(this.options.runtimeDir, {
          t: started, ts: new Date(started).toISOString(), api: 'cart-add',
          itemId: String(itemId), skuId: skuId ? String(skuId) : null, quantity,
          waitMs, ms: Date.now() - started, url: logUrl, ...outcome,
        });
      };
      let response: ResponseLike;
      try {
        response = await fetchFn(url, {
          headers: {
            'User-Agent': CART_ADD_UA,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            Referer: `https://item.taobao.com/item.htm?id=${itemId}`,
            Cookie: cookieHeader(store),
          },
          redirect: 'manual',
          signal: fetchSignal,
        });
      } catch (error: unknown) {
        if (signal?.aborted) {
          await logAttempt({ ok: false, code: 'CANCELLED' });
          throw new TaobaoError('CANCELLED', '任务已取消。');
        }
        await logAttempt({ ok: false, code: 'NETWORK_ERROR' });
        throw new TaobaoError('NETWORK_ERROR', `加购请求失败：${getErrorMessage(error)}`);
      }
      mergeSetCookies(store, response.headers.getSetCookie());
      await saveCookies(store, this.options.runtimeDir);
      const ab = response.arrayBuffer ? await response.arrayBuffer() : new ArrayBuffer(0);
      const body = CART_ADD_GBK.decode(Buffer.from(ab));
      if (/_____tmd_____/.test(body)) {
        await logAttempt({ ok: false, code: 'RISK_CONTROL', http: response.status });
        throw new TaobaoError('RISK_CONTROL', '加购被淘宝风控拦截（TMD 滑块）。等待几分钟并在浏览器正常访问一次 taobao.com 后重试。');
      }
      const result = parseAddCartResult(body);
      if (/login/i.test(body) && !result) {
        await logAttempt({ ok: false, code: 'AUTH_REQUIRED', http: response.status });
        throw new TaobaoError('AUTH_REQUIRED', '加购返回登录页：登录 Cookie 失效。请在浏览器登录后重新 sync-cookie。');
      }
      if (!result) {
        await logAttempt({ ok: false, code: 'CART_ADD_ERROR', http: response.status });
        throw new TaobaoError('CART_ADD_ERROR',
          `加购响应无法解析（HTTP ${response.status}）。商品可能已下架、限购或端点结构变化。`,
          { bodyHead: body.slice(0, 400) });
      }
      await logAttempt({ ok: true, http: response.status });
      // 回读核对：加购响应的 cartQuantity 是网关全量计数（含失效条目），不可比数量；
      // 以 query.bag 里出现 itemId+skuId 条目为准。
      const cart = assertCartPayload(await this.fetchCartPayload(signal));
      const entry = (cart.items || []).find(item => item.itemId === String(itemId)
        && (skuId ? item.sku?.skuId === String(skuId) : item.sku === null || item.sku === undefined));
      const cartQuantity = Number.parseInt(String(result.cartQuantity ?? ''), 10);
      return {
        data: {
          itemId: String(itemId),
          skuId: skuId ?? null,
          quantity,
          added: true,
          cartQuantity: Number.isFinite(cartQuantity) ? cartQuantity : null,
          entryFound: Boolean(entry),
          entry: entry ?? null,
        },
        meta: {
          provider: 'web-cart-add', observedAt: new Date().toISOString(),
          verification: entry ? 'query-bag-confirmed' : 'not-in-current-page',
          note: entry ? undefined : '加购请求已成功（网关返回 cartQuantity），但 query.bag 当前页未出现该条目——购物车可能分页或该商品待生效，请人工核对。',
        },
      };
    });
  }

  // 删除购物车条目（写操作）：mtop.trade.update.bag 4.0（dinamicx 链接协议）。
  // 流程 = query.bag 拉新树（取 linkage 签名与组件）→ 构造删除 payload POST
  // update.bag → 回读 query.bag 核对条目消失。共 3 次请求，全程走限速。
  // 删除不可逆；契约详见 cart.js buildRemoveUpdateData 注释（官方 bundle 逆向
  // + 2026-11-14 真实探针验证）。
  async removeFromCart(cartId: string, signal?: AbortSignal): Promise<SdkResult<CartRemoveData>> {
    requireId(String(cartId), 'cartId');
    return this.withLog('cart-remove', { cartId }, async () => {
      const payload = await this.fetchCartPayload(signal);
      const keyname = `item_${cartId}`;
      const components = (payload?.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, { tag?: string; fields?: Record<string, unknown> }>;
      const trigger = components[keyname];
      if (!trigger || trigger.tag !== 'item') {
        throw new TaobaoError('NO_RESULTS',
          `购物车中不存在条目 ${cartId}（可能已删除或 cartId 失效）。可用 cart-list 查看当前条目及其 cartId。`);
      }
      const updateData = buildRemoveUpdateData(payload, cartId);
      await this.client.request(UPDATE_BAG_API[0], UPDATE_BAG_API[1], updateData, {
        signal, ...CART_REQUEST, method: 'POST',
      });
      // 回读核对：update.bag 响应结构与 query.bag 不同，条目删除与否以回读为准。
      const verify = await this.fetchCartPayload(signal);
      const after = (verify?.data && typeof verify.data === 'object' ? verify.data : {}) as Record<string, { tag?: string }>;
      const entryGone = !(after[keyname] && after[keyname].tag === 'item');
      return {
        data: {
          cartId: String(cartId),
          itemId: trigger.fields?.itemId != null ? String(trigger.fields.itemId) : null,
          title: typeof trigger.fields?.title === 'string' ? trigger.fields.title : null,
          removed: true,
          entryGone,
          remainingCount: Object.values(after).filter(c => c?.tag === 'item').length,
        },
        meta: {
          provider: 'mtop-http-cart-remove', observedAt: new Date().toISOString(),
          verification: entryGone ? 'query-bag-confirmed' : 'entry-still-present',
          note: entryGone ? undefined : 'update.bag 已返回成功但回读仍见该条目——可能是分页/生效延迟，请人工核对。',
        },
      };
    });
  }

  // 评价计数（1 次请求，rateList 内容丢弃）。total 是平台封顶值（2000/1000 等），
  // 真实数量级以 totalFuzzy 模糊文本为准；foldedDefault 为折叠的默认好评数，
  // 占比高提示刷单嫌疑。平台已隐藏差评数（hideBadCount），无中差评分项可取。
  async getReviewSummary(itemId: string, signal?: AbortSignal): Promise<SdkResult<ReviewSummaryData>> {
    requireId(itemId);
    return this.withLog('review-summary', { itemId }, async () => {
      const payload = await this.client.request(RATE_API[0], RATE_API[1], {
        auctionNumId: itemId, currentPage: '1', pageSize: '10', orderType: '',
      }, { signal, referer: `https://item.taobao.com/item.htm?id=${itemId}` });
      // 汇总字段实测为字符串（"2000"/"1629"），统一转数字；解析不了保持 null。
      const toCount = (value: unknown): number | null => {
        const num = Number(value);
        return Number.isFinite(num) && String(value).trim() !== '' ? num : null;
      };
      const total = toCount(payload?.total);
      const folded = toCount(payload?.foldCount);
      const fuzzy = [payload?.totalFuzzy, payload?.fuzzyRateCount]
        .find((value): value is string => typeof value === 'string' && value.length > 0) || null;
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
    });
  }

  // 批量执行：单项失败不影响其余项；但登录态失效（AUTH_REQUIRED）或风控拦截
  // （RISK_CONTROL）会立即终止整批——那两种状态下继续请求只会逐项重复失败
  // 并持续累积坏指纹（登录态体检：不带坏状态去撞接口）。
  async batch(input: BatchInput, signal?: AbortSignal, { onProgress }: BatchCallbacks = {}): Promise<SdkResult<BatchData>> {
    return this.withLog('batch', {
      searches: (input.searches || []).length,
      products: (input.products || []).length,
    }, async () => {
      const results: BatchResultItem[] = [];
      const isFatal = (error: unknown): boolean => {
        const code = getErrorCode(error);
        return code === 'AUTH_REQUIRED' || code === 'RISK_CONTROL';
      };
      let aborted: BatchErrorSummary | null = null;
      const toAbort = (error: unknown): BatchErrorSummary | null =>
        isFatal(error) ? { code: getErrorCode(error, 'MTOP_ERROR'), message: getErrorMessage(error) } : null;
      const emitProgress = async (): Promise<void> => {
        if (!onProgress) return;
        const failed = results.filter(item => 'error' in item).length;
        await onProgress({
          results: [...results],
          total: results.length,
          succeeded: results.length - failed,
          failed,
          ...(aborted ? { aborted } : {}),
        });
      };
      for (const entry of input.searches || []) {
        if (aborted) break;
        const { keyword, options } = typeof entry === 'string' ? { keyword: entry, options: {} } : entry;
        try { results.push({ kind: 'search', keyword, result: await this.search(keyword, options, signal) }); }
        catch (error: unknown) {
          results.push({ kind: 'search', keyword, error: { code: getErrorCode(error, 'MTOP_ERROR'), message: getErrorMessage(error) } });
          if (!aborted) aborted = toAbort(error);
        }
        await emitProgress();
      }
      for (const product of input.products || []) {
        if (aborted) break;
        const specs: (SpecInput | null)[] = Array.isArray(product.specs) && product.specs.length ? product.specs : [null];
        // 同商品只拉一次 catalog，多规格在内存里复用——否则 N 个规格 = N 次详情请求。
        let catalog: FetchedCatalog | null = null;
        try {
          requireId(product.itemId);
          catalog = await this.fetchCatalog(product.itemId, signal);
        } catch (error: unknown) {
          const errSummary: BatchErrorSummary = { code: getErrorCode(error, 'MTOP_ERROR'), message: getErrorMessage(error) };
          for (const spec of specs) {
            results.push(spec
              ? { kind: 'detail', itemId: product.itemId, error: errSummary }
              : { kind: 'specs', itemId: product.itemId, error: errSummary });
          }
          if (!aborted) aborted = toAbort(error);
          await emitProgress();
          continue;
        }
        for (const spec of specs) {
          try {
            if (spec) {
              results.push({ kind: 'detail', itemId: product.itemId, result: this.detailFromCatalog(catalog, product.itemId, spec) });
            } else {
              results.push({
                kind: 'specs',
                itemId: product.itemId,
                result: { data: publicSpecs(buildMtopSpecs(product.itemId, catalog)), meta: { provider: 'mtop-http', observedAt: new Date().toISOString() } },
              });
            }
          } catch (error: unknown) {
            const errSummary: BatchErrorSummary = { code: getErrorCode(error, 'MTOP_ERROR'), message: getErrorMessage(error) };
            results.push(spec
              ? { kind: 'detail', itemId: product.itemId, error: errSummary }
              : { kind: 'specs', itemId: product.itemId, error: errSummary });
            if (isFatal(error)) {
              if (!aborted) aborted = toAbort(error);
              break;
            }
          }
        }
        await emitProgress();
      }
      const failed = results.filter(item => 'error' in item).length;
      const finalAborted = aborted;
      return {
        data: {
          results, total: results.length, succeeded: results.length - failed, failed,
          ...(finalAborted ? {
            aborted: finalAborted,
            note: `批量在第 ${results.length} 项后提前终止（${finalAborted.code}）：登录态失效或风控拦截时继续执行只会逐项重复失败，剩余条目未执行。处理后重跑即可。`,
          } : {}),
        },
        meta: { provider: 'mtop-http', observedAt: new Date().toISOString() },
      };
    });
  }
}
