// 购物车内容（query.bag）：mtop.trade.query.bag v5.0。
// 响应为「组件字典」：data 下每个键是一个组件（item_<cartId>/shop_s_<sellerId>/
// group_*/submit_1/global_1/popwindow…）。商品组件 tag='item'（type dinamicx$cartitem），
// 店铺组件 tag='shop'（type dinamicx$cartshop），item.bundleId（形如 s_<sellerId>）
// 与店铺组件键 shop_<bundleId> 对应。金额字段 pay.nowTitle 是「￥x.xx」文案，
// pay.total/afterPromPrice 是分（整数），金额一律以文案剥离为准，分值仅作对照。
// 注意：cartId 是购物车条目 ID（非订单号），但同为 13 位长数字——解析全程走字符串键。
import { TaobaoError } from '../../core/errors.js';
import { normalizeUrl } from '../../core/url.js';
import type { CartItem, CartListData, CartShop } from '../../types.js';

interface RawCartComponent {
  id?: string;
  tag?: string;
  type?: string;
  bundleId?: string;
  fields?: Record<string, unknown>;
  events?: Record<string, Array<{ tag?: string; type?: string; fields?: Record<string, unknown> }>>;
}

interface RawLinkage {
  input?: string[];
  common?: {
    queryParams?: unknown;
    compress?: unknown;
    validateParams?: unknown;
  };
  signature?: string;
}

const int = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

// 「￥2.1」「￥0.04」等文案 → 纯数字字符串；剥不出保持 null（不猜）。
const yuan = (value: unknown): string | null => {
  const text = String(value ?? '').replace(/[^0-9.]/g, '');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
};

// 单个 item 组件 → 统一条目结构。sku 为空对象/缺省（无规格商品 skuId='0'）时为 null。
function mapItem(component: RawCartComponent, shops: Record<string, CartShop>): CartItem | null {
  const fields = component.fields ?? {};
  const itemId = String(fields.itemId ?? '');
  if (!/^\d+$/.test(itemId)) return null;
  const cartId = /^\d+$/.test(String(fields.cartId)) ? String(fields.cartId) : null;
  const skuNode = (fields.sku && typeof fields.sku === 'object' ? fields.sku : {}) as Record<string, unknown>;
  const skuId = String(skuNode.skuId ?? '');
  const skuTitle = typeof skuNode.title === 'string' && skuNode.title.trim() ? skuNode.title.trim() : null;
  const bundleKey = typeof component.bundleId === 'string'
    ? component.bundleId
    : (typeof fields.bundleId === 'string' ? fields.bundleId : '');
  const shop = bundleKey ? (shops[bundleKey] ?? null) : null;
  const pay = (fields.pay && typeof fields.pay === 'object' ? fields.pay : {}) as Record<string, unknown>;
  return {
    cartId,
    itemId,
    title: typeof fields.title === 'string' ? fields.title : null,
    sku: skuId && skuId !== '0' ? { skuId, title: skuTitle } : null,
    quantity: int(fields.quantity),
    priceText: yuan(pay.nowTitle),
    priceCents: int(pay.total),
    pic: normalizeUrl(fields.pic),
    url: normalizeUrl(fields.outerUrl) ?? `https://item.taobao.com/item.htm?id=${itemId}`,
    shopName: shop?.title ?? null,
    shopId: shop?.shopId ?? null,
    toBuy: typeof fields.toBuy === 'string' ? fields.toBuy : null,
    isChecked: fields.isChecked === 'true',
    canCheck: fields.canCheck === true,
    checkedOut: fields.checkedOut === true,
  };
}

function getComponents(payload: unknown): Record<string, RawCartComponent> {
  if (!payload || typeof payload !== 'object') return {};
  const obj = payload as Record<string, unknown>;
  const target = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  return target as Record<string, RawCartComponent>;
}

// payload.data 是组件字典；shops 以 bundleId（s_<sellerId>）为键索引店铺名/shopId。
export function extractCart(payload: unknown): CartListData {
  const components = getComponents(payload);
  const shops: Record<string, CartShop> = {};
  const summaryFields: Record<string, unknown> = {};
  let headerTitle: string | null = null;
  for (const [key, component] of Object.entries(components)) {
    if (!component || typeof component !== 'object') continue;
    if (component.tag === 'shop') {
      const bizArgs = (component.fields?.bizArgs && typeof component.fields.bizArgs === 'object'
        ? component.fields.bizArgs : {}) as Record<string, unknown>;
      const shopId = bizArgs.shopId != null ? String(bizArgs.shopId) : null;
      const keyShopId = /^shop_s_(\d+)$/.exec(key)?.[1] ?? null;
      shops[component.id ?? key] = {
        title: typeof component.fields?.title === 'string' ? component.fields.title : null,
        shopId: shopId ?? keyShopId,
      };
    } else if (component.tag === 'submit') {
      Object.assign(summaryFields, component.fields ?? {});
    } else if (component.tag === 'header' && typeof component.fields?.title === 'string') {
      headerTitle = component.fields.title;
    }
  }
  const items = Object.entries(components)
    .filter(([, component]) => component?.tag === 'item')
    .map(([, component]) => mapItem(component, shops))
    .filter((item): item is CartItem => item !== null);
  const submit = (summaryFields.submit && typeof summaryFields.submit === 'object'
    ? summaryFields.submit : {}) as Record<string, unknown>;
  const pay = (summaryFields.pay && typeof summaryFields.pay === 'object'
    ? summaryFields.pay : {}) as Record<string, unknown>;
  return {
    items,
    shops: Object.values(shops).filter(shop => Boolean(shop.title || shop.shopId)),
    summary: {
      itemCount: items.length,
      checkedCount: int(submit.checkedCount ?? summaryFields.quantity),
      totalPriceText: yuan(pay.priceTitle),
      totalDiscountText: yuan(pay.totalDiscount),
      submitTitle: typeof submit.title === 'string' ? submit.title : null,
    },
    pageTitle: headerTitle,
  };
}

