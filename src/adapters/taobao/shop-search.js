// 店铺内搜索（免签名纯 GET 通道）：淘宝 PC 店铺页的 asynSearch 接口。
// 链路：店铺引用 → 子域名解析 → search.htm 提取 wid（宝贝列表模块挂件号，缓存）
// → asynSearch 分页 → JSONP 解析商品块 → 价格字体（同会话配对）还原。
// 2026-11-12 实测结论：
// - wid 不是全店唯一 ID，而是页面模块 widgetid；必须从店铺页 HTML 提取，
//   错误 wid 会返回 login 跳转页（约 4.9KB、含 login.htm 跳转脚本）。
// - 价格用 CJK 码点实体 + AlibabaSans102CustomFont 字体反爬；字体 URL 在
//   search.htm 的 @font-face；映射每次会话轮换，但同会话 页面字体 × asynSearch
//   数据天然配对。解码方案见 core/shop-font.js。
// - 搜索页/店铺页需要真实登录 Cookie（裸 HTTP 会命中 login 墙或 TMD 滑块）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaobaoError, checkAbort } from '../../core/errors.js';
import { runtimePaths } from '../../core/config.js';
import { loadCookies, saveCookies, mergeSetCookies, cookieHeader } from '../../core/cookie-store.js';
import { reserveSlot, appendRequestLog, appendOperationLog } from '../../core/mtop-client.js';
import { parsePriceFontMap, decodeEntities } from '../../core/shop-font.js';
import { gbkEncode } from '../../core/gbk.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GBK = new TextDecoder('gbk');
// wid 缓存：挂件号只在店铺重新装修时变化，缓存后跳过页面提取。
// 价格字体映射会轮换，不在缓存范围（每次都随页面现取）。
function widCachePath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'shop-wid.json');
}

async function loadWidCache(runtimeDir) {
  try { return JSON.parse(await readFile(widCachePath(runtimeDir), 'utf8')); }
  catch { return {}; }
}

async function saveWidCache(runtimeDir, cache) {
  const path = widCachePath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2) + '\n');
}

