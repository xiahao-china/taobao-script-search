import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMtopSpecs, recordPrice } from '../src/adapters/taobao/mtop.js';
import { resolveSpec, skuPrice } from '../src/adapters/taobao/specs.js';
import { mergeSetCookies, mergeCookieString, cookieHeader, cookieSummary, loadCookies, saveCookies, rootCookiePath } from '../src/core/cookie-store.js';

// ── 1. buildMtopSpecs + resolveSpec + skuPrice 全链路（合成 catalog）
test('specs: 组合规格解析与核价', () => {
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
});

// ── 2. 单 SKU 无规格组商品
test('specs: 单 SKU 默认规格', () => {
  const single = buildMtopSpecs('456', { skuBase: { props: [], skus: [{ skuId: '200', propPath: '' }] }, skuCore: { sku2info: { '200': { price: { priceText: '3.50' } } } } });
  assert.equal(single.mode, 'single-variant');
  const selSingle = resolveSpec(single, { kind: 'default' });
  assert.equal(selSingle.skuId, '200');
});

// ── 3. Cookie 罐：Set-Cookie 合并 + 手动字符串 + 过期清理
test('cookie-store: Set-Cookie 合并与过期清理', () => {
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
});

// ── 4. 主配置 + 运行时缓存分层：cookie.json 只读，令牌续签走 .runtime
const tempDirs = [];
function isolate(dir) {
  tempDirs.push(dir);
  process.env.TAOBAO_COOKIE_FILE = join(dir, 'cookie.json');
  process.env.TAOBAO_SEARCH_RUNTIME_DIR = join(dir, '.runtime');
}
after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
  delete process.env.TAOBAO_COOKIE_FILE;
  delete process.env.TAOBAO_SEARCH_RUNTIME_DIR;
});

test('cookie.json: 简单格式解析、登录态判定、程序不覆写主配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-cookie-'));
  isolate(dir);
  const original = JSON.stringify({ _说明: '用户配置', cookie: 'cookie2=abc; unb=42' });
  await writeFile(join(dir, 'cookie.json'), original);

  const loaded = await loadCookies();
  assert.equal(loaded.cookies.unb.value, '42');
  assert.equal(cookieSummary(loaded).hasLoginState, true);

  // 程序写入（模拟令牌续签）必须落到 .runtime 缓存，主配置原样保留。
  await saveCookies(loaded);
  assert.equal(await readFile(join(dir, 'cookie.json'), 'utf8'), original, '主配置不得被程序覆写');
  const cache = JSON.parse(await readFile(join(dir, '.runtime', 'mtop-cookies.json'), 'utf8'));
  assert.equal(cache.cookies.cookie2.value, 'abc');

  // 再加载：主配置为基准 + 令牌键用缓存覆盖。
  const reloaded = await loadCookies();
  assert.equal(reloaded.cookies.cookie2.value, 'abc');
  assert.equal(cookieSummary(reloaded).hasLoginState, true);
});

test('cookie.json: 令牌续签覆盖主配置中的过期令牌', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-token-'));
  isolate(dir);
  await mkdir(join(dir, '.runtime'), { recursive: true });
  await writeFile(join(dir, 'cookie.json'), JSON.stringify({ cookie: 'unb=7; _m_h5_tk=old_1' }));
  await writeFile(join(dir, '.runtime', 'mtop-cookies.json'), JSON.stringify({ cookies: { _m_h5_tk: { value: 'fresh_2', domain: '.taobao.com', expires: -1 } } }));
  const store = await loadCookies();
  assert.equal(store.cookies._m_h5_tk.value, 'fresh_2', '令牌应以运行时缓存的新值为准');
  assert.equal(store.cookies.unb.value, '7', '登录态仍以主配置为准');
});

test('cookie store: 无主配置时回退 .runtime 缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tb-fallback-'));
  isolate(dir); // cookie.json 不存在 → 回退 .runtime（此刻也为空）
  const empty = await loadCookies();
  assert.equal(cookieSummary(empty).hasLoginState, false);
});
