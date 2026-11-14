// 一次性探针：购物车删除（mtop.trade.update.bag 4.0，写操作）。
// 参照：H5 购物车官方 bundle g.alicdn.com/dinamic/h5-tb-cart/5.0.66/index.min.js
// ——updateBag 调用链：operatorEvent="deleteClick."+type、payload={operator,data,hierarchy}、
// 删除前合并 operateItems=[keyname] 进组件 fields。
// 阶段 1（--dump，只读）：拉 query.bag 原始组件树存盘，打印 item 组件的
//   keyname/type/events.deleteClick/hierarchy 结构，供构造删除 payload 参考。
// 阶段 2（--do <cartId>）：真实删除。默认只做 dump。
import { writeFile, mkdir } from 'node:fs/promises';
import { MtopClient } from '../src/core/mtop-client.js';

const CART_REQUEST = {
  extraParams: { ecode: '1', AntiCreep: 'true', AntiFlood: 'true', LoginRequest: 'true', ttid: '##h5' },
  referer: 'https://main.m.taobao.com/cart/index.html',
};
const QUERY_DATA = {
  isPage: true, extStatus: 0, netType: 0,
  exParams: JSON.stringify({ mergeCombo: true, version: '1.1.1', globalSell: 1 }),
};

const client = new MtopClient({ runtimeDir: null });
const payload = await client.request('mtop.trade.query.bag', '5.0', QUERY_DATA, CART_REQUEST);
const components = payload?.data ?? {};

await mkdir('.runtime/artifacts', { recursive: true });
await writeFile('.runtime/artifacts/query-bag-raw.json', JSON.stringify(payload, null, 2));

const items = Object.entries(components).filter(([, c]) => c?.tag === 'item');
console.log('item components:', items.length);
for (const [key, c] of items) {
  const f = c.fields ?? {};
  console.log('---', key, '| itemId:', f.itemId, '| cartId:', f.cartId, '| type:', c.type, '| bundleId:', c.bundleId);
  console.log('    events:', Object.keys(c.events ?? {}).join(', ') || '(none)');
  console.log('    events.deleteClick:', JSON.stringify(c.events?.deleteClick ?? null)?.slice(0, 600));
}
const hierarchy = payload?.hierarchy ?? components?.hierarchy;
console.log('--- hierarchy structure keys:', Object.keys(hierarchy?.structure ?? {}).length);
if (process.argv[2] === '--dump') {
  console.log('dump saved: .runtime/artifacts/query-bag-raw.json');
  process.exit(0);
}

// ── 阶段 2：真实删除 ──
const CART_ID = process.argv[3] || process.argv[2]?.replace(/^--do/, '') || '';
if (!/^\d+$/.test(CART_ID)) { console.log('用法: node tools/probe-remove-cart.mjs --do <cartId>'); process.exit(1); }
const keyname = `item_${CART_ID}`;
const trigger = components[keyname];
if (!trigger || trigger.tag !== 'item') { console.log('CART_ID 不在当前购物车:', keyname); process.exit(1); }
if (!payload?.linkage?.signature) { console.log('payload 缺 linkage.signature，协议可能已变化'); process.exit(1); }

// 官方 bundle 的 deleteClick 链路：合并 operateItems 进触发组件的 events.deleteClick[0].fields，
// data = linkage.input 组件 + 触发组件，hierarchy 原样回传，linkage 只带 common 三字段 + signature。
const mutated = JSON.parse(JSON.stringify(trigger));
const delEvent = mutated.events?.deleteClick?.[0];
if (!delEvent || delEvent.type !== 'cartAdjustOperate') { console.log('触发组件缺 cartAdjustOperate deleteClick 事件'); process.exit(1); }
delEvent.fields.operateItems = [keyname];
const c = payload.linkage.common ?? {};
// bundle 中 operatorEvent = "deleteClick." + e.type，e 是触发组件的事件配置对象，
// 其 type 恒为 "cartAdjustOperate"（item 行与 submit 栏的 deleteClick 事件同型）。
const updateEvent = `deleteClick.${delEvent.type}`;
// 官方 requestAdaptor：payload 顶层对象值各自 stringify 成字符串后，
// 整体再包一层 { params: "<json>" } —— mtop data 参数是双层嵌套 JSON。
const inner = {
  operatorEvent: updateEvent,
  operator: keyname,
  data: JSON.stringify({
    ...Object.fromEntries((payload.linkage.input ?? []).map(k => [k, components[k]]).filter(([, v]) => v)),
    [keyname]: mutated,
  }),
  hierarchy: JSON.stringify({ structure: hierarchy?.structure ?? {} }),
  linkage: JSON.stringify({
    common: { queryParams: c.queryParams, compress: c.compress, validateParams: c.validateParams },
    signature: payload.linkage.signature,
  }),
};
const updateData = { params: JSON.stringify(inner) };
console.log('--- 发送 update.bag 4.0 删除', keyname, '(itemId:', trigger.fields.itemId, ')');
const updated = await client.request('mtop.trade.update.bag', '4.0', updateData, {
  ...CART_REQUEST,
  method: 'POST',
});
console.log('update.bag ret OK，响应顶层键:', Object.keys(updated ?? {}));
const newComponents = updated?.data ?? {};
const stillThere = Object.keys(newComponents).includes(keyname) && newComponents[keyname]?.tag === 'item';
console.log('删除后组件树中仍含', keyname, ':', stillThere);
console.log('删除后 item 组件数:', Object.values(newComponents).filter(x => x?.tag === 'item').length);
await writeFile('.runtime/artifacts/update-bag-resp.json', JSON.stringify(updated, null, 2));
console.log('probe done');
