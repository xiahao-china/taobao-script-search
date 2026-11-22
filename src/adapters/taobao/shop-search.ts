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
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { TaobaoError, checkAbort, getErrorCode, getErrorMessage } from '../../core/errors.js';
import { runtimePaths } from '../../core/config.js';
import { loadCookies, saveCookies, mergeSetCookies, cookieHeader, cookieSummary } from '../../core/cookie-store.js';
import { reserveSlot, appendRequestLog, withOperationLog, parseEnvMs } from '../../core/mtop-client.js';
import { parsePriceFontMap, decodeEntities } from '../../core/shop-font.js';
import { gbkEncode } from '../../core/gbk.js';
import type {
  FetchLike,
  ParsedShopRef,
  ParsedShopSearchPage,
  ResponseLike,
  SdkResult,
  ShopRefInput,
  ShopSearchData,
  ShopSearchItem,
  ShopSearchOptions,
  WidSource,
} from '../../types.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GBK = new TextDecoder('gbk');

interface WidCacheEntry {
  wid: string;
  host: string;
  shopId?: string;
  resolvedAt: string;
}

type WidCache = Record<string, WidCacheEntry>;

// wid 缓存：挂件号只在店铺重新装修时变化，缓存后跳过页面提取。
// 价格字体映射会轮换，不在缓存范围（每次都随页面现取）。
function widCachePath(runtimeDir?: string | null): string {
  return join(runtimePaths(runtimeDir || undefined).directory, 'shop-wid.json');
}

async function loadWidCache(runtimeDir?: string | null): Promise<WidCache> {
  try { return JSON.parse(await readFile(widCachePath(runtimeDir), 'utf8')) as WidCache; }
  catch { return {}; }
}

