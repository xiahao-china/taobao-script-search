// 购物车内容（query.bag）：mtop.trade.query.bag v5.0。
// 响应为「组件字典」：data 下每个键是一个组件（item_<cartId>/shop_s_<sellerId>/
// group_*/submit_1/global_1/popwindow…）。商品组件 tag='item'（type dinamicx$cartitem），
// 店铺组件 tag='shop'（type dinamicx$cartshop），item.bundleId（形如 s_<sellerId>）
// 与店铺组件键 shop_<bundleId> 对应。金额字段 pay.nowTitle 是「￥x.xx」文案，
// pay.total/afterPromPrice 是分（整数），金额一律以文案剥离为准，分值仅作对照。
// 注意：cartId 是购物车条目 ID（非订单号），但同为 13 位长数字——解析全程走字符串键。
import { TaobaoError } from '../../core/errors.js';
import { normalizeUrl } from '../../core/url.js';

const int = value => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

// 「￥2.1」「￥0.04」等文案 → 纯数字字符串；剥不出保持 null（不猜）。
const yuan = value => {
  const text = String(value ?? '').replace(/[^0-9.]/g, '');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
};

// 单个 item 组件 → 统一条目结构。sku 为空对象/缺省（无规格商品 skuId='0'）时为 null。
function mapItem(component, shops) {
  const fields = component?.fields ?? {};
  const itemId = String(fields.itemId ?? '');
  if (!/^\d+$/.test(itemId)) return null;
  const cartId = /^\d+$/.test(String(fields.cartId)) ? String(fields.cartId) : null;
  const skuId = String(fields.sku?.skuId ?? '');
  const skuTitle = typeof fields.sku?.title === 'string' && fields.sku.title.trim() ? fields.sku.title.trim() : null;
  const shop = shops[component.bundleId ?? fields.bundleId] ?? null;
  return {
    cartId,
    itemId,
    title: typeof fields.title === 'string' ? fields.title : null,
    sku: skuId && skuId !== '0' ? { skuId, title: skuTitle } : null,
    quantity: int(fields.quantity),
    priceText: yuan(fields.pay?.nowTitle),
    priceCents: int(fields.pay?.total),
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

// payload.data 是组件字典；shops 以 bundleId（s_<sellerId>）为键索引店铺名/shopId。
export function extractCart(payload) {
  const components = payload?.data ?? payload ?? {};
  const shops = {};
  const summaryFields = {};
  let headerTitle = null;
  for (const [key, component] of Object.entries(components)) {
    if (!component || typeof component !== 'object') continue;
    if (component.tag === 'shop') {
      const shopId = component.fields?.bizArgs?.shopId != null ? String(component.fields.bizArgs.shopId) : null;
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
    .map(([key, component]) => mapItem(component, shops))
    .filter(Boolean);
  const submit = summaryFields.submit ?? {};
  const pay = summaryFields.pay ?? {};
  return {
    items,
    shops: Object.values(shops).filter(shop => shop.title || shop.shopId),
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

export function assertCartPayload(payload) {
  // 空购物车是合法状态（header/submit 壳组件仍在）；只有连壳都没有才算结构异常
  //（登录态不完整/接口变化），避免空车被误报成错误。
  const components = payload?.data ?? payload ?? {};
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
export function parseAddCartResult(text) {
  const match = String(text || '').match(/TB\.Detail\.CartResult\s*=\s*(\{[^}]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
