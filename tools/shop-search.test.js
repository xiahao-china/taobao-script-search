import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShopRef, extractWid, extractFontUrl, parseShopSearch, parseJsonp } from '../src/adapters/taobao/shop-search.js';
import { parsePriceFontMap, decodeEntities } from '../src/core/shop-font.js';
import { gbkEncode } from '../src/core/gbk.js';

// ── GBK 编码：与浏览器行为一致（HAR 基准 q=0805+%B5%E7%D7%E8）
test('gbk: 常用中文关键词编码与浏览器 HAR 基准逐字节一致', () => {
  assert.equal(gbkEncode('0805 电阻'), '0805+%B5%E7%D7%E8');
  assert.equal(gbkEncode('a-b_1.0'), 'a-b_1.0', 'ASCII 安全字符原样');
  assert.equal(gbkEncode('a&b=c'), 'a%26b%3Dc', '保留字必须转义，避免破坏参数结构');
  assert.throws(() => gbkEncode('😀'), /GBK/, 'GBK 范围外字符明确报错而非静默替换');
});

// ── 店铺引用解析
test('shopRef: shopId / 数值子域名 / 昵称子域名 / 对象四种形态', () => {
  assert.deepEqual(parseShopRef('131282813'), { shopId: '131282813', host: 'shop131282813.taobao.com' });
  assert.deepEqual(parseShopRef('https://shop131282813.taobao.com/category.htm?a=1'),
    { shopId: '131282813', host: 'shop131282813.taobao.com' });
  assert.deepEqual(parseShopRef('youxin-electronic.taobao.com'),
    { shopId: null, host: 'youxin-electronic.taobao.com' }, '昵称子域名无 shopId，host 原样保留');
  assert.deepEqual(parseShopRef({ shopUrl: 'https://shop131282813.taobao.com' }),
    { shopId: '131282813', host: 'shop131282813.taobao.com' });
  assert.throws(() => parseShopRef('https://example.com/x'), /INVALID_ARGUMENT|无法解析/);
  assert.throws(() => parseShopRef(''), /无法解析/);
});

// ── wid 提取：首选内嵌 asynSearch URL，兜底 asynSearch 模块注释前的 widgetid
test('wid: 内嵌 URL / 模块注释兜底 / 双提取通道', () => {
  const page1 = '<input value="/i/asynSearch.htm?input_charset=gbk&amp;mid=w-24706531953-0&amp;wid=24706531953&amp;path=/search.htm&amp;search=y"/>';
  assert.equal(extractWid(page1), '24706531953');
  const page2 = '<div data-widgetid="24706531880" id="shopA"></div>'
    + '<div data-widgetid="24706531953" id="shopB"><!--    useCSI: true   asynSearch : true  -->';
  assert.equal(extractWid(page2), '24706531953', '兜底取注释前最近的 widgetid');
  assert.equal(extractWid('<html>无任何标记</html>'), null);
});

test('fontUrl: AlibabaSans102CustomFont 的 @font-face src 提取（含协议相对补全）', () => {
  const page = "AlibabaSans102CustomFont'; src: url('//webfontcdn.taobao.com/webfont/x.woff') format('woff');";
  assert.equal(extractFontUrl(page), 'https://webfontcdn.taobao.com/webfont/x.woff');
  assert.equal(extractFontUrl('no font here'), null);
});

// ── JSONP 反转义：内层是 JSON 字符串（内容为 HTML），只解开一层——
// 返回字符串供切块解析；必须按 JSON 语义解（手工 unicode_escape 会破坏实体）
test('jsonp: 内层 JSON 字符串解开一层，非 JSONP 输入返回 null', () => {
  const raw = 'jsonp123("{\\"a\\":\\"\\u4ef7\\u683c&#34500;\\",\\"n\\":1}")';
  const body = parseJsonp(raw);
  assert.equal(typeof body, 'string', '内层是 JSON 字符串，解开一层后仍为字符串');
  assert.match(body, /价格&#34500;/, 'unicode 转义已解开，HTML 实体保留待字体映射处理');
  assert.equal(parseJsonp('not jsonp at all'), null);
});

// ── 商品块解析：切块 / 字段 / 价格字体映射
const FONT_WOFF_FIXTURE = null; // 字体用真实样本在集成环境验证；单测用合成映射

test('shopSearch 解析: 商品块字段齐全，价格经字体映射还原', () => {
  // 合成映射：码点 → 数字字符（模拟字体轮换机制；'0' 也入映射）
  const fontMap = new Map([[65000, '1'], [65001, '4'], [65002, '.'], [65003, '0'], [65004, '2']]);
  const item = (id, price, strike) => `<dl class="item" data-id="${id}">
    <dt class="photo"><a href="//item.taobao.com/item.htm?id=${id}&amp;mi_id=x">
      <img src="//img.alicdn.com/bao/uploaded/pic_${id}.jpg"></a></dt>
    <dd class="detail"><a class="item-name J_TGoldData" href="//item.taobao.com/item.htm?id=${id}"> 电阻 ${id} </a>
      <span class="c-user-price"><span class="c-price">&#65000;&#65001;&#65002;&#65003;&#65003;</span>
      <span class="s-price">&#65000;&#65002;&#65004;&#65000;</span></span>
      <span class="sale-num"> 21 </span></dd></dl>`;
  const body = '<div class="search-result">共搜索到<span> 197 </span>个符合条件的商品。'
    + `<span class="page-info">1/9</span>`
    + item('522579332490', 0, 0) + item('522554163487', 0, 0);
  const parsed = parseShopSearch(body, fontMap);
  assert.equal(parsed.total, 197);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pages, 9);
  assert.equal(parsed.items.length, 2);
  const first = parsed.items[0];
  assert.equal(first.itemId, '522579332490');
  assert.equal(first.priceText, '14.00', '码点实体经字体映射还原为明文价格');
  assert.equal(first.strikethroughText, '1.21');
  assert.equal(first.salesText, '21');
  assert.equal(first.title, '电阻 522579332490', '首尾空白归一化');
  assert.equal(first.imageUrl, 'https://img.alicdn.com/bao/uploaded/pic_522579332490.jpg');
  assert.match(first.url, /item\.taobao\.com\/item\.htm\?id=522579332490/);
  assert.equal(first.priceUnknown, false);
});

