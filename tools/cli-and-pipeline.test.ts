import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MtopAdapter } from '../src/adapters/taobao/mtop.js';
import { ShopSearchAdapter } from '../src/adapters/taobao/shop-search.js';
import { MtopClient, reserveSlot } from '../src/core/mtop-client.js';
import { saveCookies } from '../src/core/cookie-store.js';
import { TaobaoError, getErrorCode } from '../src/core/errors.js';
import type { FetchLike, MtopClientLike, ResponseLike } from '../src/types.js';

const BIN_PATH = resolve('bin/taobao.js');
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
  delete process.env.TAOBAO_COOKIE_FILE;
  delete process.env.TAOBAO_SEARCH_RUNTIME_DIR;
});

function mockResponse(
  body: unknown,
  { status = 200, setCookies = [], headers = {} }: { status?: number; setCookies?: string[]; headers?: Record<string, string> } = {},
): ResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name: string) => lower[name.toLowerCase()] ?? null,
    },
    text: async () => text,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function stubClient(script: Array<Record<string, unknown> | Error>): MtopClientLike & { calls: Array<{ api: string; version: string; data: Record<string, unknown>; method?: string }> } {
  const calls: Array<{ api: string; version: string; data: Record<string, unknown>; method?: string }> = [];
  return {
    calls,
    request: async (api, version, data, options = {}) => {
      calls.push({ api, version, data, method: options.method });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
}

function runCli(args: string[], { env = {}, stdin }: { env?: Record<string, string>; stdin?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ── 1. MtopClient POST 通道、签名校验、AUTH/MTOP 错误分类 ──
test('MtopClient: POST 通道走 form body 且 MD5 签名正确，AUTH/MTOP 错误分类准确', async () => {
  const base = await makeTempDir('tb-post-');
  process.env.TAOBAO_COOKIE_FILE = join(base, 'cookie.json');
  const runtimeDir = join(base, '.runtime');
  await writeFile(join(base, 'cookie.json'), JSON.stringify({
    cookie: 'unb=100; cookie2=ok; cna=cna100; _m_h5_tk=mysecretprefix_1799999999000; _m_h5_tk_enc=enc1',
  }));
  const seen: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string | null }> = [];
  const mockFetch: FetchLike = async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (seen.length === 1) return mockResponse({ ret: ['SUCCESS::调用成功'], data: { updated: true } });
    if (seen.length === 2) return mockResponse({ ret: ['FAIL_SYS_SESSION_EXPIRED::会话过期'] });
    return mockResponse({ ret: ['S-BIZ-ERR::业务繁忙'] });
  };
  const client = new MtopClient({ runtimeDir, minIntervalMs: 0, jitterMs: 0, fetch: mockFetch });
  const res = await client.request('mtop.trade.update.bag', '4.0', { params: '{"x":1}' }, { method: 'POST', referer: 'https://main.m.taobao.com/cart/index.html' });
  assert.deepEqual(res, { updated: true });
  const first = seen[0]!;
  assert.equal(first.method, 'POST');
  assert.equal(new URL(first.url).search, '', 'POST 参数应在 body 而非 URL query');
  assert.equal(first.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(first.headers?.Origin, 'https://main.m.taobao.com');
  const form = new URLSearchParams(first.body ?? '');
  const expectedSign = createHash('md5')
    .update(`mysecretprefix&${form.get('t')}&12574478&${form.get('data')}`)
    .digest('hex');
  assert.equal(form.get('sign'), expectedSign, 'POST 通道签名必须与 MD5(token&t&appKey&data) 逐字节一致');

  await assert.rejects(
    client.request('mtop.trade.query.bag', '5.0', {}),
    error => getErrorCode(error) === 'AUTH_REQUIRED',
  );
  await assert.rejects(
    client.request('mtop.trade.query.bag', '5.0', {}),
    error => getErrorCode(error) === 'MTOP_ERROR',
  );
});

// ── 2. reserveSlot 并发竞争收敛 ──
test('reserveSlot: 并发调用自动串行排坑，不撞车放行', async () => {
  const base = await makeTempDir('tb-pace-');
  const runtimeDir = join(base, '.runtime');
  const doneAt: number[] = [];
  await Promise.all([
    reserveSlot(runtimeDir, 90, 0).then(() => doneAt.push(Date.now())),
    reserveSlot(runtimeDir, 90, 0).then(() => doneAt.push(Date.now())),
  ]);
  doneAt.sort((a, b) => a - b);
  assert.equal(doneAt.length, 2);
  assert.ok(doneAt[1]! - doneAt[0]! >= 65, `两次并发占坑间隔应 >= 65ms，实测 ${doneAt[1]! - doneAt[0]!}ms`);
});

// ── 3. getDetail 全链路：规格核价、店铺信誉 + 粉丝数增强、错误边界 ──
test('getDetail: 正常核价 + store/fansNum 合并 + 粉丝接口降级与风控上抛', async () => {
  const base = await makeTempDir('tb-detail-');
  const runtimeDir = join(base, '.runtime');
  const pcdetailPayload = {
    item: { itemId: '8001', title: '<b>精密电阻包</b>', images: ['https://img.alicdn.com/a.jpg'] },
    seller: {
      sellerId: 1001, shopId: 2002, sellerType: 'B', shopName: '华芯旗舰店',
      shopUrl: 'https://shop2002.taobao.com/',
      evaluates: [{ type: 'desc', title: '宝贝描述', score: '4.9', levelText: '高' }],
    },
    componentsVO: {
      storeCardVO: {
        sellerType: 'B', overallScore: '4.9', creditLevel: '15',
        evaluates: [{ title: '宝贝质量', score: '4.9' }],
        labelList: [{ contentDesc: '24小时发货' }],
      },
    },
    skuBase: {
      props: [{ pid: '1', name: '阻值', values: [{ vid: '10', name: '10K' }, { vid: '20', name: '100K' }] }],
      skus: [{ skuId: '501', propPath: '1:10' }, { skuId: '502', propPath: '1:20' }],
    },
    skuCore: {
      sku2info: {
        '0': { price: { priceText: '1.00' }, quantity: 999 },
        '501': { price: { priceText: '12.50' }, quantity: 42 },
        // 502 刻意缺失价格，用于验证绝不回退默认价 1.00
      },
    },
  };

  // 3a) 正常核价 + 粉丝数串联
  const c1 = stubClient([
    pcdetailPayload,
    { result: { fansNum: 58000, ifHideFansNum: false, goldenSeller: true } },
  ]);
  const a1 = new MtopAdapter({ client: c1, runtimeDir });
  const d1 = await a1.getDetail('8001', { labels: ['10K'] });
  assert.equal(d1.data.title, '精密电阻包');
  assert.equal(d1.data.price.amount, '12.50');
  assert.equal(d1.data.price.scope, 'selected-spec');
  assert.equal(d1.data.stock, 42);
  assert.equal(d1.data.store?.isTmall, true);
  assert.equal(d1.data.store?.fansNum, 58000);
  assert.equal(d1.data.store?.goldenSeller, true);
  assert.deepEqual(d1.data.shop, { sellerId: '1001', shopId: '2002', shopUrl: 'https://shop2002.taobao.com/' });
  assert.equal(d1.meta.coverage?.store, true);

  // 3b) 粉丝接口非致命失败 → 静默降级，detail 照常返回
  const c2 = stubClient([pcdetailPayload, new TaobaoError('MTOP_ERROR', '临时失败')]);
  const a2 = new MtopAdapter({ client: c2, runtimeDir });
  const d2 = await a2.getDetail('8001', { skuId: '501' });
  assert.equal(d2.data.price.amount, '12.50');
  assert.equal(d2.data.store?.fansNum, undefined);

  // 3c) 粉丝接口遇 RISK_CONTROL → 直接上抛
  const c3 = stubClient([pcdetailPayload, new TaobaoError('RISK_CONTROL', '风控')]);
  const a3 = new MtopAdapter({ client: c3, runtimeDir });
  await assert.rejects(a3.getDetail('8001', { skuId: '501' }), error => getErrorCode(error) === 'RISK_CONTROL');

  // 3d) 指定 SKU 缺失价格 → SKU_PRICE_UNCONFIRMED（绝不回退默认价 1.00）
  const c4 = stubClient([pcdetailPayload, { result: {} }]);
  const a4 = new MtopAdapter({ client: c4, runtimeDir });
  await assert.rejects(a4.getDetail('8001', { skuId: '502' }), error => getErrorCode(error) === 'SKU_PRICE_UNCONFIRMED');

  // 3e) 双详情接口皆无数据 → ITEM_UNAVAILABLE
  const c5 = stubClient([{ empty: true }, { empty: true }]);
  const a5 = new MtopAdapter({ client: c5, runtimeDir });
  await assert.rejects(a5.getDetail('8001', { kind: 'default' }), error => getErrorCode(error) === 'ITEM_UNAVAILABLE');
});

// ── 4. getReviewSummary 评价计数 ──
test('getReviewSummary: 解析评价计数、模糊总数与默认好评占比边界', async () => {
  const base = await makeTempDir('tb-rate-');
  const runtimeDir = join(base, '.runtime');
  const client = stubClient([
    { total: '2000', totalFuzzy: '5000+', foldCount: '350' },
    { total: '0', fuzzyRateCount: '', foldCount: '0' },
  ]);
  const adapter = new MtopAdapter({ client, runtimeDir });
  const r1 = await adapter.getReviewSummary('8001');
  assert.equal(r1.data.total, 2000);
  assert.equal(r1.data.totalFuzzy, '5000+');
  assert.equal(r1.data.foldedDefault, 350);
  assert.equal(r1.data.foldedRatio, '18%');
  assert.equal(r1.meta.provider, 'mtop-http-rate');

  const r2 = await adapter.getReviewSummary('8002');
  assert.equal(r2.data.total, 0);
  assert.equal(r2.data.totalFuzzy, null);
  assert.equal(r2.data.foldedRatio, null, 'total=0 时不得产出 NaN/Infinity');
});

// ── 5. removeFromCart 完整 3 步闭环 ──
test('removeFromCart: 拉树 → POST update.bag → 回读核对，覆盖成功/未消失/不存在', async () => {
  const base = await makeTempDir('tb-rmcart-');
  const runtimeDir = join(base, '.runtime');
  const bagWithItem = () => ({
    data: {
      item_901: {
        tag: 'item', type: 'dinamicx$cartitem', id: 'item_901',
        fields: { itemId: '777888', cartId: '901', title: '贴片电容' },
        events: { deleteClick: [{ tag: 'cartAdjustOperate', type: 'cartAdjustOperate', fields: { operateItems: [] } }] },
      },
      global_1: { tag: 'global', id: 'global_1', fields: {} },
    },
    hierarchy: { structure: { global_1: ['item_901'] } },
    linkage: { input: ['global_1'], common: { queryParams: 'q', compress: true, validateParams: 'v' }, signature: 'sig-ok' },
  });
  const emptyBag = { data: { header_1: { tag: 'header', fields: { title: '购物车' } } } };

  // 5a) 正常删除并确认消失
  const c1 = stubClient([bagWithItem(), { reload: true }, emptyBag]);
  const a1 = new MtopAdapter({ client: c1, runtimeDir });
  const r1 = await a1.removeFromCart('901');
  assert.equal(r1.data.removed, true);
  assert.equal(r1.data.entryGone, true);
  assert.equal(r1.data.remainingCount, 0);
  assert.equal(r1.data.itemId, '777888');
  assert.equal(r1.meta.verification, 'query-bag-confirmed');
  assert.deepEqual(c1.calls.map(c => `${c.api}:${c.method ?? 'GET'}`), [
    'mtop.trade.query.bag:GET',
    'mtop.trade.update.bag:POST',
    'mtop.trade.query.bag:GET',
  ]);

  // 5b) 回读条目仍在 → entryGone=false + note
  const c2 = stubClient([bagWithItem(), { reload: true }, bagWithItem()]);
  const a2 = new MtopAdapter({ client: c2, runtimeDir });
  const r2 = await a2.removeFromCart('901');
  assert.equal(r2.data.entryGone, false);
  assert.equal(r2.meta.verification, 'entry-still-present');
  assert.ok(r2.meta.note);

  // 5c) 条目不存在 → NO_RESULTS 且不发 update.bag
  const c3 = stubClient([emptyBag]);
  const a3 = new MtopAdapter({ client: c3, runtimeDir });
  await assert.rejects(a3.removeFromCart('999'), error => getErrorCode(error) === 'NO_RESULTS');
  assert.equal(c3.calls.length, 1);
});

// ── 6. addToCart SKU 路径与缺 token / 登录页 / 坏响应 ──
test('addToCart: 带 skuId 匹配回读，覆盖缺 _tb_token_ / 登录页 / 不可解析响应', async () => {
  const base = await makeTempDir('tb-addsku-');
  process.env.TAOBAO_COOKIE_FILE = join(base, 'cookie.json');
  const runtimeDir = join(base, '.runtime');

  // 6a) 缺 _tb_token_ → AUTH_REQUIRED
  await writeFile(join(base, 'cookie.json'), JSON.stringify({ cookie: 'unb=1; cookie2=ok' }));
  const aNoTok = new MtopAdapter({ client: new MtopClient({ runtimeDir, minIntervalMs: 0, jitterMs: 0 }), runtimeDir });
  await assert.rejects(aNoTok.addToCart('555', { skuId: '111' }), error => getErrorCode(error) === 'AUTH_REQUIRED');

  // 6b) 带 skuId 正常加购并匹配回读 + 登录页 + 不可解析
  await writeFile(join(base, 'cookie.json'), JSON.stringify({
    cookie: 'unb=1; cookie2=ok; cna=c1; _m_h5_tk=t_1; _tb_token_=tok123',
  }));
  let step = 0;
  const seenUrls: string[] = [];
  const mockFetch: FetchLike = async url => {
    const href = String(url);
    seenUrls.push(href);
    if (href.includes('add_cart_item.htm')) {
      step += 1;
      if (step === 1) return mockResponse('TB.Detail.CartResult = { "cartQuantity": "3", "cartPrice": "" }');
      if (step === 2) return mockResponse('<html>please login first</html>');
      return mockResponse('<html>unexpected empty page</html>');
    }
    return mockResponse({
      ret: ['SUCCESS::调用成功'],
      data: {
        data: {
          header_1: { id: '1', tag: 'header', fields: { title: '购物车' } },
          item_88: {
            id: '88', tag: 'item', bundleId: 's_1',
            fields: { itemId: '555', cartId: '88', title: '带规格商品', sku: { skuId: '111', title: '黑色' }, quantity: '2', pay: { nowTitle: '￥9.90', total: 990 }, isChecked: 'true', canCheck: true },
          },
        },
      },
    });
  };
  const client = new MtopClient({ runtimeDir, minIntervalMs: 0, jitterMs: 0, fetch: mockFetch });
  const adapter = new MtopAdapter({ client, runtimeDir });
  const res = await adapter.addToCart('555', { skuId: '111', quantity: 2 });
  assert.equal(res.data.entryFound, true);
  assert.equal(res.data.entry?.sku?.skuId, '111');
  assert.ok(seenUrls[0]?.includes('sku_id=111'));

  await assert.rejects(adapter.addToCart('555', { skuId: '111' }), error => getErrorCode(error) === 'AUTH_REQUIRED');
  await assert.rejects(adapter.addToCart('555', { skuId: '111' }), error => getErrorCode(error) === 'CART_ADD_ERROR');
});

// ── 7. ShopSearchAdapter 多页翻页、空页收尾、风控/登录墙/缓存失效清理 ──
test('ShopSearchAdapter: 多页合并、末页提前收尾、风控与 wid 失效清缓存', async () => {
  const base = await makeTempDir('tb-shopflow-');
  process.env.TAOBAO_COOKIE_FILE = join(base, 'cookie.json');
  const runtimeDir = join(base, '.runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(base, 'cookie.json'), JSON.stringify({ cookie: 'unb=1; cookie2=ok' }));

  const makePageHtml = (id: string, pageInfo: string) =>
    `jsonp1(${JSON.stringify(`<span class="page-info">${pageInfo}</span><dl data-id="${id}"><a class="item-name" href="//item.taobao.com/item.htm?id=${id}">商品${id}</a></dl>`)})`;

  // 7a) 连续 2 页合并 + 到末页(2/2)自动停止（请求 pages=5 也不会发第 3 页）
  let asynCalls = 0;
  const multiFetch: FetchLike = async url => {
    const href = String(url);
    if (!href.includes('/i/asynSearch.htm')) {
      return mockResponse('<input value="/i/asynSearch.htm?wid=12345&path=/search.htm"/>');
    }
    asynCalls += 1;
    return mockResponse(asynCalls === 1 ? makePageHtml('10001', '1/2') : makePageHtml('10002', '2/2'));
  };
  const shopAdapter = new ShopSearchAdapter({ runtimeDir, fetch: multiFetch });
  shopAdapter.minIntervalMs = 0;
  shopAdapter.jitterMs = 0;
  const rMulti = await shopAdapter.shopSearch('电阻', '131282813', { page: 1, pages: 5 });
  assert.equal(asynCalls, 2, '到达总页数 2/2 后应立即停止');
  assert.deepEqual(rMulti.data.items.map(i => i.itemId), ['10001', '10002']);
  assert.equal(rMulti.meta.widSource, 'page');

  // 7b) asynSearch 返回 login.htm → 自动清除缓存 wid 并报 SHOP_SEARCH_ERROR
  const loginWallFetch: FetchLike = async url => {
    const href = String(url);
    if (!href.includes('/i/asynSearch.htm')) return mockResponse('<html>no wid</html>');
    return mockResponse('<html><script>location="https://login.taobao.com/login.htm"</script></html>');
  };
  const shopWall = new ShopSearchAdapter({ runtimeDir, fetch: loginWallFetch });
  shopWall.minIntervalMs = 0;
  shopWall.jitterMs = 0;
  await assert.rejects(shopWall.shopSearch('电阻', '131282813'), error => getErrorCode(error) === 'SHOP_SEARCH_ERROR');
  const cacheAfter = JSON.parse(await readFile(join(runtimeDir, 'shop-wid.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(cacheAfter['shop131282813.taobao.com'], undefined, 'wid 校验失败后必须清除旧缓存');

  // 7c) 店铺页命中 TMD 且无缓存 → RISK_CONTROL，请求日志诚实记 ok:false, code:RISK_CONTROL
  const tmdFetch: FetchLike = async () => mockResponse('<html>_____tmd_____</html>');
  const shopTmd = new ShopSearchAdapter({ runtimeDir, fetch: tmdFetch });
  shopTmd.minIntervalMs = 0;
  shopTmd.jitterMs = 0;
  await assert.rejects(shopTmd.shopSearch('电阻', '131282813'), error => getErrorCode(error) === 'RISK_CONTROL');

  // 7d) 刚提取的新 wid (widSource='page') 紧接着被 asynSearch 跳登录墙 → 清缓存并抛 AUTH_REQUIRED
  const freshWidLoginFetch: FetchLike = async url => {
    const href = String(url);
    if (!href.includes('/i/asynSearch.htm')) return mockResponse('<input value="/i/asynSearch.htm?wid=54321&path=/search.htm"/>');
    return mockResponse('<html><script>location="https://login.taobao.com/login.htm"</script></html>');
  };
  const shopFreshLogin = new ShopSearchAdapter({ runtimeDir, fetch: freshWidLoginFetch });
  shopFreshLogin.minIntervalMs = 0;
  shopFreshLogin.jitterMs = 0;
  await assert.rejects(shopFreshLogin.shopSearch('电阻', '131282813'), error => getErrorCode(error) === 'AUTH_REQUIRED');
  const cacheAfterFresh = JSON.parse(await readFile(join(runtimeDir, 'shop-wid.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(cacheAfterFresh['shop131282813.taobao.com'], undefined, '新 wid 命中登录墙后也应清除刚写入的缓存');

  // 7e) 店铺页 302 跳转到天猫/其他域名时，给出明确重定向报错并在日志记录 location
  const redirectFetch: FetchLike = async () => mockResponse('', {
    status: 302,
    headers: { location: 'https://demo.tmall.com/search.htm' },
  });
  const shopRedirect = new ShopSearchAdapter({ runtimeDir, fetch: redirectFetch });
  shopRedirect.minIntervalMs = 0;
  shopRedirect.jitterMs = 0;
  await assert.rejects(
    shopRedirect.shopSearch('电阻', '178030413'),
    error => getErrorCode(error) === 'SHOP_SEARCH_ERROR' && /demo\.tmall\.com/.test(String(error)),
  );

  const reqLogs = (await readFile(join(runtimeDir, 'log', 'mtop-request-log.jsonl'), 'utf8'))
    .trim().split('\n').map(l => JSON.parse(l) as { api: string; ok: boolean; code?: string; waitMs?: number; cookieCount?: number; hasLogin?: boolean; location?: string });
  assert.ok(reqLogs.some(e => e.api === 'shop-page' && e.ok === false && e.code === 'RISK_CONTROL' && typeof e.waitMs === 'number' && e.hasLogin === true));
  assert.ok(reqLogs.some(e => e.api === 'shop-page' && e.ok === false && e.code === 'LOGIN_WALLED'));
  assert.ok(reqLogs.some(e => e.api === 'shop-page' && e.location === 'https://demo.tmall.com/search.htm'));
});

// ── 7b. MtopAdapter.getOrders 多页合并下沉到 SDK 层 ──
test('getOrders: SDK 支持 pages 多页合并、遇末页/NO_RESULTS 自动收尾且操作日志只记 1 条', async () => {
  const base = await makeTempDir('tb-orders-multi-');
  const runtimeDir = join(base, '.runtime');
  const makePage = (pageNo: number, totalPage: number, orderId: string) => ({
    data: {
      meta: { page: { fields: { currentPage: pageNo, totalPage, pageSize: 15, totalNumber: 30 } } },
      group: [{
        [orderId]: [
          { cellType: 'storage', cellData: [{ tag: 'storage', fields: { sellerNick: '店', subAuctionIds: [1001] } }] },
          { cellType: 'head', cellData: [{ tag: 'seller', fields: { shopName: '测试店' } }, { tag: 'status', fields: { text: '交易成功' } }] },
          { cellType: 'sub', cellData: [{ tag: 'item', fields: { title: `商品${pageNo}`, quantity: '1', priceInfo: { actualTotalFee: '￥1.00' } } }] },
          { cellType: 'pay', cellData: [{ tag: 'pay', fields: { actualFee: { value: '￥1.00' } } }] },
        ],
      }],
    },
  });
  const c1 = stubClient([makePage(1, 2, '10000000000000001'), makePage(2, 2, '10000000000000002')]);
  const a1 = new MtopAdapter({ client: c1, runtimeDir });
  const r1 = await a1.getOrders({ page: 1, pages: 5 });
  assert.equal(c1.calls.length, 2, '到达 totalPage=2 自动停止');
  assert.deepEqual(r1.data.orders.map(o => o.orderId), ['10000000000000001', '10000000000000002']);
  const opLogs = (await readFile(join(runtimeDir, 'log', 'mtop-operation-log.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(opLogs.length, 1, '多页合并在操作日志中应为 1 条完整的 orders 记录');

  // 非首页翻页遇 NO_RESULTS → 保留已拉取页正常返回
  const c2 = stubClient([makePage(1, 5, '20000000000000001'), { data: { meta: {}, group: [] } }]);
  const a2 = new MtopAdapter({ client: c2, runtimeDir });
  const r2 = await a2.getOrders({ page: 1, pages: 3 });
  assert.equal(r2.data.orders.length, 1);

  // 非法 pages 校验
  await assert.rejects(a1.getOrders({ page: 1, pages: 0 }), error => getErrorCode(error) === 'INVALID_ARGUMENT');
  await assert.rejects(a1.getOrders({ page: 1, pages: 51 }), error => getErrorCode(error) === 'INVALID_ARGUMENT');
});

// ── 8. CLI 端到端集成测试（真实子进程 node bin/taobao.js）──
test('CLI e2e: help、未知命令、鉴权拦阻、sync-cookie(--cookie-string/--stdin)、参数校验与退出码', async () => {
  const base = await makeTempDir('tb-clie2e-');
  const runtimeDir = join(base, '.runtime');
  const missingCookie = join(base, 'cookie.json');
  const baseEnv = { TAOBAO_COOKIE_FILE: missingCookie, TAOBAO_SEARCH_RUNTIME_DIR: runtimeDir };

  // 8a) --help 退出码 0
  const helpRes = await runCli(['--help'], { env: baseEnv });
  assert.equal(helpRes.code, 0);
  assert.match(helpRes.stdout, /taobao search/);

  // 8b) 未知命令 → 退出码 1 + INVALID_ARGUMENT
  const unknownRes = await runCli(['unknown-cmd'], { env: baseEnv });
  assert.equal(unknownRes.code, 1);
  assert.equal((JSON.parse(unknownRes.stdout) as { ok: boolean; error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  // 8c) 无 Cookie 调 search → AUTH_REQUIRED（零网络请求）
  const noAuthRes = await runCli(['search', '电阻'], { env: baseEnv });
  assert.equal(noAuthRes.code, 1);
  assert.equal((JSON.parse(noAuthRes.stdout) as { error: { code: string } }).error.code, 'AUTH_REQUIRED');

  // 8d) sync-cookie --cookie-string 与 --stdin
  const syncRes = await runCli(['sync-cookie', '--cookie-string', 'unb=777; cookie2=ok777; cna=c777'], { env: baseEnv });
  assert.equal(syncRes.code, 0);
  const syncJson = JSON.parse(syncRes.stdout) as { ok: boolean; data: { hasLoginState: boolean; hasCna: boolean; warning?: string } };
  assert.equal(syncJson.ok, true);
  assert.equal(syncJson.data.hasLoginState, true);
  assert.equal(syncJson.data.hasCna, true);
  assert.ok(syncJson.data.warning, '设置了 TAOBAO_COOKIE_FILE 时应提示主配置优先警告');

  const stdinRes = await runCli(['sync-cookie', '--stdin'], { env: baseEnv, stdin: 'unb=888; cookie2=ok888\n' });
  assert.equal(stdinRes.code, 0);
  assert.equal((JSON.parse(stdinRes.stdout) as { ok: boolean; data: { total: number } }).data.total, 3);

  // 8e) 有登录态后校验各类 CLI 参数边界（绝不发网络请求）
  const badTimeout = await runCli(['search', '电阻', '--timeout', 'abc'], { env: baseEnv });
  assert.equal(badTimeout.code, 1);
  assert.equal((JSON.parse(badTimeout.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badDetail = await runCli(['detail', '123456', '--default', '--spec-id', 'sku:1'], { env: baseEnv });
  assert.equal(badDetail.code, 1);
  assert.equal((JSON.parse(badDetail.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badLabels = await runCli(['detail', '123456', '--labels', '{not-json'], { env: baseEnv });
  assert.equal(badLabels.code, 1);
  assert.equal((JSON.parse(badLabels.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badBatch = await runCli(['batch', '--file', join(base, 'not-exist.json')], { env: baseEnv });
  assert.equal(badBatch.code, 1);
  assert.equal((JSON.parse(badBatch.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badShop = await runCli(['shop-search', '电阻'], { env: baseEnv });
  assert.equal(badShop.code, 1);
  assert.equal((JSON.parse(badShop.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badCartAdd = await runCli(['cart-add'], { env: baseEnv });
  assert.equal(badCartAdd.code, 1);
  assert.equal((JSON.parse(badCartAdd.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const badCartRm = await runCli(['cart-remove'], { env: baseEnv });
  assert.equal(badCartRm.code, 1);
  assert.equal((JSON.parse(badCartRm.stdout) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
});
