import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMtopSpecs, recordPrice, buildStoreRecord, MtopAdapter } from '../src/adapters/taobao/mtop.js';
import { resolveSpec, skuPrice } from '../src/adapters/taobao/specs.js';
import { extractOrders, assertOrdersPayload } from '../src/adapters/taobao/orders.js';
import { extractCart, assertCartPayload } from '../src/adapters/taobao/cart.js';
import { mergeSetCookies, mergeCookieString, cookieHeader, cookieSummary, loadCookies, saveCookies, rootCookiePath } from '../src/core/cookie-store.js';
import { parsePrice } from '../src/core/money.js';
import { normalizeUrl } from '../src/core/url.js';

// ── 0. 价格解析：多位小数不被截断
test('money: 3~4 位小数完整保留，2 位小数与整数不受影响', () => {
  assert.equal(parsePrice(['¥0.015']).amount, '0.015', '元器件批发价 3 位小数不得截成 0.01');
  assert.equal(parsePrice(['¥0.0085']).amount, '0.0085');
  assert.equal(parsePrice(['¥12.99']).amount, '12.99');
  assert.equal(parsePrice(['12.99']).amount, '12.99');
  assert.equal(parsePrice(['¥1,234.5']).amount, '1234.5');
});

test('url: 协议相对地址补全，已带协议不重复拼接', () => {
  assert.equal(normalizeUrl('//img.alicdn.com/x.jpg'), 'https://img.alicdn.com/x.jpg');
  assert.equal(normalizeUrl('https://img.alicdn.com/x.jpg'), 'https://img.alicdn.com/x.jpg');
  assert.equal(normalizeUrl('http://a.b/c'), 'http://a.b/c');
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl(null), null);
});

// ── 0b. resolveSpec 标签匹配：归一化 / 组合标签直配 / 按组消歧
test('specs: labels 归一化、组合标签直配与跨组同名消歧', () => {
  const catalog = {
    skuBase: {
      props: [
        { pid: '1', name: '封装', values: [{ vid: '11', name: '0805' }, { vid: '12', name: '0603' }] },
        { pid: '2', name: '阻值', values: [{ vid: '21', name: '10KΩ' }, { vid: '22', name: '1KΩ' }] },
      ],
      skus: [{ skuId: '100', propPath: '1:11;2:21' }],
    },
    skuCore: { sku2info: { '100': { price: { priceText: '0.015' } } } },
  };
  const specs = buildMtopSpecs('789', catalog);
  // 多余空白归一化后仍可匹配
  assert.equal(resolveSpec(specs, { labels: ['0805 ', '  10KΩ'] }).skuId, '100');
  // 单标签 = variant 组合标签整串 → 直接命中
  assert.equal(resolveSpec(specs, { labels: ['0805 / 10KΩ'] }).skuId, '100');
  // 跨组同名值：全局匹配会歧义，按位置对组消歧后可用
  const dup = buildMtopSpecs('790', {
    skuBase: {
      props: [
        { pid: '1', name: '颜色', values: [{ vid: '11', name: '默认' }] },
        { pid: '2', name: '套餐', values: [{ vid: '21', name: '默认' }] },
      ],
      skus: [{ skuId: '200', propPath: '1:11;2:21' }],
    },
    skuCore: { sku2info: { '200': { price: { priceText: '1.00' } } } },
  });
  assert.equal(resolveSpec(dup, { labels: ['默认', '默认'] }).skuId, '200');
});

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