async function saveWidCache(runtimeDir: string | null | undefined, cache: WidCache): Promise<void> {
  const path = widCachePath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(cache, null, 2) + '\n';
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(temp, payload);
  try { await rename(temp, path); }
  catch {
    await writeFile(path, payload).catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

// 店铺引用解析：支持 数字 shopId / 店铺任意页 URL / {shopId, shopUrl} 对象。
// 昵称子域名（youxin-electronic.taobao.com）与数值子域名（shop131282813…）
// 均可用——asynSearch 挂在任意有效店铺子域名下。
export function parseShopRef(ref: ShopRefInput): ParsedShopRef {
  const fail = () => new TaobaoError('INVALID_ARGUMENT',
    '店铺引用无法解析。支持：店铺 URL（如 https://shop123.taobao.com 或昵称子域名页）、数字 shopId。');
  let raw: string | null = null;
  if (ref && typeof ref === 'object') {
    raw = ref.shopUrl || ref.url || (ref.shopId ? `shop${ref.shopId}.taobao.com` : null);
  } else {
    raw = ref;
  }
  const text = String(raw || '').trim();
  if (/^\d{6,}$/.test(text)) return { shopId: text, host: `shop${text}.taobao.com` };
  if (!/^https?:\/\//i.test(text) && !/^[a-z0-9-]+\.taobao\.com/i.test(text)) throw fail();
  let url: URL;
  try { url = new URL(/^https?:/i.test(text) ? text : `https://${text}`); }
  catch { throw fail(); }
  if (!/(?:^|\.)taobao\.com$|(?:^|\.)tmall\.com$/i.test(url.hostname)) throw fail();
  const shopId = url.hostname.match(/^shop(\d+)\./i)?.[1] || null;
  return { shopId, host: url.hostname };
}

// wid 提取：首选页面内嵌 asynSearch URL（多处出现、值一致、不依赖中文标签）；
// 兜底取「asynSearch : true」模块注释前最近的 data-widgetid。
export function extractWid(page: string): string | null {
  const match = page.match(/\/i\/asynSearch\.htm[^"']{0,600}?wid=(\d+)/);
  if (!match?.[1]) {
    const anchor = page.indexOf('asynSearch : true');
    if (anchor > 0) {
      const segment = page.slice(Math.max(0, anchor - 2000), anchor);
      const ids = [...segment.matchAll(/data-widgetid="(\d+)"/g)];
      const lastId = ids[ids.length - 1]?.[1];
      if (lastId) return lastId;
    }
    return null;
  }
  return match[1];
}

// 字体 URL：search.htm @font-face 里的 AlibabaSans102CustomFont src（CDN 免登录）。
export function extractFontUrl(page: string): string | null {
  const match = page.match(/AlibabaSans102CustomFont';\s*src:\s*url\('([^']+)'\)/)
    || page.match(/@font-face[^}]*?src:\s*url\('([^']+\.woff[^']*)'\)/s);
  const url = match?.[1];
  if (!url) return null;
  return url.startsWith('//') ? `https:${url}` : url;
}

const decodeHtmlText = (value: string): string => value
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// 商品块解析：按 <dl data-id> 切块，每块取 item-name/图片/销量/价格实体。
// 价格实体依赖字体映射还原：存在价格实体但无字体映射或全部解为 '?' 时，
// 统一返回 priceText=null 且 priceUnknown=true（混合策略，绝不臆造或透传 "????"）。
export function parseShopSearch(body: string, fontMap: ReadonlyMap<number, string> | null): ParsedShopSearchPage {
  const parts = body.split(/<dl[^>]*data-id="(\d+)"/);
  const items: ShopSearchItem[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const itemId = parts[i];
    const segment = parts[i + 1];
    if (!itemId || segment === undefined) continue;
    const chunk = segment.split('</dl>')[0] ?? '';
    const title = chunk.match(/class="item-name[^"]*"[^>]*>([^<]+)</)?.[1];
    const image = chunk.match(/<img[^>]*src="([^"]+)"/)?.[1];
    const href = chunk.match(/href="([^"]*item\.htm\?id=\d+[^"]*)"/)?.[1];
    const sales = chunk.match(/class="sale-num"[^>]*>([^<]+)</)?.[1];
    const priceRaw = chunk.match(/class="c-price[^"]*"[^>]*>([^<]+)</)?.[1];
    const strikeRaw = chunk.match(/class="s-price[^"]*"[^>]*>([^<]+)</)?.[1];
    const rawDecodedPrice = priceRaw && fontMap ? decodeEntities(priceRaw, fontMap) : null;
    const priceAllUnknown = Boolean(priceRaw && (!fontMap || !rawDecodedPrice || /^\?+$/.test(rawDecodedPrice)));
    const priceText = priceAllUnknown ? null : rawDecodedPrice;
    const rawDecodedStrike = strikeRaw && fontMap ? decodeEntities(strikeRaw, fontMap) : null;
    const strikethroughText = rawDecodedStrike && !/^\?+$/.test(rawDecodedStrike) ? rawDecodedStrike : null;
    items.push({
      itemId,
      title: title ? decodeHtmlText(title) : null,
      priceText,
      strikethroughText,
      priceUnknown: priceAllUnknown,
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
export function parseJsonp(raw: string): string | null {
  const match = raw.match(/^\s*jsonp\d+\("(.*)"\)\s*$/s);
  if (!match?.[1]) return null;
  return JSON.parse(`"${match[1]}"`) as string;
}

// 被 login 跳转/TMD 滑块接管的响应判定：均无商品数据。
const isLoginWalled = (page: string): boolean => /login\.htm/.test(page) && !/data-id="\d+"/.test(page);
const isCaptcha = (page: string): boolean => /_____tmd_____/.test(page);

export interface ShopSearchAdapterOptions {
  runtimeDir?: string | null;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export class ShopSearchAdapter {
  readonly options: { runtimeDir: string | null; timeoutMs: number };
  minIntervalMs: number;
  jitterMs: number;
  readonly fetch: FetchLike;

  constructor(options: ShopSearchAdapterOptions = {}) {
    this.options = { runtimeDir: null, timeoutMs: 20000, ...options };
    // 页面/搜索请求与 MTOP 网关共享全局限速占坑（跨进程令牌桶）。
    this.minIntervalMs = parseEnvMs(process.env.TAOBAO_MTOP_MIN_INTERVAL_MS, 5000);
    this.jitterMs = parseEnvMs(process.env.TAOBAO_MTOP_JITTER_MS, 5000);
    this.fetch = options.fetch || (globalThis.fetch as unknown as FetchLike);
  }

  // 操作日志包装器：与 MtopAdapter.withLog 同构（旁路，写失败不影响查询）。
  async withLog<T extends { data?: unknown }>(operation: string, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return withOperationLog(this.options.runtimeDir, operation, params, 'SHOP_SEARCH_ERROR', fn);
  }

  // 带 Cookie 的店铺域 GET：GBK 解码、Set-Cookie 回写、全局限速、请求日志。
  async fetchPage(url: string, { referer, signal, pace = true }: { referer?: string; signal?: AbortSignal; pace?: boolean } = {}): Promise<string> {
    checkAbort(signal);
    const store = await loadCookies(this.options.runtimeDir);
    const summary = cookieSummary(store);
    const waitStart = Date.now();
    if (pace) await reserveSlot(this.options.runtimeDir, this.minIntervalMs, this.jitterMs, signal);
    const waitMs = Date.now() - waitStart;
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: referer || 'https://www.taobao.com/',
    };
    const cookie = cookieHeader(store);
    if (cookie) headers.Cookie = cookie;
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const fetchSignal = signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, signal]) : signal)
      : timeoutSignal;
    const started = Date.now();
    let response: ResponseLike;
    try {
      response = await this.fetch(url, { headers, redirect: 'manual', signal: fetchSignal });
    } catch (error: unknown) {
      if (signal?.aborted) {
        await appendRequestLog(this.options.runtimeDir, {
          t: started, ts: new Date(started).toISOString(), api: 'shop-page',
          cookieCount: summary.total, hasLogin: summary.hasLoginState,
          waitMs, ms: Date.now() - started, ok: false, code: 'CANCELLED', url,
        });
        throw new TaobaoError('CANCELLED', '任务已取消。');
      }
      await appendRequestLog(this.options.runtimeDir, {
        t: started, ts: new Date(started).toISOString(), api: 'shop-page',
        cookieCount: summary.total, hasLogin: summary.hasLoginState,
        waitMs, ms: Date.now() - started, ok: false, code: 'NETWORK_ERROR', url,
      });
      throw new TaobaoError('NETWORK_ERROR', `店铺页请求失败：${getErrorMessage(error)}`);
    }
    mergeSetCookies(store, response.headers.getSetCookie());
    await saveCookies(store, this.options.runtimeDir);
    const buf = response.arrayBuffer ? await response.arrayBuffer() : new ArrayBuffer(0);
    const buffer = Buffer.from(buf);
    const text = GBK.decode(buffer);
    const location = response.headers.get?.('location') || '';
    const captchaHit = isCaptcha(text) || /_____tmd_____|punish/i.test(location);
    const loginHit = !captchaHit && (isLoginWalled(text) || /login\.taobao\.com|login\.htm/i.test(location));
    await appendRequestLog(this.options.runtimeDir, {
      t: started, ts: new Date(started).toISOString(), api: 'shop-page',
      cookieCount: summary.total, hasLogin: summary.hasLoginState,
      waitMs, ms: Date.now() - started, bytes: buffer.length, http: response.status,
      ...(location ? { location } : {}),
      ok: response.ok && !captchaHit && !loginHit,
      ...(captchaHit ? { code: 'RISK_CONTROL' } : loginHit ? { code: 'LOGIN_WALLED' } : {}),
      url,
    });
    if (response.status >= 300 && response.status < 400 && location) {
      if (captchaHit) {
        throw new TaobaoError('RISK_CONTROL', '店铺页被风控跳转至验证页（TMD/punish）。请在浏览器访问后重试。');
      }
      if (loginHit) {
        throw new TaobaoError('AUTH_REQUIRED', '店铺页 302 跳转登录页：登录 Cookie 失效，请更新 cookie.json 后重试。');
      }
      throw new TaobaoError('SHOP_SEARCH_ERROR',
        `店铺页返回 HTTP ${response.status} 重定向至 ${location}（天猫店或已迁移域名暂不支持淘宝 C 店 asynSearch 通道）。`);
    }
    return text;
  }

  // 单次 shopSearch 入口。keyword：中文/英文关键词；shopRef：parseShopRef 支持的任一形态。
  async shopSearch(
    keyword: string,
    shopRef: ShopRefInput,
    options: ShopSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<SdkResult<ShopSearchData>> {
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
      let wid: string | null = cached?.wid || null;
      let widSource: WidSource = cached ? 'cache' : null;
      let fontUrl: string | null = null;

      // 1) 店铺搜索页：提取 wid + 价格字体 URL。被墙且无缓存时才失败。
      try {
        const page = await this.fetchPage(`https://${shop.host}/search.htm?search=y`, { signal });
        if (isCaptcha(page)) throw new TaobaoError('RISK_CONTROL',
          '店铺页被淘宝风控拦截（TMD 滑块/验证码）。请在浏览器正常访问该店铺页一次后重试；HTTP 客户端不可解滑块。');
        if (isLoginWalled(page)) throw new TaobaoError('AUTH_REQUIRED',
          '店铺页返回登录跳转：登录 Cookie 失效。请在浏览器登录淘宝后执行 taobao sync-cookie。');
        const extractedWid = extractWid(page);
        fontUrl = extractFontUrl(page);
        if (extractedWid) {
          wid = extractedWid;
          widSource = 'page';
          cache[shop.host] = { wid, host: shop.host, resolvedAt: new Date().toISOString() };
          await saveWidCache(this.options.runtimeDir, cache);
        } else if (!wid) {
          throw new TaobaoError('SHOP_SEARCH_ERROR', '店铺页未找到挂件号（wid），可能店铺结构已改版。');
        } else {
          widSource = 'cache-degraded';
        }
      } catch (error: unknown) {
        if (getErrorCode(error) === 'CANCELLED') throw error;
        // 降级：缓存里有 wid 就继续（价格解不出来置 null——混合策略）。
        if (!wid) throw error;
        widSource = 'cache-degraded';
      }

      // 2) 价格字体（CDN，不占限速）：同会话配对——页面现取字体 × 紧随的 asynSearch。
      let fontMap: Map<number, string> | null = null;
      if (fontUrl) {
        try {
          const fontRes = await this.fetch(fontUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          const fontBuf = fontRes.arrayBuffer ? await fontRes.arrayBuffer() : new ArrayBuffer(0);
          fontMap = parsePriceFontMap(Buffer.from(fontBuf));
        } catch { /* 价格解码是增强项：失败置 null，不影响商品数据 */ }
      }

      // 3) asynSearch 逐页。命中 login 墙多半是 wid 失效（店铺改版）——清缓存提示重试。
      const items: ShopSearchItem[] = [];
      let last: ParsedShopSearchPage | null = null;
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
          if (cache[shop.host]) {
            delete cache[shop.host];
            await saveWidCache(this.options.runtimeDir, cache);
          }
          if (widSource === 'page') {
            throw new TaobaoError('AUTH_REQUIRED',
              `刚从店铺页提取的 wid（${wid}）仍被 asynSearch 跳转登录页：登录态 Cookie 可能失效或不完整，请更新 cookie.json 后重试。`);
          }
          throw new TaobaoError('SHOP_SEARCH_ERROR',
            `asynSearch 返回登录墙：缓存 wid（${wid}）校验未通过，可能店铺已改版导致挂件号变更。缓存已清除，请重试一次（将重新提取 wid）。`);
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
