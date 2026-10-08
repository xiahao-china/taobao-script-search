import { requireId, checkAbort, TaobaoError } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { install, navigate, snapshot, waitForData, waitForManual } from './page.js';
import { buildSpecs, publicSpecs, resolveSpec, extractCatalog, parseJson, skuPrice } from './specs.js';

function isItemPage(url, itemId) {
  try { const parsed = new URL(url); return ['item.taobao.com', 'detail.tmall.com', 'detail.tmall.hk'].includes(parsed.hostname) && parsed.searchParams.get('id') === itemId; }
  catch { return false; }
}

export class DetailAdapter {
  constructor(session, options, onEvent) {
    Object.assign(this, { session, options, onEvent });
    this.states = new WeakMap();
    this.urls = new Map();
    this.navigations = 0;
  }

  remember(items) { for (const item of items) this.urls.set(item.itemId, item.url); }

  attach(page, itemId) {
    let state = this.states.get(page);
    if (state) return state;
    state = { catalog: {}, observedAt: null, openedAt: 0 };
    this.states.set(page, state);
    page.on('response', async response => {
      try {
        const url = new URL(response.url());
        if (!/(^|\.)(taobao|tmall)\.com$/.test(url.hostname) || !/\/h5\/.*(?:detail|sku)/i.test(url.pathname)) return;
        const raw = parseJson(await response.text());
        if (!raw || (raw.ret && !raw.ret.some(value => String(value).startsWith('SUCCESS')))) return;
        const catalog = extractCatalog(raw);
        let requestId;
        const data = url.searchParams.get('data') || new URLSearchParams(response.request().postData() || '').get('data');
        if (data) { const params = parseJson(data) || parseJson(decodeURIComponent(data)); requestId = String(params?.id || params?.itemId || ''); }
        if ((catalog.itemId || requestId) !== itemId || (!catalog.skuBase && !catalog.skuCore)) return;
        state.catalog = { ...state.catalog, ...(catalog.skuBase ? { skuBase: catalog.skuBase } : {}), ...(catalog.skuCore ? { skuCore: catalog.skuCore } : {}) };
        state.observedAt = new Date().toISOString();
      } catch { /* Non-JSON and unrelated responses do not become product data. */ }
    });
    return state;
  }

  async open(itemId, options, signal) {
    requireId(itemId);
    const page = await this.session.getProductPage(itemId);
    await page.bringToFront();
    await install(page);
    const state = this.attach(page, itemId);
    const target = this.urls.get(itemId) || `https://item.taobao.com/item.htm?id=${itemId}`;
    const aged = state.openedAt && Date.now() - state.openedAt > (this.options.cacheTtlMs || 60000);
    if (!isItemPage(page.url(), itemId) || options.refreshPage || (aged && !options.reuseSnapshot)) {
      state.catalog = {};
      state.observedAt = null;
      this.navigations += 1;
      await navigate(page, target, this.options.timeoutMs);
      state.openedAt = Date.now();
    }
    let deadline = performance.now() + this.options.timeoutMs, manualWaitMs = 0;
    while (performance.now() < deadline) {
      checkAbort(signal);
      const embedded = await snapshot(page, 'embedded');
      if (embedded?.skuBase && (!embedded.itemId || embedded.itemId === itemId)) {
        state.catalog = { ...state.catalog, ...embedded };
        state.observedAt ||= new Date().toISOString();
      }
      let dom;
      try { dom = await waitForData(page, 'detail', { itemId, singleVariant: state.catalog.skuBase?.props?.length === 0 && state.catalog.skuBase?.skus?.length === 1 }, 'ready', deadline - performance.now(), signal); }
      catch (error) { if (error.name === 'TimeoutError') continue; throw error; }
      if (['needs_login', 'needs_verification'].includes(dom.status)) {
        manualWaitMs += await waitForManual(page, this.options, this.onEvent, signal);
        // Clearing the wall often restores the product page by itself; a fresh
        // navigation inside the sensitive window re-triggers it. Reuse the
        // current page when it already shows the target item.
        const resumed = await snapshot(page, 'detail', { itemId, singleVariant: state.catalog.skuBase?.props?.length === 0 && state.catalog.skuBase?.skus?.length === 1 }).catch(() => null);
        // A wall that re-appeared goes back into the wait loop; navigating
        // during the sensitive window is what re-triggers it.
        const walled = ['needs_login', 'needs_verification'].includes(resumed?.status);
        if (!walled && resumed?.status !== 'ok' && !isItemPage(page.url(), itemId)) {
          this.navigations += 1;
          await navigate(page, target, this.options.timeoutMs);
          state.catalog = {}; state.observedAt = null;
        }
        state.openedAt = Date.now();
        // Manual waiting does not consume the data budget.
        deadline = performance.now() + this.options.timeoutMs;
        continue;
      }
      if (dom.status === 'wrong_page') { this.navigations += 1; await navigate(page, target, this.options.timeoutMs); continue; }
      if (dom.status === 'item_unavailable') throw new TaobaoError('ITEM_UNAVAILABLE', '商品已失效或不存在。');
      const specs = buildSpecs(itemId, dom, state.catalog);
      return { page, dom, state, specs, manualWaitMs };
    }
    throw new TaobaoError('DATA_TIMEOUT', '未等到商品规格面板，请检查登录状态或页面适配器。');
  }

