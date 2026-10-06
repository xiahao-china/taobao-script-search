import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TaobaoError } from '../core/errors.js';

export function validateEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TaobaoError('INVALID_ARGUMENT', 'CDP 地址无效。'); }
  if (!['ws:', 'http:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new TaobaoError('INVALID_ARGUMENT', 'CDP 仅支持本机 localhost / 127.0.0.1 / ::1。');
  }
  return endpoint;
}

export async function discoverEndpoint(userDataDir) {
  const directory = userDataDir || join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  let text;
  try { text = await readFile(join(directory, 'DevToolsActivePort'), 'utf8'); }
  catch { throw new TaobaoError('CHROME_DEBUGGING_REQUIRED', '请在日常 Chrome 打开 chrome://inspect/#remote-debugging，勾选允许远程调试；连接提示出现时点“允许”。'); }
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^\d+$/.test(lines[0]) || Number(lines[0]) < 1 || Number(lines[0]) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(lines[1])) {
    throw new TaobaoError('INVALID_ARGUMENT', 'Chrome 的 DevToolsActivePort 内容无效。');
  }
  return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
}

export class BrowserSession {
  constructor(options, onEvent = () => {}) {
    this.options = options;
    this.onEvent = onEvent;
    this.browser = null;
    this.context = null;
    this.connecting = null;
    this.searchPage = null;
    this.products = new Map();
    this.connections = 0;
  }

  async connect() {
    if (this.browser?.isConnected()) return this.context;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const endpoint = validateEndpoint(this.options.cdpUrl || await this.endpoint());
      this.onEvent({ state: 'connecting', message: '正在连接日常 Chrome；首次提示请点“允许”。后续任务复用常驻连接。' });
      this.browser = await chromium.connectOverCDP(endpoint, {
        noDefaults: true, timeout: this.options.approvalTimeoutMs,
      });
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new TaobaoError('BROWSER_ERROR', 'Chrome 没有可复用的默认浏览器配置。');
      this.connections += 1;
      this.searchPage = null;
      this.products.clear();
      this.onEvent({ state: 'connected', message: '日常 Chrome 已连接。' });
      return this.context;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async endpoint() {
    const bundled = process.env.TAOBAO_SEARCH_BUNDLED_CHROMIUM;
    const installed = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).some(folder => existsSync(join(folder, 'Google/Chrome/Application/chrome.exe')));
    if (!bundled || (!this.options.portableBrowser && (installed || this.options.userDataDir))) {
      if (this.options.portableBrowser && !bundled) throw new TaobaoError('BROWSER_NOT_FOUND', '--portable-browser 仅在自包含发布包中可用。');
      return discoverEndpoint(this.options.userDataDir);
    }
    const profile = join(process.env.TAOBAO_SEARCH_CACHE_DIR || join(process.env.LOCALAPPDATA, 'TaobaoSearch'), 'browser-profile');
    try {
      const existing = await discoverEndpoint(profile);
      const response = await fetch(`http://127.0.0.1:${new URL(existing).port}/json/version`, { signal: AbortSignal.timeout(1000) });
      const published = response.ok ? await response.json() : null;
      if (published?.webSocketDebuggerUrl === existing) return existing;
    } catch { /* A closed/crashed browser can leave a stale port file. */ }
    this.onEvent({ state: 'connecting', message: '正在启动包内便携浏览器；首次使用请在该浏览器登录淘宝。' });
    const child = spawn(bundled, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, windowsHide: true, stdio: 'ignore' });
    let launchError;
    child.on('error', error => { launchError = error; });
    child.unref();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (launchError) throw new TaobaoError('BROWSER_NOT_FOUND', launchError.message);
      try {
        const endpoint = await discoverEndpoint(profile);
        const response = await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).webSocketDebuggerUrl === endpoint) return endpoint;
      } catch { /* Port file may still refer to the previous process. */ }
      await delay(100);
    }
    throw new TaobaoError('BROWSER_START_FAILED', '包内浏览器未发布调试端口。');
  }

  async getSearchPage() {
    const context = await this.connect();
    if (!this.searchPage || this.searchPage.isClosed()) this.searchPage = await context.newPage();
    return this.searchPage;
  }

  async getProductPage(itemId) {
    const context = await this.connect();
    let page = this.products.get(itemId);
    if (page?.isClosed()) { this.products.delete(itemId); page = null; }
    if (!page) {
      if (this.products.size >= this.options.maxProductTabs) {
        const [oldId, oldPage] = this.products.entries().next().value;
        this.products.delete(oldId);
        await oldPage.close().catch(() => {});
      }
      page = await context.newPage();
    }
    this.products.delete(itemId);
    this.products.set(itemId, page);
    return page;
  }

  status() {
    return { connected: Boolean(this.browser?.isConnected()), connections: this.connections, productTabs: this.products.size };
  }

  async close() {
    // For a connectOverCDP browser, close disconnects this client transport.
    // Never close the user's default BrowserContext or existing tabs.
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
  }
}
