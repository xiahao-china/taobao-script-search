// 已买到的宝贝（购物记录）：mtop.taobao.order.queryboughtlistV2 v1.0。
// 响应为「每单一组」的组件流：group[] 内每个对象以订单号为键，值是 cellType 分类的
// cell 数组（storage/head/sub/pay/orderop）。金额都是「￥x.xx」文案，剥离为纯数字字符串。
// 注意：响应里 17 位订单号若以 JSON number 出现会丢精度，订单号一律取对象键（字符串）。
import { TaobaoError } from '../../core/errors.js';
import { normalizeUrl } from '../../core/url.js';
import type { OrderItem, OrderRecord, OrdersPagination } from '../../types.js';

interface RawCellEntry {
  tag?: string;
  fields?: Record<string, unknown>;
}

interface RawCell {
  cellType?: string;
  cellData?: RawCellEntry[];
}

const yuan = (value: unknown): string | null => {
  const text = String(value ?? '').replace(/[^0-9.]/g, '');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
};

const int = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
};

// priceInfo 各字段是「￥x.xx / null / 优惠文案」混合体；按可靠度取第一个可剥离出数字的。
function itemPrice(priceInfo: unknown): string | null {
  if (!priceInfo || typeof priceInfo !== 'object') return null;
  const record = priceInfo as Record<string, unknown>;
  for (const key of ['actualTotalFee', 'realTotal', 'promotion', 'original'] as const) {
    const value = yuan(record[key]);
    if (value) return value;
  }
  return null;
}

// 同类 cell 可能出现多次（一笔订单含 N 个商品就有 N 个 sub cell），必须全部收集。
function cellFields(cells: readonly RawCell[], cellType: string, tag?: string): Record<string, unknown>[] {
  return cells
    .filter(entry => entry.cellType === cellType)
    .flatMap(cell => (cell.cellData || []).filter(entry => !tag || entry.tag === tag))
    .map(entry => entry.fields || {});
}

function fields0(fields: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  return fields[0] ?? null;
}

// 单个 group（一个订单）→ 统一订单结构。
export function mapOrder(group: Record<string, unknown>): OrderRecord {
  const orderId = Object.keys(group)[0] ?? '';
  const rawCells = group[orderId];
  const cells: RawCell[] = Array.isArray(rawCells) ? (rawCells as RawCell[]) : [];
  const storage = fields0(cellFields(cells, 'storage', 'storage')) || {};
  const seller = fields0(cellFields(cells, 'head', 'seller')) || {};
  const status = fields0(cellFields(cells, 'head', 'status')) || {};
  const pay = fields0(cellFields(cells, 'pay', 'pay')) || {};
  // 同单多商品：sub cell 顺序与 storage.subAuctionIds 一一对应，必须按索引取，
  // 否则第 2~N 件商品全部错挂第 1 件的 auctionId。
  const subAuctionIds = Array.isArray(storage.subAuctionIds) ? storage.subAuctionIds : [];
  const items: OrderItem[] = cellFields(cells, 'sub', 'item').map((fields, index) => {
    const pic = normalizeUrl(fields.pic);
    const auctionId = String(subAuctionIds[index] ?? '');
    return {
      title: typeof fields.title === 'string' ? fields.title : null,
      skuText: typeof fields.skuText === 'string' ? fields.skuText : null,
      quantity: int(fields.quantity),
      price: itemPrice(fields.priceInfo),
      auctionId: /^\d+$/.test(auctionId) ? auctionId : null,
      pic,
    };
  });
  const actualFee = pay.actualFee as { value?: unknown } | undefined;
  const totalFee = pay.totalFee as { value?: unknown } | undefined;
  const discountFee = pay.discountFee as { value?: unknown } | undefined;
  return {
    orderId: /^\d+$/.test(orderId) ? orderId : null,
    shopName: (typeof seller.shopName === 'string' && seller.shopName)
      || (typeof seller.nick === 'string' && seller.nick)
      || (typeof storage.sellerNick === 'string' && storage.sellerNick)
      || null,
    status: typeof status.text === 'string' && status.text ? status.text : null,
    paid: yuan(actualFee?.value),
    total: yuan(totalFee?.value),
    discount: yuan(discountFee?.value),
    items,
  };
}

export function extractOrders(payload: unknown): { orders: OrderRecord[]; pagination: OrdersPagination } {
  const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const meta = (data.meta && typeof data.meta === 'object' ? data.meta : {}) as Record<string, unknown>;
  const pageNode = (meta.page && typeof meta.page === 'object' ? meta.page : {}) as Record<string, unknown>;
  const page = (pageNode.fields && typeof pageNode.fields === 'object' ? pageNode.fields : {}) as Record<string, unknown>;
  const groups = Array.isArray(data.group) ? (data.group as Record<string, unknown>[]) : [];
  const orders = groups.map(mapOrder).filter(order => Boolean(order.orderId) && order.items.length > 0);
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

export function assertOrdersPayload(payload: unknown): { orders: OrderRecord[]; pagination: OrdersPagination } {
  const { orders, pagination } = extractOrders(payload);
  if (!orders.length && !pagination.totalPage) {
    throw new TaobaoError('NO_RESULTS', '订单接口未返回订单数据；可能是登录态不完整、页码越界或返回结构变化。');
  }
  return { orders, pagination };
}
