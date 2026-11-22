// 一次性探针：PC 网页端点加入购物车（cart.taobao.com/add_cart_item.htm）。
// 参照：clawhub @mayf3/add-to-cart（2026-11 仍验证有效）、QGB/QPSU taobao_trade.py
// add_cart_item()、2016 CSDN 参数分析（item_id/outer_id/quantity/_tb_token_）。
// 目标：确认最小参数集（item_id + quantity + _tb_token_）在纯 HTTP 下的响应形态。
// 这是写操作：真实加购 1 件商品到用户购物车，跑之前想清楚。
import { loadCookies, cookieHeader } from '../build/core/cookie-store.js';
import { reserveSlot, appendRequestLog } from '../build/core/mtop-client.js';

const ITEM_ID = process.argv[2] || '653734638954';
const SKU_ID = process.argv[3] || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const store = await loadCookies(null);
const header = cookieHeader(store);
if (!header) { console.log('NO_COOKIES'); process.exit(1); }
const token = (store.cookies._tb_token_?.value || '').split(',')[0];
console.log('has _tb_token_:', Boolean(token));

await reserveSlot(null, 5000, 5000, undefined);
const params = new URLSearchParams({
  item_id: ITEM_ID,
  quantity: '1',
  _tb_token_: token,
  ...(SKU_ID ? { sku_id: SKU_ID } : {}),
});
const url = `https://cart.taobao.com/add_cart_item.htm?${params}`;
const started = Date.now();
let response;
try {
  response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      Referer: `https://item.taobao.com/item.htm?id=${ITEM_ID}`,
      Cookie: header,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
} catch (error) {
  console.log('FETCH_FAIL:', error.message);
  process.exit(1);
}
await appendRequestLog(null, {
  t: started, ts: new Date(started).toISOString(), api: 'web-add-cart', ok: response.ok,
  http: response.status, ms: Date.now() - started, url,
});
const setCookies = response.headers.getSetCookie();
const location = response.headers.get('location');
const buffer = Buffer.from(await response.arrayBuffer());
const ctype = response.headers.get('content-type') || '';
const text = /charset=gb/i.test(ctype) ? buffer.toString('latin1') : buffer.toString('utf8');
console.log('HTTP', response.status, '|', ctype, '|', buffer.length, 'bytes');
if (location) console.log('LOCATION:', location);
console.log('SET-COOKIE names:', setCookies.map(line => line.split('=', 1)[0]).join(', '));
console.log('--- BODY HEAD ---');
console.log(text.slice(0, 2500));
