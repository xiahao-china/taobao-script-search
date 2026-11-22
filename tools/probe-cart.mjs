import { writeFileSync } from 'node:fs';
import { MtopClient } from '../build/core/mtop-client.js';
const client = new MtopClient({ runtimeDir: null });
const payload = await client.request('mtop.trade.query.bag', '5.0', {
  isPage: true, extStatus: 0, netType: 0,
  exParams: JSON.stringify({ mergeCombo: true, version: '1.1.1', globalSell: 1 }),
}, {
  extraParams: { ecode: '1', AntiCreep: 'true', AntiFlood: 'true', LoginRequest: 'true', ttid: '##h5' },
  referer: 'https://main.m.taobao.com/cart/index.html',
});
writeFileSync('.runtime/probe-cart-full.json', JSON.stringify(payload, null, 1));
// 结构盘点
const comps = payload.data ?? {};
const byTag = {};
for (const [key, value] of Object.entries(comps)) {
  const tag = value?.tag ?? '(none)';
  (byTag[tag] ??= []).push(key);
}
console.log('TAGS:', JSON.stringify(Object.fromEntries(Object.entries(byTag).map(([k, v]) => [k, v.length]))));
for (const [key, value] of Object.entries(comps)) {
  if (value?.tag === 'shop') console.log('SHOP COMP', key, JSON.stringify(value.fields).slice(0, 400));
  if (value?.tag && value.tag.startsWith('invalid')) console.log('INVALID', key, JSON.stringify(value.fields).slice(0, 200));
  if (value?.tag === 'global' || /header|count|title/i.test(String(value?.tag))) console.log('OTHER', value.tag, key, JSON.stringify(value.fields).slice(0, 300));
}