// ── 5. 订单解析：queryboughtlistV2 v1.0 组件流（按真实响应结构合成）
test('orders: 组件流解析出订单、金额剥离与分页', () => {
  const payload = {
    data: {
      meta: { page: { fields: { currentPage: 1, totalPage: 158, pageSize: 15, totalNumber: 2370 } } },
      group: [
        {
          // 键为全精度订单号（JSON number 会丢精度，必须用对象键）
          '5127387411622226723': [
            { cellType: 'storage', cellData: [{ tag: 'storage', fields: { mainOrderId: 5127387411622227000, sellerNick: '爪宠快食', subAuctionIds: [1080730764518, 1080730764519] } }] },
            { cellType: 'head', cellData: [
              { tag: 'seller', fields: { shopName: '爪宠快食官方店', nick: '爪宠快食' } },
              { tag: 'status', fields: { text: '买家已付款' } },
            ] },
            { cellType: 'sub', cellData: [
              { tag: 'item', fields: { title: '紫铜接线端子', skuText: '加厚紫铜OT-40A（2只）', quantity: '2', priceInfo: { actualTotalFee: null, realTotal: null, promotion: '￥2.01' }, pic: '//img.alicdn.com/x.jpg' } },
            ] },
            { cellType: 'sub', cellData: [
              { tag: 'item', fields: { title: '第二件商品', skuText: null, quantity: '1', priceInfo: { actualTotalFee: '￥5.00' }, pic: null } },
            ] },
            { cellType: 'pay', cellData: [{ tag: 'pay', fields: {
              totalFee: { value: '￥7.01' }, actualFee: { value: '￥0.21' }, discountFee: { value: '￥1.80' },
            } }] },
          ],
        },
      ],
    },
  };
  const { orders, pagination } = extractOrders(payload);
  assert.equal(orders.length, 1);
  const order = orders[0];
  assert.equal(order.orderId, '5127387411622226723', '订单号取对象键，全精度');
  assert.equal(order.shopName, '爪宠快食官方店');
  assert.equal(order.status, '买家已付款');
  assert.equal(order.paid, '0.21');
  assert.equal(order.total, '7.01');
  assert.equal(order.discount, '1.80');
  assert.equal(order.items.length, 2);
  assert.equal(order.items[0].price, '2.01');
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].auctionId, '1080730764518');
  assert.equal(order.items[1].auctionId, '1080730764519', '同单第 2 件商品的 auctionId 应按索引对应，不得错挂第 1 件');
  assert.equal(order.items[0].pic, 'https://img.alicdn.com/x.jpg');
  assert.equal(order.items[1].price, '5.00');
  assert.deepEqual(pagination, { currentPage: 1, totalPage: 158, pageSize: 15, totalNumber: 2370 });
  // assertOrdersPayload：有数据直接透传
  const passed = assertOrdersPayload(payload);
  assert.equal(passed.orders.length, 1);
});

test('orders: 空响应抛 NO_RESULTS', () => {
  assert.throws(() => assertOrdersPayload({ data: { meta: {}, group: [] } }), /NO_RESULTS|订单接口未返回/);
});

// ── 6. 店铺信誉块：pcdetail seller + storeCardVO（按真实响应结构合成）
test('store: DSR/质量分/标签/天猫标识映射，缺源返回 null', () => {
  const seller = {
    sellerType: 'B', sellerNick: '楚卫旗舰店', shopName: '楚卫旗舰店',
    evaluates: [
      { level: '1', levelText: '高', score: '4.9 ', title: '宝贝描述', type: 'desc' },
      { level: '1', levelText: '高', score: '4.9 ', title: '卖家服务', type: 'serv' },
      { level: '1', levelText: '高', score: '4.9 ', title: '物流服务', type: 'post' },
    ],
  };
  const storeCard = {
    sellerType: 'B', overallScore: '5.0', creditLevel: '16',
    evaluates: [{ score: '5.0', title: '宝贝质量' }, { score: '4.9', title: '物流速度' }, { score: '4.9', title: '服务保障' }],
    labelList: [{ contentDesc: '88VIP好评率98%' }, { contentDesc: '平均10小时发货' }, { contentDesc: '' }, null],
  };
  const record = buildStoreRecord(seller, storeCard);
  assert.equal(record.sellerType, 'B');
  assert.equal(record.isTmall, true, 'sellerType B 应判为天猫');
  assert.equal(record.dsr.length, 3);
  assert.equal(record.dsr[0].score, '4.9', 'DSR 分数应剥离首尾空格');
  assert.equal(record.dsr[0].levelText, '高');
  assert.equal(record.scores.length, 3);
  assert.equal(record.overallScore, '5.0');
  assert.equal(record.creditLevel, '16');
  assert.deepEqual(record.labels, ['88VIP好评率98%', '平均10小时发货'], '空标签与 null 项应剔除');

  // C 店（淘宝集市）：seller 只有 sellerNick+sellerType，storeCardVO 只剩 creditLevel
  assert.equal(buildStoreRecord({ sellerType: 'C', evaluates: [] }, null).isTmall, false);
  const cShop = buildStoreRecord(
    { sellerType: 'C', sellerNick: '个人卖家', evaluates: [{ level: '0', levelText: '平', score: '0.0 ', title: '宝贝描述', type: 'desc' }] },
    { sellerType: 'C', creditLevel: '0' },
  );
  assert.equal(cShop.isTmall, false);
  assert.equal(cShop.dsr[0].levelText, '平');
  assert.equal(cShop.scores, null);
  assert.equal(cShop.labels, null);
  // h5 路径两者皆无 → null（detail 输出 store:null）
  assert.equal(buildStoreRecord(null, null), null);
  assert.equal(buildStoreRecord({ shopName: 'x' }, { shopName: 'x' }), null, '只有店名不算店铺信誉数据');
});