test('shopSearch 解析: 无字体映射时价格置 null（混合策略），坏实体按未知位数标记', () => {
  const body = `<dl class="item" data-id="1"><a class="item-name" href="//item.taobao.com/item.htm?id=1">X</a>
    <span class="c-price">&#65001;&#99999999;</span></dl>`;
  const noFont = parseShopSearch(body, null);
  assert.equal(noFont.items[0].priceText, null, 'fontMap 缺失 → null，不臆造');
  assert.equal(noFont.items[0].priceUnknown, false);
  const withFont = parseShopSearch(body, new Map([[65001, '1']]));
  assert.equal(withFont.items[0].priceText, '1?', '映射缺失的码点记 ?，保持位数可对账');
  assert.equal(withFont.items[0].priceUnknown, false, '部分解出不算全未知');
  const allUnknown = parseShopSearch('<dl class="item" data-id="2"><span class="c-price">&#99999999;</span></dl>', new Map());
  assert.equal(allUnknown.items[0].priceText, '?');
  assert.equal(allUnknown.items[0].priceUnknown, true, '完全未解出的价格标记 unknown');
});

// ── 字体解码器：合成 WOFF 无法凭空构造（含 zlib 压缩与表布局），
// 真实字体文件的端到端解码由「字体样本 + fontTools 基准」在调研阶段验证过
// （2026-11-12：24 商品价格全还原，截图比对一致）。此处验证解码器的错误路径。
test('shopFont: 非 WOFF1 输入明确报错', () => {
  assert.throws(() => parsePriceFontMap(Buffer.from('GIF89a-not-a-font')), /WOFF1/);
});

test('decodeEntities: 未知码点记 ?，混合实体位数保持', () => {
  const map = new Map([[65, 'A']]);
  assert.equal(decodeEntities('&#65;&#66;', map), 'A?');
  assert.equal(decodeEntities('&#65;', map), 'A');
});

import { ShopSearchAdapter } from '../src/adapters/taobao/shop-search.js';
import { saveCookies } from '../src/core/cookie-store.js';

test('ShopSearchAdapter: 页面改版导致 extractWid 返回 null 时保留已有缓存 wid，不覆盖为 null', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tb-shopwid-'));
  const dir = join(base, '.runtime');
  await mkdir(dir, { recursive: true });
  await saveCookies({
    syncedAt: null, sync: null,
    cookies: { unb: { value: 'u1', domain: '.taobao.com', expires: -1 }, _m_h5_tk: { value: 't_1', domain: '.taobao.com', expires: -1 } },
  }, dir);
  await writeFile(join(dir, 'shop-wid.json'), JSON.stringify({
    'shop123456.taobao.com': { wid: '987654321', host: 'shop123456.taobao.com', resolvedAt: '2026-11-12T00:00:00Z' },
  }));
  const urls = [];
  const mockFetch = async url => {
    const href = String(url);
    urls.push(href);
    const body = !href.includes('/i/asynSearch.htm')
      ? '<html><body>no widget id here</body></html>'
      : `jsonp1(${JSON.stringify('<dl data-id="112233"><a class="item-name" href="//item.taobao.com/item.htm?id=112233">Demo</a></dl>')})`;
    return {
      ok: true, status: 200,
      headers: { getSetCookie: () => [] },
      arrayBuffer: async () => Buffer.from(body, 'utf8'),
    };
  };
  const adapter = new ShopSearchAdapter({ runtimeDir: dir, fetch: mockFetch });
  adapter.minIntervalMs = 0;
  adapter.jitterMs = 0;
  const res = await adapter.shopSearch('Demo', '123456');
  assert.equal(res.data.shop.wid, '987654321');
  assert.equal(res.meta.widSource, 'cache-degraded');
  assert.ok(urls.some(u => u.includes('wid=987654321')), 'asynSearch 必须带上缓存 wid 而非 wid=null');
  await rm(base, { recursive: true, force: true });
});
