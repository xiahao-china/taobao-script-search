// 拉取 2026-06-30 起的全部购物记录并落成 CSV。
// 接口：mtop.taobao.order.queryboughtlistv2 v1.0，appVersion 3.0（响应为扁平组件：
// MainGroup_<id> 带下单毫秒时间戳、sellerInfo_<id> 店铺/状态、item_<id>_* 商品、pay_<id>/ 实付）。
// 列表按时间倒序翻页，整页时间早于截止线即停。进度逐页落盘 .runtime/orders-export-progress.json，
// 中断后重跑自动续传。用法：node tools/export-orders-csv.mjs
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { loadCookies, cookieSummary } from '../src/core/cookie-store.js';
import { MtopClient, parseBody } from '../src/core/mtop-client.js';
import { normalizeUrl } from '../src/core/url.js';

const CUTOFF = Date.parse('2026-06-30T00:00:00+08:00'); // 含 6月30日当天
const CSV_PATH = '.runtime/artifacts/taobao-orders-since-2026-06-30.csv';
const PROGRESS_PATH = '.runtime/orders-export-progress.json';

const REFERER = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const EXTRA = { ecode: '1', AntiCreep: 'true', ttid: '201200@taobao_iphone_99.99.99' };
const REQUEST_DATA = page => ({
  tabCode: 'all', appVersion: '3.0', OrderType: 'OrderList',
  condition: { inner: 1, deviceLevel: 'high', version: '1.0.0', reqFrom: 'tbpc' },
  appName: 'tborder', templateConfigVersion: 0, forceBoughtlist4: 4, page,
});

const yuan = value => {
  const text = String(value ?? '').replace(/[^0-9.]/g, '');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
};
const fmtTime = ms => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(Number(ms)));

const csvCell = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// 一页响应 → [{orderId, createOrderTime, shopName, status, paid, items:[...]}]
function parsePage(payload) {
  const data = payload?.data ?? {};
  const ids = Object.keys(data)
    .filter(key => /^Main_\d+$/.test(key))
    .map(key => key.slice('Main_'.length));
  return ids.map(id => {
    const main = data[`MainGroup_${id}`]?.fields || {};
    const seller = data[`sellerInfo_${id}`]?.fields || {};
    const items = Object.entries(data)
      .filter(([key]) => key.startsWith(`item_${id}_`) && key !== `itemContain_${id}`)
      .map(([, cell]) => cell?.fields?.item)
      .filter(Boolean)
      .map(item => ({
        title: item.title ?? null,
        skuText: item.skuText ?? null,
        quantity: Number.parseInt(item.quantity, 10) || null,
        subtotal: yuan(item.priceInfo?.actualTotalFee),
        unitPrice: yuan(item.priceInfo?.itemUnitPrice),
        listPrice: yuan(item.priceInfo?.promotion),
        pic: normalizeUrl(item.pic),
        itemId: main.itemId != null ? String(main.itemId) : null,
      }));
    const payCell = Object.entries(data).find(([key]) => key.startsWith(`pay_${id}`))?.[1];
    const pay = payCell?.fields || {};
    return {
      orderId: /^\d+$/.test(String(main.orderId || id)) ? String(main.orderId || id) : null,
      createOrderTime: main.createOrderTime || seller.orderCreateTime || null,
      shopName: seller.seller?.shopName || null,
      status: seller.status?.text || null,
      paid: yuan(pay.actualFee?.value),
      items,
    };
  }).filter(order => order.orderId);
}

async function main() {
  const store = await loadCookies(null);
  if (!cookieSummary(store).hasLoginState) throw new Error('AUTH_REQUIRED: 请先配置 cookie.json 登录态');
  const client = new MtopClient({ minIntervalMs: 2000, jitterMs: 1500 });

  // 续传：读上次进度（已确认完成翻页的订单按 orderId 去重保留）。
  let done = false, pages = 0, orders = [];
  try {
    const saved = JSON.parse(await readFile(PROGRESS_PATH, 'utf8'));
    if (saved.done) { console.log('上次运行已完成，直接重写 CSV。'); orders = saved.orders; done = true; }
    else { orders = saved.orders; pages = saved.pages; console.log(`续传：已有 ${orders.length} 单 / ${pages} 页`); }
  } catch { /* 首次运行 */ }

  while (!done) {
    pages += 1;
    const payload = await client.request('mtop.taobao.order.queryboughtlistv2', '1.0', REQUEST_DATA(pages), { extraParams: EXTRA, referer: REFERER });
    const pageOrders = parsePage(payload);
    const times = pageOrders.map(order => Number(order.createOrderTime)).filter(Number.isFinite);
    const oldest = times.length ? Math.min(...times) : null;
    const seen = new Set(orders.map(order => order.orderId));
    const fresh = pageOrders.filter(order => !seen.has(order.orderId));
    orders.push(...fresh);
    const inRange = times.length && oldest >= CUTOFF;
    console.log(`page ${pages}: +${fresh.length} 单（页内最旧 ${oldest ? fmtTime(oldest) : '无时间'}）累计 ${orders.length}`);
    if (times.length && oldest < CUTOFF) done = true; // 倒序翻页：整页越过截止线即结束（最后一页的跨线订单统一在导出前过滤）
    if (!pageOrders.length) { done = true; console.log('接口返回空页，停止。'); }
    await writeFile(PROGRESS_PATH, JSON.stringify({ pages, done, orders }, null, 1));
  }

  const inRange = orders
    .map(order => ({ ...order, timeMs: Number(order.createOrderTime) }))
    .filter(order => Number.isFinite(order.timeMs) && order.timeMs >= CUTOFF)
    .sort((a, b) => b.timeMs - a.timeMs);
  const dropped = orders.length - inRange.length;

  const header = ['下单时间', '订单号', '店铺', '订单状态', '实付款', '商品标题', '规格', '数量', '商品小计', '商品单价', '原价/促销价', '商品ID', '商品图'];
  const lines = ['\uFEFF' + header.join(',')];
  for (const order of inRange) {
    const orderCells = [fmtTime(order.timeMs), order.orderId, order.shopName, order.status, order.paid];
    order.items.forEach((item, index) => {
      const itemCells = [item.title, item.skuText, item.quantity, item.subtotal, item.unitPrice, item.listPrice, item.itemId, item.pic];
      // 订单级字段只写在首行，避免 Excel 求和重复计数
      lines.push((index === 0 ? [...orderCells, ...itemCells] : ['', '', '', '', '', ...itemCells]).map(csvCell).join(','));
    });
    if (!order.items.length) lines.push([...orderCells, '', '', '', '', '', '', '', ''].map(csvCell).join(','));
  }
  await mkdir('.runtime/artifacts', { recursive: true });
  await writeFile(CSV_PATH, lines.join('\r\n') + '\r\n');

  const totalItems = inRange.reduce((sum, order) => sum + order.items.length, 0);
  console.log(`完成：${inRange.length} 单 / ${totalItems} 件商品（截止线外丢弃 ${dropped} 单）→ ${CSV_PATH}`);
}

main().catch(error => {
  console.error('FAILED:', error.code || '', error.message);
  process.exitCode = 1;
});