// ── 7. 风控细分与批量 fail-fast（stub client，零网络）
import { TaobaoError } from '../src/core/errors.js';

function stubClient(script) {
  // script: 逐次调用的返回值/异常队列；记录调用序列供断言。
  const calls = [];
  return {
    calls,
    request: async (api, version, data, options = {}) => {
      calls.push({ api, data });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('batch: 命中 AUTH_REQUIRED/RISK_CONTROL 立即终止，剩余条目不执行并带 aborted 说明', async () => {
  const client = stubClient([
    { data: {} }, // 第 1 条 search 正常返回（下游解析为空结果也无妨，只看条目数）
    new TaobaoError('RISK_CONTROL', '触发淘宝风控拦截（RGV587）'),
  ]);
  const adapter = new MtopAdapter({ client });
  const result = await adapter.batch({ searches: ['a', 'b', 'c'], products: [{ itemId: '123', specs: [null] }] }, undefined);
  const { results, aborted, note } = result.data;
  assert.equal(client.calls.length, 2, '第 2 条触发风控后不得再发任何请求');
  assert.equal(results.length, 2, '只有已执行的条目出现在结果里');
  assert.equal(aborted.code, 'RISK_CONTROL');
  assert.ok(/提前终止/.test(note));
});

test('batch: 非致命错误（如 NO_RESULTS）不终止整批', async () => {
  const client = stubClient([
    new TaobaoError('NO_RESULTS', '无结果'),
    { data: {} },
  ]);
  const adapter = new MtopAdapter({ client });
  const result = await adapter.batch({ searches: ['a', 'b'] }, undefined);
  assert.equal(result.data.results.length, 2, '单项失败不影响其余项');
  assert.equal(result.data.aborted, undefined);
});

test('fetchCatalog: RISK_CONTROL 与 AUTH_REQUIRED 一样直接上抛，不浪费备用接口请求', async () => {
  const client = stubClient([new TaobaoError('RISK_CONTROL', '风控')]);
  const adapter = new MtopAdapter({ client });
  await assert.rejects(adapter.fetchCatalog('123', undefined), error => error.code === 'RISK_CONTROL');
  assert.equal(client.calls.length, 1, '风控按指纹拦，换接口无意义，不得回退重试');
});

// ── 8. 请求日志：JSONL 追加、逐行可解析
import { appendRequestLog } from '../src/core/mtop-client.js';

test('request log: 归档到 log/ 文件夹，旧位置文件自动迁移', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-rlog-'));
  tempDirs.push(base);
  const dir = join(base, '.runtime');
  const logDir = join(dir, 'log');
  const logPath = join(logDir, 'mtop-request-log.jsonl');
  // 旧版日志躺在 .runtime 根下 → 首次写入时应被搬进 log/ 并保留内容。
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mtop-request-log.jsonl'), '{"t":1,"legacy":true}\n');
  await appendRequestLog(dir, { t: 1000, ts: '2026-11-04T00:00:01.000Z', api: 'mtop.taobao.wsearch.appsearch', v: '1.0', ok: true, waitMs: 0, ms: 320, http: 200 });
  await appendRequestLog(dir, { t: 7000, ts: '2026-11-04T00:00:07.000Z', api: 'mtop.taobao.detail.getdetail', v: '6.0', ok: false, code: 'RISK_CONTROL', waitMs: 6120, ms: 410, ret: ['FAIL_SYS_RGV587::xx'] });
  assert.ok(!(await readFile(join(dir, 'mtop-request-log.jsonl'), 'utf8').catch(() => null)), '旧位置文件应被迁移走');
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3, '迁移的旧行 + 两条新记录');
  assert.equal(JSON.parse(lines[0]).legacy, true, '旧日志内容不丢');
  const first = JSON.parse(lines[1]);
  const second = JSON.parse(lines[2]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'RISK_CONTROL');
  assert.equal(second.waitMs, 6120, '限速等待时长必须落档，否则无法复盘节奏');
  assert.ok(second.t > first.t, '两次请求的时间戳可推导真实间隔');
});

// ── 9. 操作日志：每次业务查询一行，含查询类型/入参/完整业务结果或错误
import { appendOperationLog } from '../src/core/mtop-client.js';

test('operation log: 记录查询类型、入参与完整业务结果（商品列表）', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-oplog-'));
  tempDirs.push(base);
  const dir = join(base, '.runtime');
  const adapter = new MtopAdapter({
    client: stubClient([
      { itemsArray: [{ id: '987654321', title: '墨水屏模块', price: { priceText: '43.00' }, shopName: '大菠萝电子', view_sales: '1000+' }] },
      { data: {} }, // 空结果 → NO_RESULTS，验证失败同样落档
    ]),
    runtimeDir: dir,
  });
  await adapter.search('墨水屏', { limit: 5 });
  await assert.rejects(adapter.search('查无此物'), error => error.code === 'NO_RESULTS');
  const lines = (await readFile(join(dir, 'log', 'mtop-operation-log.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2, '成功与失败各落一行');
  const first = JSON.parse(lines[0]);
  assert.equal(first.operation, 'search');
  assert.equal(first.ok, true);
  assert.equal(first.params.keyword, '墨水屏');
  assert.equal(first.params.limit, 5, '入参（含默认值合并后的）要落档');
  assert.equal(first.data.items[0].itemId, '987654321');
  assert.equal(first.data.items[0].title, '墨水屏模块');
  assert.equal(first.data.items[0].shopName, '大菠萝电子');
  assert.equal(first.data.items[0].priceSummary.display, '43.00', '结果内容详情（含价格）要在日志里');
  assert.equal(typeof first.ms, 'number', '耗时落档');
  const second = JSON.parse(lines[1]);
  assert.equal(second.operation, 'search');
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'NO_RESULTS');
  assert.ok(second.t >= first.t, '时间戳可推导查询顺序与间隔');
});

test('operation log: appendOperationLog 直写路径为 log/ 文件夹', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-oplog2-'));
  tempDirs.push(base);
  const dir = join(base, '.runtime');
  await appendOperationLog(dir, { t: 1, operation: 'detail', params: { itemId: '123' }, ok: true, data: { title: 'x' } });
  const line = JSON.parse(await readFile(join(dir, 'log', 'mtop-operation-log.jsonl'), 'utf8'));
  assert.equal(line.operation, 'detail');
  assert.deepEqual(line.params, { itemId: '123' });
});

// ── 10. MtopClient mock fetch：预热、TOKEN 过期重签、RGV587 不重试、batch 增量进度
import { MtopClient } from '../src/core/mtop-client.js';
import { readdir } from 'node:fs/promises';

function mockResponse(body, { status = 200, setCookies = [] } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => setCookies },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

test('MtopClient: warmSession 领取 cna/token，TOKEN_EXPIRED 自动重签一次', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-client-'));
  tempDirs.push(base);
  const dir = join(base, '.runtime');
  await saveCookies({ syncedAt: null, sync: null, cookies: { unb: { value: 'u1', domain: '.taobao.com', expires: -1 } } }, dir);
  const calls = [];
  const mockFetch = async url => {
    const href = String(url);
    calls.push(href);
    if (href === 'https://www.taobao.com/') {
      return mockResponse('<html></html>', { setCookies: ['cna=testcna123; Domain=.taobao.com; Path=/'] });
    }
    if (href.includes('mtop.common.gettimestamp')) {
      return mockResponse({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }, {
        setCookies: ['_m_h5_tk=tok1_9999999999999; Domain=.taobao.com', '_m_h5_tk_enc=enc1; Domain=.taobao.com'],
      });
    }
    if (calls.filter(u => u.includes('mtop.taobao.wsearch.appsearch')).length === 1) {
      return mockResponse({ ret: ['FAIL_SYS_TOKEN_EXPIRED::令牌过期'] }, {
        setCookies: ['_m_h5_tk=tok2_9999999999999; Domain=.taobao.com', '_m_h5_tk_enc=enc2; Domain=.taobao.com'],
      });
    }
    return mockResponse({ ret: ['SUCCESS::调用成功'], data: { ok: true } });
  };
  const client = new MtopClient({ runtimeDir: dir, minIntervalMs: 0, jitterMs: 0, fetch: mockFetch });
  const data = await client.request('mtop.taobao.wsearch.appsearch', '1.0', { q: 'test' });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.filter(u => u.includes('mtop.taobao.wsearch.appsearch')).length, 2, 'TOKEN_EXPIRED 后重签一次');
  const files = await readdir(dir);
  assert.ok(!files.some(name => name.endsWith('.tmp')), 'saveCookies 原子写入不应残留 .tmp 文件');
});

