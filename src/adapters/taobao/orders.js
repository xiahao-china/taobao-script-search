// 已买到的宝贝（购物记录）：mtop.taobao.order.queryboughtlistV2 v1.0。
// 响应为「每单一组」的组件流：group[] 内每个对象以订单号为键，值是 cellType 分类的
// cell 数组（storage/head/sub/pay/orderop）。金额都是「￥x.xx」文案，剥离为纯数字字符串。
// 注意：响应里 17 位订单号若以 JSON number 出现会丢精度，订单号一律取对象键（字符串）。
import { TaobaoError } from '../../core/errors.js';

const yuan = value => {
  const text = String(value ?? '').replace(/[^0-9.]/g, '');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
};

const int = value => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

// priceInfo 各字段是「￥x.xx / null / 优惠文案」混合体；按可靠度取第一个可剥离出数字的。
function itemPrice(priceInfo) {
  for (const key of ['actualTotalFee', 'realTotal', 'promotion', 'original']) {
    const value = yuan(priceInfo?.[key]);
    if (value) return value;
  }
  return null;
}

// 同类 cell 可能出现多次（一笔订单含 N 个商品就有 N 个 sub cell），必须全部收集。
function cellFields(cells, cellType, tag) {
  return cells.filter(entry => entry.cellType === cellType)
    .flatMap(cell => (cell.cellData || []).filter(entry => !tag || entry.tag === tag))
    .map(entry => entry.fields || {});
}

function fields0(fields) {
  return fields[0] ?? null;
}

// 单个 group（一个订单）→ 统一订单结构。
export function mapOrder(group) {
  const orderId = Object.keys(group)[0];
  const cells = Array.isArray(group[orderId]) ? group[orderId] : [];
  const storage = fields0(cellFields(cells, 'storage', 'storage')) || {};
  const seller = fields0(cellFields(cells, 'head', 'seller')) || {};
  const status = fields0(cellFields(cells, 'head', 'status')) || {};
  const pay = fields0(cellFields(cells, 'pay', 'pay')) || {};
  const items = cellFields(cells, 'sub', 'item').map(fields => {
    const pic = typeof fields.pic === 'string' && fields.pic ? `https:${fields.pic}` : null;
    const auctionId = Array.isArray(storage.subAuctionIds) ? String(storage.subAuctionIds[0] ?? '') : '';
    return {
      title: typeof fields.title === 'string' ? fields.title : null,
      skuText: fields.skuText ?? null,
      quantity: int(fields.quantity),
      price: itemPrice(fields.priceInfo),
      auctionId: /^\d+$/.test(auctionId) ? auctionId : null,
      pic,
    };
  });
  return {
    orderId: /^\d+$/.test(String(orderId)) ? String(orderId) : null,
    shopName: seller.shopName || seller.nick || storage.sellerNick || null,
    status: status.text || null,
    paid: yuan(pay.actualFee?.value),
    total: yuan(pay.totalFee?.value),
    discount: yuan(pay.discountFee?.value),
    items,
  };
}

export function extractOrders(payload) {
  const data = payload?.data ?? payload;
  const page = data?.meta?.page?.fields ?? {};
  const groups = Array.isArray(data?.group) ? data.group : [];
  const orders = groups.map(mapOrder).filter(order => order.orderId && order.items.length);
  return {
    orders,
    pagination: {
      currentPage: int(page.currentPage),
      totalPage: int(page.totalPage),
      pageSize: int(page.pageSize),
      totalNumber: int(page.totalNumber),
    },
  };
}

export function assertOrdersPayload(payload) {
  const { orders, pagination } = extractOrders(payload);
  if (!orders.length && !pagination.totalPage) {
    throw new TaobaoError('NO_RESULTS', '订单接口未返回订单数据；可能是登录态不完整、页码越界或返回结构变化。');
  }
  return { orders, pagination };
}
