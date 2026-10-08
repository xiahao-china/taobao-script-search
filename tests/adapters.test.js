import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { TaobaoEngine } from '../src/core/engine.js';
import { resolveSpec } from '../src/adapters/taobao/specs.js';
import { card, product } from './fixtures.js';

let browser, context, engine, events, productPages, searchPage;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser.close(); });
beforeEach(async () => {
  context = await browser.newContext();
  productPages = new Map(); searchPage = null; events = [];
  const session = {
    async getSearchPage() { searchPage ||= await context.newPage(); return searchPage; },
    async getProductPage(id) { if (!productPages.has(id)) productPages.set(id, await context.newPage()); return productPages.get(id); },
    status() { return { connected: true, connections: 1, productTabs: productPages.size }; },
    async close() { await context.close(); },
  };
  engine = new TaobaoEngine({ timeoutMs: 2000, cacheTtlMs: 0 }, event => events.push(event), session);
});
afterEach(async () => { await context.close(); });

test('search returns real cards, split decimal strings, and ignores lookalike hosts/hidden duplicates', async () => {
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="content_items_wrapper"><div>${card()}<span class="shopNameText--test">测试店铺</span></div></div>${card()}<a style="display:none" href="https://item.taobao.com/item.htm?id=222" title="隐藏">¥2</a><a href="https://item.taobao.com.evil.example/item.htm?id=333" title="伪造">¥3</a>` }));
  const result = await engine.execute('search', { keyword: '键盘 & 螺丝', options: { limit: 1 } });
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].itemId, '1001');
  assert.equal(result.data.items[0].priceSummary.amount, '79.98');
  assert.equal(result.data.keyword, '键盘 & 螺丝');
});

test('search waits for data instead of a fixed delay', async () => {
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(card())}), 80)</script>` }));
  const result = await engine.execute('search', { keyword: '延迟数据', options: { limit: 1 } });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].title, '测试商品');
});

test('unknown markup fails; an explicit empty result succeeds', async () => {
  engine.options.timeoutMs = 180;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('empty') ? '<p>没有找到相关商品</p>' : '<p>未知结构</p>' }));
  const unknown = await engine.execute('search', { keyword: 'unknown' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'DATA_TIMEOUT');
  const empty = await engine.execute('search', { keyword: 'empty' });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.data.items, []);
});

test('login waiting outlives data timeout and restores the original keyword/page', async () => {
  engine.options.timeoutMs = 220;
  const visits = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url()); visits.push(url.href);
    const body = url.hostname === 'www.taobao.com' ? '已完成登录' : visits.length === 1 ? `<p>扫码登录</p><script>setTimeout(()=>location.href='https://www.taobao.com/', 400)</script>` : card();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const result = await engine.execute('search', { keyword: '原始关键词', options: { limit: 1, page: 2 } });
  assert.equal(result.ok, true);
  assert.ok(result.meta.manualWaitMs >= 300);
  assert.equal(new URL(visits.at(-1)).searchParams.get('q'), '原始关键词');
  assert.equal(new URL(visits.at(-1)).searchParams.get('page'), '2');
  assert.ok(events.some(event => event.state === 'needs_login'));
});

test('no-wait and separate manual timeout give explicit authentication errors', async () => {
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>扫码登录</p>' }));
  engine.options.waitForLogin = false;
  let result = await engine.execute('search', { keyword: '登录' });
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  engine.options.waitForLogin = true; engine.options.manualTimeoutMs = 120;
  result = await engine.execute('search', { keyword: '登录' });
  assert.equal(result.error.code, 'AUTH_REQUIRED');
});

test('a baxia slider dialog pauses navigation instead of fighting the wall', async () => {
  // Regression for "every verification popup made the tab jump around": the
  // wall copy says 推动 (not 拖动) and baxia dialogs change neither the URL nor
  // the title, so the text heuristics missed it and the search kept navigating.
  engine.options.timeoutMs = 400; engine.options.manualTimeoutMs = 8000;
  const searchVisits = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 's.taobao.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: card() });
    searchVisits.push(url.href);
    // First hit serves the wall; it clears itself after 600 ms and the very
    // same document then holds results — no redirect, exactly like baxia.
    const wall = searchVisits.length === 1;
    const script = wall
      ? `<div id="baxia-dialog-content" class="dialog"><p>亲，请推动下方滑块完成验证</p></div><script>setTimeout(()=>{document.getElementById('baxia-dialog-content').remove();document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(card())});}, 600)</script>`
      : card();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: script });
  });
  const result = await engine.execute('search', { keyword: '滑块', options: { limit: 1 } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.meta.manualWaitMs >= 500, `expected a manual wait for the slider, got ${result.meta.manualWaitMs}ms`);
  // The wall cleared in-place, so there must be exactly one search navigation —
  // a second goto during the sensitive window is the bug.
  assert.equal(searchVisits.length, 1);
  assert.ok(events.some(event => event.state === 'needs_verification'));
});

test('a cross-origin punish iframe pauses the search instead of navigating', async () => {
  // Regression for the sufei punish wall: it arrives as a cross-origin iframe
  // (h5api.m.taobao.com `_____tmd_____/punish`), here nested inside a holder
  // frame the in-page detector never scans. The Playwright-level frame scan
  // must catch it and wait — never navigate while the wall is up.
  engine.options.timeoutMs = 500; engine.options.manualTimeoutMs = 8000;
  const searchVisits = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'h5api.m.taobao.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="baxia-punish"><p>亲，请拖动下方滑块完成验证</p></div>' });
    if (url.hostname === 'holder.taobao.com') {
      // The user solves the slider after ~2.4 s: the punish iframe goes away.
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<iframe src="https://h5api.m.taobao.com/_____tmd_____/punish?action=captcha"></iframe><script>setTimeout(()=>document.querySelector("iframe").remove(),2400)</script>' });
    }
    searchVisits.push(url.href);
    const walled = searchVisits.length === 1;
    const script = walled
      ? `<iframe src="https://holder.taobao.com/holder.html"></iframe><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(card())}), 2200)</script>`
      : card();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: script });
  });
  const result = await engine.execute('search', { keyword: 'punish', options: { limit: 1 } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.meta.manualWaitMs >= 500, `expected a manual wait for the punish iframe, got ${result.meta.manualWaitMs}ms`);
  assert.equal(searchVisits.length, 1);
  assert.ok(events.some(event => event.state === 'needs_verification'));
});