test('MtopClient: RGV587 风控拦截刻意不自动重试', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-risk-'));
  tempDirs.push(base);
  const dir = join(base, '.runtime');
  await saveCookies({
    syncedAt: null, sync: null,
    cookies: {
      unb: { value: 'u1', domain: '.taobao.com', expires: -1 },
      cna: { value: 'c1', domain: '.taobao.com', expires: -1 },
      _m_h5_tk: { value: 'tok_999', domain: '.taobao.com', expires: -1 },
    },
  }, dir);
  let count = 0;
  const client = new MtopClient({
    runtimeDir: dir, minIntervalMs: 0, jitterMs: 0,
    fetch: async () => { count += 1; return mockResponse({ ret: ['FAIL_SYS_RGV587::被挤爆了'] }); },
  });
  await assert.rejects(client.request('mtop.taobao.wsearch.appsearch', '1.0', { q: 'x' }), error => error.code === 'RISK_CONTROL');
  assert.equal(count, 1, '风控后绝不原地重试');
});

test('batch: onProgress 逐项回调可用于增量落盘', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-batchprog-'));
  tempDirs.push(base);
  const adapter = new MtopAdapter({
    client: stubClient([
      { itemsArray: [{ id: '111111', title: 'A', price: '1.00' }] },
      { itemsArray: [{ id: '222222', title: 'B', price: '2.00' }] },
    ]),
    runtimeDir: join(base, '.runtime'),
  });
  const snapshots = [];
  await adapter.batch({ searches: ['a', 'b'] }, undefined, {
    onProgress: async progress => snapshots.push(progress.total),
  });
  assert.deepEqual(snapshots, [1, 2]);
});