  async getSpecs(itemId, options = {}, signal) {
    const { specs, manualWaitMs } = await this.open(itemId, options, signal);
    return { data: publicSpecs(specs), meta: { provider: 'playwright', observedAt: new Date().toISOString(), manualWaitMs } };
  }

  async getDetail(itemId, spec, options = {}, signal) {
    let manualWaitMs = 0;
    for (let recovery = 0; recovery < 3; recovery++) {
      const opened = await this.open(itemId, { ...options, refreshPage: recovery === 0 && options.refreshPage }, signal);
      manualWaitMs += opened.manualWaitMs;
      const { page, state, specs, dom } = opened;
      const selection = resolveSpec(specs, spec);
      const beforePriceFingerprint = dom.priceFingerprint;
      let changed = false;
      for (const value of selection.expected) {
        checkAbort(signal);
        if (dom.selected.some(selected => selected.groupIndex === value.groupIndex && selected.valueIndex === value.valueIndex)) continue;
        // Use the exact visible label, as React may replace nodes and drop
        // diagnostic attributes between snapshot and click.
        const choice = page.getByText(value.label, { exact: true }).first();
        try { await choice.click({ timeout: this.options.timeoutMs }); }
        catch (error) {
          const hints = String(error.message).split('Call log:')[1]?.split('\n').filter(line => /not visible|not stable|intercepts pointer|outside of the viewport|not enabled/.test(line)).slice(-4).map(line => line.trim()) || [];
          throw new TaobaoError('SKU_SELECTION_FAILED', `未能选中规格：${value.label}`, { hints });
        }
        changed = true;
      }
      const deadline = performance.now() + this.options.timeoutMs;
      let retry = false;
      while (performance.now() < deadline) {
        checkAbort(signal);
        const boundPrice = skuPrice(state.catalog, selection.skuId);
        let value;
        try {
          value = await waitForData(page, 'detail', {
            itemId, expected: selection.expected, skuId: selection.skuId,
            beforePriceFingerprint, selectionChanged: changed, hasBoundPrice: Boolean(boundPrice),
            singleVariant: specs.mode === 'single-variant',
          }, 'price', deadline - performance.now(), signal);
        } catch (error) { if (error.name === 'TimeoutError') continue; throw error; }
        if (['needs_login', 'needs_verification'].includes(value.status)) {
          manualWaitMs += await waitForManual(page, this.options, this.onEvent, signal);
          retry = true; break;
        }
        if (value.status === 'wrong_page') { retry = true; break; }
        if (value.status === 'item_unavailable') throw new TaobaoError('ITEM_UNAVAILABLE', '商品不可用。');
        const currentBoundPrice = skuPrice(state.catalog, selection.skuId);
        const price = currentBoundPrice || parsePrice(value.priceTexts);
        if (!price) continue;
        const observedAt = currentBoundPrice ? state.observedAt : new Date().toISOString();
        return {
          data: {
            itemId, specId: selection.specId, skuId: selection.skuId,
            specLabel: selection.label, selections: selection.selections,
            title: value.title, url: page.url(), shopName: value.shopName,
            price: { amount: price.amount, currency: price.currency, basis: price.basis, display: price.display, scope: 'selected-spec', observedAt },
            stock: currentBoundPrice?.stock ?? null, shipping: value.shipping,
            attributes: value.attributes.length ? value.attributes : null,
            description: value.description, imageUrls: value.imageUrls,
            selectedLabels: value.selected.map(value => value.label),
          },
          meta: { provider: currentBoundPrice ? 'playwright-network-sku' : 'playwright-dom', observedAt, manualWaitMs, priceEvidence: currentBoundPrice ? 'sku-id-map' : changed ? 'selection-and-price-update' : 'already-selected', coverage: { stock: currentBoundPrice?.stock != null, shipping: value.shipping != null, attributes: value.attributes.length > 0, description: value.description != null } },
        };
      }
      if (!retry) throw new TaobaoError('SKU_PRICE_UNCONFIRMED', '规格已选择，但没有确认对应价格更新；不会返回上一个规格的价格。若两个规格同价且无 SKU 绑定数据，需要页面提供可核验的更新信号。');
    }
    throw new TaobaoError('DATA_TIMEOUT', '登录/跳转后未能恢复指定商品和规格。');
  }
}
