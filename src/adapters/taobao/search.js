import { randomUUID } from 'node:crypto';
import { TaobaoError, checkAbort } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { install, navigate, snapshot, waitForData, waitForManual } from './page.js';

const sorts = { default: '', 'price-asc': 'price-asc', 'price-desc': 'price-desc', sales: 'sale-desc' };

export function searchUrl(keyword, { page = 1, sort = 'default' } = {}) {
  const url = new URL('https://s.taobao.com/search');
  url.search = new URLSearchParams({ q: keyword, page: String(page), tab: 'all', ie: 'utf8', ...(sorts[sort] ? { sort: sorts[sort] } : {}) }).toString();
  return url.href;
}

export class SearchAdapter {
  constructor(session, options, onEvent) { Object.assign(this, { session, options, onEvent }); }

  async search(keyword, options = {}, signal) {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new TaobaoError('INVALID_ARGUMENT', '关键词不能为空。');
    keyword = keyword.trim();
    const params = { page: 1, limit: 20, sort: 'default', ...options };
    if (!Number.isInteger(params.page) || params.page < 1 || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 48 || !(params.sort in sorts)) throw new TaobaoError('INVALID_ARGUMENT', 'page 须为正整数，limit 为 1–48，sort 为 default/price-asc/price-desc/sales。');
    const page = await this.session.getSearchPage();
    await page.bringToFront();
    await install(page);
    const target = searchUrl(keyword, params);
    await navigate(page, target, this.options.timeoutMs);
    let deadline = performance.now() + this.options.timeoutMs, manualWaitMs = 0;
    const args = { ...params, keyword, nonce: randomUUID() };
    while (performance.now() < deadline) {
      checkAbort(signal);
      let value;
      try { value = await waitForData(page, 'search', args, 'ready', deadline - performance.now(), signal); }
      catch (error) { if (error.name === 'TimeoutError') continue; throw error; }
      if (['needs_login', 'needs_verification'].includes(value.status)) {
        manualWaitMs += await waitForManual(page, this.options, this.onEvent, signal);
        // Taobao usually restores the result page by itself once the wall is
        // cleared. Navigating again right away fires a request during the
        // post-verification sensitive window, re-triggers the wall, and is the
        // visible "page jumping" loop. Read the current page first; only leave
        // for the target URL when the resume did not land there.
        const resumed = await snapshot(page, 'search', args).catch(() => null);
        if (resumed?.status !== 'ok') await navigate(page, target, this.options.timeoutMs);
        // The manual wait must not eat into the data budget: a slow human slide
        // would otherwise leave no time to read the restored page.
        deadline = performance.now() + this.options.timeoutMs;
        continue;
      }
      if (value.status === 'wrong_page') { await navigate(page, target, this.options.timeoutMs); continue; }
      return {
        data: { keyword, page: params.page, sort: params.sort, items: value.items.map(item => ({ ...item, priceSummary: { ...(parsePrice([item.priceText]) || { amount: null, display: item.priceText }), scope: 'item-summary' } })), total: null },
        meta: { provider: 'playwright-dom', observedAt: new Date().toISOString(), manualWaitMs },
      };
    }
    throw new TaobaoError('DATA_TIMEOUT', '未等到符合查询条件的商品列表；页面可能变化或尚未加载。');
  }
}