// ── cart: query.bag 5.0 组件字典解析（fixture 摘自 2026-11-13 真实响应）──
test('cart: 组件字典 → 条目/店铺/结算汇总，skuId=0 无规格商品归一为 null', () => {
  const payload = {
    container: [{ name: 'cart_item' }],
    data: {
      'item_6708844442194': {
        id: '6708844442194', tag: 'item', type: 'dinamicx$cartitem',
        bundleId: 's_2204783677373',
        fields: {
          bizCode: 'ali.china.taobao.enterpriseservice', pic: '//gw.alicdn.com/imgextra/x.jpg',
          title: 'SWPA4018S4R7MT 顺络贴片功率电感',
          settlement: '605076509553_1_4846287504517_null_0_null_null_6708844442194_null_null_null',
          shopId: '474791141',
          sku: { areaId: '210711', skuId: '4846287504517', skuInvalid: false, title: 'SWPA4018S4R7MT（4.7UH）' },
          toBuy: 'taobao', quantity: '1', cartId: '6708844442194',
          bundleId: 's_2204783677373',
          pay: { afterPromPrice: 11, nowTitle: '￥0.11', total: 11 },
          isChecked: 'false', itemId: '605076509553', canCheck: true,
          outerUrl: '//item.taobao.com/item.htm?id=605076509553&from=cart&skuId=4846287504517&',
        },
      },
      'item_6709263508685': {
        id: '6709263508685', tag: 'item', type: 'dinamicx$cartitem',
        fields: {
          pic: '//gw.alicdn.com/imgextra/y.jpg', title: '贴片三极管 SI2308 A8SHB SOT-23',
          sku: { skuId: '0' }, toBuy: 'taobao', quantity: '3', cartId: '6709263508685',
          bundleId: 's_2658592015',
          pay: { afterPromPrice: 12, nowTitle: '￥0.04', total: 12 },
          isChecked: 'true', itemId: '533810161160', canCheck: true,
        },
      },
      'shop_s_2204783677373': {
        id: 's_2204783677373', tag: 'shop', type: 'dinamicx$cartshop',
        fields: { title: '深圳市华源芯电子有限公司 电子元器件配单', valid: true, bizArgs: { shopId: 2204783677373 } },
      },
      'shop_s_2658592015': {
        id: 's_2658592015', tag: 'shop', type: 'dinamicx$cartshop',
        fields: { title: '深圳市优信电子科技有限公司', valid: true, bizArgs: { shopId: 2658592015 } },
      },
      'submit_1': {
        id: '1', tag: 'submit', position: 'footer', type: 'native$submit',
        fields: {
          quantity: 2,
          submit: { status: 'normal', title: '结算(1)' },
          pay: { price: 4, priceTitle: '￥0.04', totalDiscount: '￥0', totalTitle: '合计:' },
        },
      },
      'header_1': { id: '1', tag: 'header', type: 'native$header', fields: { title: '购物车' } },
      'group_i_x': { id: 'i_x', tag: 'group', type: 'block$groupBlock', fields: {} },
    },
  };
  const cart = extractCart(payload);
  assert.equal(cart.items.length, 2);
  assert.equal(cart.pageTitle, '购物车');
  const first = cart.items[0];
  assert.equal(first.itemId, '605076509553');
  assert.equal(first.cartId, '6708844442194');
  assert.equal(first.sku.skuId, '4846287504517');
  assert.equal(first.sku.title, 'SWPA4018S4R7MT（4.7UH）');
  assert.equal(first.quantity, 1);
  assert.equal(first.priceText, '0.11', 'pay.nowTitle 文案剥离为纯数字');
  assert.equal(first.priceCents, 11);
  assert.equal(first.shopName, '深圳市华源芯电子有限公司 电子元器件配单', 'bundleId 关联店铺组件');
  assert.equal(first.shopId, '2204783677373');
  assert.equal(first.url, 'https://item.taobao.com/item.htm?id=605076509553&from=cart&skuId=4846287504517&');
  assert.equal(first.isChecked, false);
  const second = cart.items[1];
  assert.equal(second.sku, null, 'skuId=0 无规格商品 sku 归一为 null');
  assert.equal(second.shopName, '深圳市优信电子科技有限公司');
  assert.equal(second.isChecked, true);
  assert.equal(second.quantity, 3);
  assert.deepEqual(cart.shops.map(shop => shop.shopId).sort(), ['2204783677373', '2658592015']);
  assert.deepEqual(cart.summary, {
    itemCount: 2, checkedCount: 2, totalPriceText: '0.04', totalDiscountText: '0', submitTitle: '结算(1)',
  });
});

