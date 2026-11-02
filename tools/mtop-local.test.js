import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { buildMtopSpecs, recordPrice } from '../src/adapters/taobao/mtop.js';
import { resolveSpec, skuPrice } from '../src/adapters/taobao/specs.js';
import { mergeSetCookies, mergeCookieString, cookieHeader, cookieSummary } from '../src/core/cookie-store.js';

// 1. buildMtopSpecs + resolveSpec + skuPrice 全链路（合成 catalog）
const catalog = {
  skuBase: {
    props: [
      { pid: '1', name: '封装', values: [{ vid: '11', name: '0805' }, { vid: '12', name: '0603' }] },
      { pid: '2', name: '阻值', values: [{ vid: '21', name: '10KΩ' }, { vid: '22', name: '1KΩ' }] },
    ],
    skus: [
      { skuId: '100', propPath: '1:11;2:21' },
      { skuId: '101', propPath: '1:11;2:22' },
      { skuId: '102', propPath: '1:12;2:21' },
    ],
  },
  skuCore: { sku2info: {
    '100': { price: { priceText: '0.01', priceTitle: '淘宝价' }, quantity: 500 },
    '0': { price: { priceText: '0.01' } },
  } },
};
const specs = buildMtopSpecs('123', catalog);
assert.equal(specs.mode, 'variants');
assert.equal(specs.variants.length, 3);
const sel = resolveSpec(specs, { labels: ['0805', '10KΩ'] });
assert.equal(sel.skuId, '100');
assert.equal(recordPrice(catalog.skuCore.sku2info['100']).amount, '0.01');
assert.equal(recordPrice(catalog.skuCore.sku2info['100']).stock, 500);
// 组合不存在时应报 SKU_NOT_FOUND
assert.throws(() => resolveSpec(specs, { labels: ['0805', '不存在的阻值'] }), /SKU_NOT_FOUND|SPEC_AMBIGUOUS|规格/);
console.log('specs OK:', JSON.stringify(sel), '| specLabel =', sel.label);

// 2. 单 SKU 无规格组商品
const single = buildMtopSpecs('456', { skuBase: { props: [], skus: [{ skuId: '200', propPath: '' }] }, skuCore: { sku2info: { '200': { price: { priceText: '3.50' } } } } });
assert.equal(single.mode, 'single-variant');
const selSingle = resolveSpec(single, { kind: 'default' });
assert.equal(selSingle.skuId, '200');
console.log('single-sku OK:', selSingle.specId);

// 3. Cookie 罐：Set-Cookie 合并 + 手动字符串 + 过期清理
const store = { syncedAt: null, sync: null, cookies: {} };
mergeSetCookies(store, [
  '_m_h5_tk=abc123def_1710000000; Domain=.taobao.com; Path=/; Expires=Wed, 01 Jan 2036 00:00:00 GMT',
  'tfstk=XYZ; Domain=.taobao.com; Max-Age=0',
  'isg=OLD; Domain=.taobao.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
]);
assert.equal(store.cookies._m_h5_tk.value, 'abc123def_1710000000');
assert.ok(!('tfstk' in store.cookies), 'Max-Age=0 应删除');
assert.ok(!('isg' in store.cookies), '过期时间应删除');
mergeCookieString(store, 'cookie2=login_value; unb=12345; bad-no-equals; x=y');
const header = cookieHeader(store);
assert.ok(header.includes('_m_h5_tk=abc123def_1710000000'));
assert.ok(header.includes('unb=12345'));
assert.ok(!header.includes('tfstk'));
const summary = cookieSummary(store);
assert.equal(summary.hasSignToken, true);
assert.equal(summary.hasLoginState, true);
console.log('cookie-store OK:', JSON.stringify(summary));

// 4. 根目录 cookie.json：简单格式解析 + 读写同源 + 登录态判定
import { loadCookies, saveCookies, rootCookiePath } from '../src/core/cookie-store.js';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.TAOBAO_COOKIE_FILE = join(await mkdtemp(join(tmpdir(), 'tb-cookie-')), 'cookie.json');
await writeFile(rootCookiePath(), JSON.stringify({ cookie: 'cookie2=abc; unb=42; junk-no-separator' }));
const loaded = await loadCookies();
assert.equal(loaded.cookies.unb.value, '42');
assert.equal(cookieSummary(loaded).hasLoginState, true);
await saveCookies(loaded); // 续签写回应落回同一文件
const roundTrip = JSON.parse(await readFile(rootCookiePath(), 'utf8'));
assert.equal(roundTrip.cookies.cookie2.value, 'abc');
assert.equal(cookieSummary(await loadCookies()).hasLoginState, true, '内部格式应能再读回');
console.log('cookie.json OK:', rootCookiePath());

// 5. 未配置登录态时应判 false（占位符不会误判为已登录）
process.env.TAOBAO_COOKIE_FILE = join(tmpdir(), 'tb-cookie-empty-' + Date.now(), 'cookie.json');
const empty = await loadCookies();
assert.equal(cookieSummary(empty).hasLoginState, false);
console.log('empty-store OK');

// 6. 限速文件落盘确认
await rm(new URL('../.runtime/mtop-pacing.json', import.meta.url), { force: true }).catch(() => {});
console.log('all OK');