test('specs then several variant quotes use one product navigation and wait for delayed prices', async () => {
  let navigations = 0;
  await context.route('**/*', route => { navigations++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: product() }); });
  const specs = await engine.execute('getSpecs', { itemId: '1001' });
  assert.equal(specs.ok, true);
  assert.equal(specs.data.variants.length, 2);
  const quoteB = await engine.execute('getDetail', { itemId: '1001', spec: { specId: specs.data.variants[1].specId } });
  assert.equal(quoteB.ok, true, JSON.stringify(quoteB.error));
  assert.equal(quoteB.data.price.amount, '4.08');
  assert.deepEqual(quoteB.data.selectedLabels, ['B(200个)']);
  const quoteA = await engine.execute('getDetail', { itemId: '1001', spec: { specId: specs.data.variants[0].specId } });
  assert.equal(quoteA.data.price.amount, '9.00');
  assert.equal(navigations, 1);
  assert.equal(productPages.size, 1);
});

test('same-priced variants use their actual SKU map, not aggregate sku 0', async () => {
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: product({ native: true, samePrice: true }) }));
  const specs = await engine.execute('getSpecs', { itemId: '1001' });
  assert.equal(specs.data.variants[1].skuId, '102');
  const result = await engine.execute('getDetail', { itemId: '1001', spec: { skuId: '102' } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.price.amount, '9.00');
  assert.equal(result.data.stock, 50);
  assert.equal(result.meta.priceEvidence, 'sku-id-map');
});

test('unconfirmed same-price DOM switches fail instead of reporting stale price', async () => {
  engine.options.timeoutMs = 250;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: product({ samePrice: true }) }));
  const result = await engine.execute('getDetail', { itemId: '1001', spec: { labels: ['B(200个)'] } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SKU_PRICE_UNCONFIRMED');
});

test('login during variant selection resumes the same variant on the same product page', async () => {
  engine.options.timeoutMs = 450;
  let loaded = 0;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const body = url.hostname === 'login.taobao.com' ? `<p>扫码登录</p><script>setTimeout(()=>location.href='https://www.taobao.com/', 700)</script>` : url.hostname === 'www.taobao.com' ? '已登录' : product({ authOnClick: loaded++ === 0 });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const result = await engine.execute('getDetail', { itemId: '1001', spec: { labels: ['B(200个)'] } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.price.amount, '4.08');
  assert.equal(result.data.specLabel, 'B(200个)');
  assert.ok(result.meta.manualWaitMs >= 500);
  assert.equal(productPages.size, 1);
});

test('native multi-property catalogs reject nonexistent combinations', () => {
  const specs = { itemId: '1001', mode: 'variants', groups: [
    { groupId: '1', index: 0, values: [{ valueId: 'a', index: 0, label: '红', available: true }, { valueId: 'b', index: 1, label: '蓝', available: true }] },
    { groupId: '2', index: 1, values: [{ valueId: 'x', index: 0, label: '短', available: true }, { valueId: 'y', index: 1, label: '长', available: true }] },
  ], variants: [{ specId: 'sku:111', skuId: '111', selections: [{ groupId: '1', valueId: 'a' }, { groupId: '2', valueId: 'x' }] }] };
  assert.throws(() => resolveSpec(specs, { selections: [{ groupId: '1', valueId: 'b' }, { groupId: '2', valueId: 'y' }] }), { code: 'SKU_NOT_FOUND' });
  assert.throws(() => resolveSpec(specs, { specId: 'sku:111', skuId: '222' }), { code: 'INVALID_ARGUMENT' });
});

test('expired product snapshots refresh before quoting instead of extending old prices', async () => {
  let loaded = 0;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: loaded++ ? product({ native: true }).replaceAll('4.08', '5.50') : product({ native: true }) }));
  await engine.execute('getSpecs', { itemId: '1001' });
  engine.detailAdapter.states.get(productPages.get('1001')).openedAt = Date.now() - 61000;
  const quote = await engine.execute('getDetail', { itemId: '1001', spec: { skuId: '102' } });
  assert.equal(quote.ok, true, JSON.stringify(quote.error));
  assert.equal(quote.data.price.amount, '5.50');
  assert.equal(loaded, 2);
});

test('batch groups interleaved products while preserving result order and refreshing once', async () => {
  const visits = [];
  await context.route('**/*', route => { visits.push(new URL(route.request().url()).searchParams.get('id')); return route.fulfill({ contentType: 'text/html; charset=utf-8', body: product({ native: true }) }); });
  const result = await engine.execute('batch', { tasks: [
    { operation: 'getDetail', params: { itemId: '1001', spec: { labels: ['B(200个)'] }, options: { forceRefresh: true } } },
    { operation: 'getSpecs', params: { itemId: '1002' } },
    { operation: 'getDetail', params: { itemId: '1001', spec: { labels: ['A(100个)'] }, options: { forceRefresh: true } } },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result.data.results.map(value => value.error)));
  assert.deepEqual(result.data.results.map(value => value.data.itemId), ['1001', '1002', '1001']);
  assert.deepEqual(visits, ['1001', '1002']);
});