test('cart: 空购物车（无 item 组件）→ items 为空数组，不抛 NO_RESULTS（空车是合法状态）', () => {
  const payload = {
    data: {
      'header_1': { id: '1', tag: 'header', type: 'native$header', fields: { title: '购物车' } },
      'submit_1': { id: '1', tag: 'submit', type: 'native$submit', fields: { quantity: 0, submit: { status: 'disable', title: '结算(0)' }, pay: { priceTitle: '￥0', totalDiscount: '￥0' } } },
    },
  };
  const cart = extractCart(payload);
  assert.deepEqual(cart.items, []);
  assert.equal(cart.summary.itemCount, 0);
  assert.equal(cart.summary.checkedCount, 0);
});

test('cart: assertCartPayload 对结构缺失（data 为空对象）报 NO_RESULTS', () => {
  assert.throws(() => assertCartPayload({}), error => error.code === 'NO_RESULTS');
});

// ── cart-add: 加购响应解析（fixture 摘自 2026-11-14 真实探针响应）──
import { parseAddCartResult } from '../src/adapters/taobao/cart.js';

test('cart-add: TB.Detail.CartResult 提取 cartQuantity，非 JSON 容错', () => {
  const body = '\n\t    TB.Detail.CartResult = {\n    "cartQuantity": "21",\n    "cartPrice": ""\n    }\n\t';
  const parsed = parseAddCartResult(body);
  assert.deepEqual(parsed, { cartQuantity: '21', cartPrice: '' });
  assert.equal(parseAddCartResult('<html>login required</html>'), null);
  assert.equal(parseAddCartResult('TB.Detail.CartResult = { broken'), null);
  assert.equal(parseAddCartResult(''), null);
});

test('cart-add: addToCart 参数校验（quantity 范围 / skuId 格式）', async () => {
  const adapter = new MtopAdapter({ client: stubClient([]) });
  await assert.rejects(adapter.addToCart('123', { quantity: 0 }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.addToCart('123', { quantity: 1000 }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.addToCart('123', { quantity: 1.5 }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.addToCart('123', { skuId: 'abc' }), error => error.code === 'INVALID_ARGUMENT');
});
