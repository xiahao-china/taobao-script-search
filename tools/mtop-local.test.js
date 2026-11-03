import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMtopSpecs, recordPrice, buildStoreRecord } from '../src/adapters/taobao/mtop.js';
import { resolveSpec, skuPrice } from '../src/adapters/taobao/specs.js';
import { extractOrders, assertOrdersPayload } from '../src/adapters/taobao/orders.js';
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