// 店铺引用解析：支持 数字 shopId / 店铺任意页 URL / {shopId, shopUrl} 对象。
// 昵称子域名（youxin-electronic.taobao.com）与数值子域名（shop131282813…）
// 均可用——asynSearch 挂在任意有效店铺子域名下。
export function parseShopRef(ref) {
  const fail = () => new TaobaoError('INVALID_ARGUMENT',
    '店铺引用无法解析。支持：店铺 URL（如 https://shop123.taobao.com 或昵称子域名页）、数字 shopId。');
  if (ref && typeof ref === 'object') ref = ref.shopUrl || ref.url || (ref.shopId ? `shop${ref.shopId}.taobao.com` : null);
  const text = String(ref || '').trim();
  if (/^\d{6,}$/.test(text)) return { shopId: text, host: `shop${text}.taobao.com` };
  if (!/^https?:\/\//i.test(text) && !/^[a-z0-9-]+\.taobao\.com/i.test(text)) throw fail();
  let url;
  try { url = new URL(/^https?:/i.test(text) ? text : `https://${text}`); }
  catch { throw fail(); }
  if (!/(?:^|\.)taobao\.com$|(?:^|\.)tmall\.com$/i.test(url.hostname)) throw fail();
  const shopId = url.hostname.match(/^shop(\d+)\./i)?.[1] || null;
  return { shopId, host: url.hostname };
}

// wid 提取：首选页面内嵌 asynSearch URL（多处出现、值一致、不依赖中文标签）；
// 兜底取「asynSearch : true」模块注释前最近的 data-widgetid。
export function extractWid(page) {
  let match = page.match(/\/i\/asynSearch\.htm[^"']{0,600}?wid=(\d+)/);
  if (!match) {
    const anchor = page.indexOf('asynSearch : true');
    if (anchor > 0) {
      const segment = page.slice(Math.max(0, anchor - 2000), anchor);
      const ids = [...segment.matchAll(/data-widgetid="(\d+)"/g)];
      if (ids.length) return ids[ids.length - 1][1];
    }
    return null;
  }
  return match[1];
}

// 字体 URL：search.htm @font-face 里的 AlibabaSans102CustomFont src（CDN 免登录）。
export function extractFontUrl(page) {
  const match = page.match(/AlibabaSans102CustomFont';\s*src:\s*url\('([^']+)'\)/)
    || page.match(/@font-face[^}]*?src:\s*url\('([^']+\.woff[^']*)'\)/s);
  if (!match) return null;
  return match[1].startsWith('//') ? `https:${match[1]}` : match[1];
}

// 商品块解析：按 <dl data-id> 切块，每块取 item-name/图片/销量/价格实体。
// 价格实体依赖字体映射还原（fontMap 为 null 时价格置 null——混合策略）。
export function parseShopSearch(body, fontMap) {
  const parts = body.split(/<dl[^>]*data-id="(\d+)"/);
  const items = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const itemId = parts[i];
    const chunk = parts[i + 1].split('</dl>')[0];
    const title = chunk.match(/class="item-name[^"]*"[^>]*>([^<]+)</)?.[1];
    const image = chunk.match(/<img[^>]*src="([^"]+)"/)?.[1];
    const href = chunk.match(/href="([^"]*item\.htm\?id=\d+[^"]*)"/)?.[1];
    const sales = chunk.match(/class="sale-num"[^>]*>([^<]+)</)?.[1];
    const priceRaw = chunk.match(/class="c-price[^"]*"[^>]*>([^<]+)</)?.[1];
    const strikeRaw = chunk.match(/class="s-price[^"]*"[^>]*>([^<]+)</)?.[1];
    items.push({
      itemId,
      title: title ? title.replace(/\s+/g, ' ').trim() : null,
      priceText: priceRaw && fontMap ? decodeEntities(priceRaw, fontMap) : null,
      strikethroughText: strikeRaw && fontMap ? decodeEntities(strikeRaw, fontMap) : null,
      // 解码失败的 '?' 保留位数可对账；全 '?' 视为未解出。
      priceUnknown: Boolean(priceRaw && fontMap && /^\?+$/.test(decodeEntities(priceRaw, fontMap))),
      salesText: sales ? sales.replace(/\s+/g, ' ').trim() : null,
      url: href ? `https:${href.startsWith('//') ? href : `//item.taobao.com/${href}`}`.replace('https:https:', 'https:') : `https://item.taobao.com/item.htm?id=${itemId}`,
      imageUrl: image ? (image.startsWith('//') ? `https:${image}` : image) : null,
    });
  }
  const total = Number(body.match(/共搜索到<span>\s*(\d+)\s*<\/span>/)?.[1]) || null;
  const pageInfo = body.match(/class="page-info">\s*(\d+)\s*\/\s*(\d+)/);
  return { items, total, page: pageInfo ? Number(pageInfo[1]) : null, pages: pageInfo ? Number(pageInfo[2]) : null };
}

// JSONP 响应：jsonpN("<JSON字符串>")，内层是 JSON 字符串（内含 HTML）。
// 必须按 JSON 语义反转义（手工 unicode_escape 会破坏 GBK/实体字节，教训见调研记录）。
export function parseJsonp(raw) {
  const match = raw.match(/^\s*jsonp\d+\("(.*)"\)\s*$/s);
  if (!match) return null;
  return JSON.parse(`"${match[1]}"`);
}

// 被 login 跳转/TMD 滑块接管的响应判定：均无商品数据。
const isLoginWalled = page => /login\.htm/.test(page) && !/data-id="\d+"/.test(page);
const isCaptcha = page => /_____tmd_____/.test(page);

export class ShopSearchAdapter {
  constructor(options = {}) {
    this.options = { runtimeDir: null, timeoutMs: 20000, ...options };
    // 页面/搜索请求与 MTOP 网关共享全局限速占坑（跨进程令牌桶）。
    this.minIntervalMs = Number(process.env.TAOBAO_MTOP_MIN_INTERVAL_MS) || 5000;
    this.jitterMs = Number(process.env.TAOBAO_MTOP_JITTER_MS) || 5000;
  }

  // 操作日志包装器：与 MtopAdapter.withLog 同构（旁路，写失败不影响查询）。
  async withLog(operation, params, fn) {
    const start = Date.now();
    const base = { t: start, ts: new Date(start).toISOString(), operation, params };
    try {
      const result = await fn();
      await appendOperationLog(this.options.runtimeDir, {
        ...base, ok: true, ms: Date.now() - start, data: result?.data ?? null,
      });
      return result;
    } catch (error) {
      await appendOperationLog(this.options.runtimeDir, {
        ...base, ok: false, ms: Date.now() - start,
        error: { code: error.code || 'SHOP_SEARCH_ERROR', message: error.message },
      });
      throw error;
    }
  }

  // 带 Cookie 的店铺域 GET：GBK 解码、Set-Cookie 回写、全局限速、请求日志。
  async fetchPage(url, { referer, signal, pace = true } = {}) {
    checkAbort(signal);
    const store = await loadCookies(this.options.runtimeDir);
    if (pace) await reserveSlot(this.options.runtimeDir, this.minIntervalMs, this.jitterMs, signal);
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: referer || 'https://www.taobao.com/',
    };
    const cookie = cookieHeader(store);
    if (cookie) headers.Cookie = cookie;
    const fetchSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), signal])
      : AbortSignal.timeout(this.options.timeoutMs);
    const started = Date.now();
    let response;
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: fetchSignal });
    } catch (error) {
      if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
      await appendRequestLog(this.options.runtimeDir, { t: started, ts: new Date(started).toISOString(), api: 'shop-page', ok: false, code: 'NETWORK_ERROR', url });
      throw new TaobaoError('NETWORK_ERROR', `店铺页请求失败：${error.message}`);
    }
    mergeSetCookies(store, response.headers.getSetCookie());
    await saveCookies(store, this.options.runtimeDir);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = GBK.decode(buffer);
    await appendRequestLog(this.options.runtimeDir, {
      t: started, ts: new Date(started).toISOString(), api: 'shop-page', ok: response.ok,
      http: response.status, ms: Date.now() - started, bytes: buffer.length, url,
    });
    return text;
  }

  // 单次 shopSearch 入口。keyword：中文/英文关键词；shopRef：parseShopRef 支持的任一形态。
  async shopSearch(keyword, shopRef, options = {}, signal) {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new TaobaoError('INVALID_ARGUMENT', '关键词不能为空。');
    const params = { page: 1, pages: 1, ...options };
    if (!Number.isInteger(params.page) || params.page < 1
      || !Number.isInteger(params.pages) || params.pages < 1 || params.pages > 20) {
      throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数，pages 为 1–20（页间隔走全局限速）。');
    }
    const shop = parseShopRef(shopRef);
    const query = gbkEncode(keyword.trim());
    return this.withLog('shop-search', { keyword: keyword.trim(), shop, page: params.page, pages: params.pages }, async () => {
      const cache = await loadWidCache(this.options.runtimeDir);
      const cached = cache[shop.host];
      let wid = cached?.wid || null;
      let widSource = cached ? 'cache' : null;
      let fontUrl = null;

      // 1) 店铺搜索页：提取 wid + 价格字体 URL。被墙且无缓存时才失败。
      try {
        const page = await this.fetchPage(`https://${shop.host}/search.htm?search=y`, { signal });
        if (isCaptcha(page)) throw new TaobaoError('RISK_CONTROL',
          '店铺页被淘宝风控拦截（TMD 滑块/验证码）。请在浏览器正常访问该店铺页一次后重试；HTTP 客户端不可解滑块。');
        if (isLoginWalled(page)) throw new TaobaoError('AUTH_REQUIRED',
          '店铺页返回登录跳转：登录 Cookie 失效。请在浏览器登录淘宝后执行 taobao sync-cookie。');
        wid = extractWid(page);
        fontUrl = extractFontUrl(page);
        if (wid) {
          widSource = 'page';
          cache[shop.host] = { wid, host: shop.host, resolvedAt: new Date().toISOString() };
          await saveWidCache(this.options.runtimeDir, cache);
        }
      } catch (error) {
        if (error.code === 'CANCELLED') throw error;
        // 降级：缓存里有 wid 就继续（价格解不出来置 null——混合策略）。
        if (!wid) throw error;
        widSource = 'cache-degraded';
      }

      // 2) 价格字体（CDN，不占限速）：同会话配对——页面现取字体 × 紧随的 asynSearch。
      let fontMap = null;
      if (fontUrl) {
        try {
          const fontRes = await fetch(fontUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          fontMap = parsePriceFontMap(Buffer.from(await fontRes.arrayBuffer()));
        } catch { /* 价格解码是增强项：失败置 null，不影响商品数据 */ }
      }

      // 3) asynSearch 逐页。命中 login 墙多半是 wid 失效（店铺改版）——清缓存提示重试。
      const items = [];
      let last = null;
      for (let offset = 0; offset < params.pages; offset++) {
        const pageNo = params.page + offset;
        const ts = Date.now();
        const url = `https://${shop.host}/i/asynSearch.htm?_ksTS=${ts}_1&callback=jsonp1&input_charset=gbk`
          + `&mid=w-${wid}-0&wid=${wid}&path=/search.htm&search=y&q=${query}`
          + `&s_from=newHeader&ssid=s5-e&search_type=item&sourceId=tb.item&qEncodeType=gbk&pageNo=${pageNo}`;
        const raw = await this.fetchPage(url, { signal, referer: `https://${shop.host}/search.htm` });
        if (isCaptcha(raw)) throw new TaobaoError('RISK_CONTROL',
          'asynSearch 被风控拦截（TMD 滑块）。等待几分钟后重试；已有部分页数据时本次结果不返回。');
        if (isLoginWalled(raw)) {
          if (cached?.wid && cache[shop.host]) {
            delete cache[shop.host];
            await saveWidCache(this.options.runtimeDir, cache);
          }
          throw new TaobaoError('SHOP_SEARCH_ERROR',
            `asynSearch 返回登录墙：wid（${wid}）校验未通过，可能店铺已改版导致挂件号变更。缓存已清除，请重试一次（将重新提取 wid）。`);
        }
        const body = parseJsonp(raw);
        if (!body) throw new TaobaoError('SHOP_SEARCH_ERROR', 'asynSearch 响应不是合法 JSONP，结构可能变化。');
        last = parseShopSearch(body, fontMap);
        if (!last.items.length) {
          // 非首页空页＝翻过了最后一页，正常收尾；首页空页＝关键词无结果。
          if (offset > 0 && items.length) break;
          throw new TaobaoError('NO_RESULTS', `店内搜索「${keyword.trim()}」无结果（第 ${pageNo} 页为空）。`);
        }
        items.push(...last.items);
        if (last.pages && pageNo >= last.pages) break;
        await delay(this.minIntervalMs, undefined, { signal }).catch(() => { throw new TaobaoError('CANCELLED', '任务已取消。'); });
      }

      return {
        data: {
          keyword: keyword.trim(),
          shop: { host: shop.host, shopId: shop.shopId || cached?.shopId || null, wid },
          page: params.page,
          pages: last?.pages ?? null,
          total: last?.total ?? null,
          items,
        },
        meta: {
          provider: 'shop-http', observedAt: new Date().toISOString(),
          widSource, priceDecoded: Boolean(fontMap),
        },
      };
    });
  }
}