export function assertCartPayload(payload: unknown): CartListData {
  // 空购物车是合法状态（header/submit 壳组件仍在）；只有连壳都没有才算结构异常
  //（登录态不完整/接口变化），避免空车被误报成错误。
  const components = getComponents(payload);
  const hasShell = Object.values(components)
    .some(component => component?.tag === 'item' || component?.tag === 'submit' || component?.tag === 'header');
  if (!hasShell) {
    throw new TaobaoError('NO_RESULTS', '购物车接口未返回购物车组件数据；可能是登录态不完整或返回结构变化。');
  }
  return extractCart(payload);
}

// 加购端点（cart.taobao.com/add_cart_item.htm）成功响应：GBK HTML 内嵌
// 「TB.Detail.CartResult = { "cartQuantity": "21", "cartPrice": "" }」。
// cartQuantity 是网关侧购物车全量计数（含失效/隐藏条目，query.bag 只回当前页
// 有效条目，两者不相等是常态）——只作加购成功的旁证，真实核对以回读 query.bag 为准。
export function parseAddCartResult(text: string): { cartQuantity?: string; cartPrice?: string; [key: string]: unknown } | null {
  const match = String(text || '').match(/TB\.Detail\.CartResult\s*=\s*(\{[^}]*\})/);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

// ── 删除购物车条目（mtop.trade.update.bag 4.0）────────────────────────────
// 契约来自 H5 购物车官方 bundle（g.alicdn.com/dinamic/h5-tb-cart/5.0.66）逆向，
// 并已于 2026-11-14 真实删除探针验证（tools/probe-remove-cart.mjs）：
// 1. dinamicx 链接协议：query.bag 响应携带 linkage{input,common,signature}，
//    update.bag 回传「触发组件(事件字段合并变更) + linkage.input 组件 + hierarchy
//    + linkage.common 三字段 + signature」，整体再包一层 { params: <json 字符串> }
//    （requestAdaptor 双层 JSON；顶层对象值先各自 stringify 成字符串）。
// 2. 删除动作：operatorEvent = "deleteClick." + 事件配置 type（恒为 cartAdjustOperate），
//    operator = 触发组件 keyname（item_<cartId>），
//    变更 = events.deleteClick[0].fields.operateItems 填入 [keyname]。
// 3. 成功响应顶层为 { global, hierarchy, linkage, reload }（结构与 query.bag 不同，
//    条目是否删除以回读 query.bag 为准）。
export function buildRemoveUpdateData(payload: Record<string, unknown>, cartId: string): { params: string } {
  const components = getComponents(payload);
  const keyname = `item_${cartId}`;
  const trigger = components[keyname];
  if (!trigger || trigger.tag !== 'item') {
    throw new TaobaoError('NO_RESULTS', `购物车中不存在条目 ${cartId}（可能已删除或 cartId 失效；可用 cart-list 查看当前条目）。`);
  }
  const linkage = payload.linkage as RawLinkage | undefined;
  if (!linkage?.signature) {
    throw new TaobaoError('MTOP_ERROR', 'query.bag 响应缺 linkage 签名信息，购物车写协议可能已变化，操作中止。');
  }
  const mutated = JSON.parse(JSON.stringify(trigger)) as RawCartComponent;
  const delEvent = mutated.events?.deleteClick?.[0];
  if (!delEvent || delEvent.type !== 'cartAdjustOperate' || !delEvent.fields) {
    throw new TaobaoError('MTOP_ERROR', '触发组件缺 cartAdjustOperate deleteClick 事件，购物车写协议可能已变化，操作中止。');
  }
  delEvent.fields.operateItems = [keyname];
  const common = linkage.common ?? {};
  const hierarchy = payload.hierarchy as { structure?: unknown } | undefined;
  const inner = {
    operatorEvent: `deleteClick.${delEvent.type}`,
    operator: keyname,
    data: JSON.stringify({
      ...Object.fromEntries((linkage.input ?? []).map(k => [k, components[k]] as const).filter(([, v]) => Boolean(v))),
      [keyname]: mutated,
    }),
    hierarchy: JSON.stringify({ structure: hierarchy?.structure ?? {} }),
    linkage: JSON.stringify({
      common: { queryParams: common.queryParams, compress: common.compress, validateParams: common.validateParams },
      signature: linkage.signature,
    }),
  };
  return { params: JSON.stringify(inner) };
}
