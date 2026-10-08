import { detectAuth } from './dom/auth.js';
import { readSearch } from './dom/search.js';
import { readDetail, readEmbedded } from './dom/detail.js';
import { checkAbort, TaobaoError } from '../../core/errors.js';

const installed = new WeakSet();
const installer = `window.__taobaoScriptSearch = { auth: ${detectAuth.toString()}, search: ${readSearch.toString()}, detail: ${readDetail.toString()}, embedded: ${readEmbedded.toString()} };`;

export async function install(page) {
  if (!installed.has(page)) { await page.addInitScript({ content: installer }); installed.add(page); }
  await page.evaluate(installer);
}

export async function snapshot(page, kind, args = {}) {
  try { return await page.evaluate(({ kind, args }) => window.__taobaoScriptSearch[kind](args), { kind, args }); }
  catch (error) {
    if (/Execution context was destroyed|Cannot find context|__taobaoScriptSearch/.test(error.message)) return { status: 'loading' };
    throw error;
  }
}

export async function waitForData(page, kind, args, predicate, timeoutMs, signal) {
  checkAbort(signal);
  const handle = await page.waitForFunction(({ kind, args, predicate }) => {
    const value = window.__taobaoScriptSearch?.[kind](args);
    if (!value) return false;
    if (['needs_login', 'needs_verification', 'wrong_page', 'item_unavailable', 'no_results'].includes(value.status)) return value;
    if (value.status !== 'ok') return false;
    if (predicate === 'price' && !value.priceReady) return false;
    return value;
  }, { kind, args, predicate }, { polling: 100, timeout: Math.max(1, Math.min(timeoutMs, 1000)) });
  try { checkAbort(signal); return await handle.jsonValue(); } finally { await handle.dispose(); }
}

export async function waitForManual(page, options, onEvent, signal) {
  const start = performance.now();
  let previous = null;
  while (true) {
    checkAbort(signal);
    const state = await page.evaluate(() => window.__taobaoScriptSearch ? window.__taobaoScriptSearch.auth() : 'loading').catch(error => {
      if (page.isClosed()) throw error;
      return 'loading';
    });
    if (!state) {
      onEvent({ state: 'running', message: '登录/验证页面已结束，恢复原任务。' });
      return Math.round(performance.now() - start);
    }
    if (state !== 'loading' && state !== previous) {
      onEvent({ state, message: state === 'needs_login' ? '请在日常 Chrome 完成淘宝登录，任务会自动继续。' : '请在 Chrome 完成页面验证，任务会自动继续。' });
      previous = state;
    }
    if (!options.waitForLogin || (options.manualTimeoutMs && performance.now() - start >= options.manualTimeoutMs)) {
      throw new TaobaoError(previous === 'needs_login' ? 'AUTH_REQUIRED' : 'VERIFICATION_REQUIRED', '等待人工登录或验证未完成。');
    }
    try {
      const remaining = options.manualTimeoutMs ? options.manualTimeoutMs - (performance.now() - start) : 1000;
      await page.waitForFunction(() => Boolean(window.__taobaoScriptSearch) && !window.__taobaoScriptSearch.auth(), null, { polling: 100, timeout: Math.max(1, Math.min(1000, remaining)) });
    } catch (error) { if (page.isClosed()) throw error; }
  }
}

export async function navigate(page, url, timeoutMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); return; }
    catch (error) {
      if (!/interrupted by another navigation/.test(error.message) || attempt === 2) throw error;
      // "Interrupted" usually means Taobao redirected us to a verification or
      // login page. Retrying goto fights the rate limiter and is what makes the
      // tab visibly jump around; land the redirect instead and hand a manual
      // page back to the caller, whose wait loop knows how to pause on it.
      await page.waitForTimeout(400).catch(() => {});
      const hijacked = await page.evaluate(() => window.__taobaoScriptSearch ? window.__taobaoScriptSearch.auth() : null).catch(() => null);
      if (hijacked) return;
    }
  }
}
