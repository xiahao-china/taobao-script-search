import { readFile, writeFile, rename, rm, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { projectRoot, runtimePaths } from './config.js';
import type { CookieEntry, CookieStore, CookieSummary } from '../types.js';

// MTOP H5 网关只挂 .taobao.com 域；tmall 域 Cookie 不发送，减少指纹噪音。
const TAOBAO_DOMAIN = /(?:^|\.)taobao\.com$/i;

export function cookieStorePath(runtimeDir?: string | null): string {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-cookies.json');
}

// 根目录 cookie.json：面向使用者的显式配置（模板见 cookie.example.json），**只读**——
// 程序从不覆写它，令牌续签与 sync-cookie 全部落到 .runtime 运行时缓存。
// 支持三种格式：
//   简单格式：{"cookie": "name=value; name2=value2"}
//   扁平格式：{"cookies": {"name": "value", ...}}
//   内部格式：{"cookies": {"name": {"value": "...", "domain": "...", "expires": ...}}}
// 加载规则：主配置存在时以其为登录态基准：
//   1) 令牌键（_m_h5_tk/_m_h5_tk_enc）用 .runtime 里的未过期续签值覆盖——那两个键是网关临时下发的，配置文件里的永远更旧；
//   2) 设备指纹键（cna）仅在主配置缺失或过期时从 .runtime 补入——避免每次进程启动都重新访问主页换新指纹。
// 可用环境变量 TAOBAO_COOKIE_FILE 指定其他主配置路径（测试与多账号场景用，显式指定即独占）。
const TOKEN_KEYS = ['_m_h5_tk', '_m_h5_tk_enc'] as const;
const WARM_KEYS = ['cna'] as const;

export function rootCookiePath(): string {
  return process.env.TAOBAO_COOKIE_FILE
    || join(projectRoot, 'cookie.json');
}

function normalizeCookieMap(rawCookies: Record<string, unknown>): Record<string, CookieEntry> {
  const cookies: Record<string, CookieEntry> = {};
  for (const [rawName, entry] of Object.entries(rawCookies)) {
    const name = String(rawName || '').trim();
    if (!name || entry == null) continue;
    // 兼容扁平键值格式 {"cookies": {"unb": "123", ...}} 与内部对象格式 {"cookies": {"unb": {"value": "123", ...}}}
    if (typeof entry === 'string') {
      if (entry) cookies[name] = { value: entry, domain: '.taobao.com', expires: -1 };
      continue;
    }
    if (typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.value === 'string' && rec.value !== '') {
        cookies[name] = {
          value: rec.value,
          domain: typeof rec.domain === 'string' && rec.domain ? rec.domain : '.taobao.com',
          expires: typeof rec.expires === 'number' ? rec.expires : -1,
        };
      }
    }
  }
  return cookies;
}

function storeFromRaw(raw: unknown): CookieStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.cookie === 'string' && obj.cookie.trim()) {
    const store: CookieStore = { syncedAt: null, sync: null, cookies: {} };
    mergeCookieString(store, obj.cookie);
    return store;
  }
  if (obj.cookies && typeof obj.cookies === 'object' && !Array.isArray(obj.cookies)) {
    return {
      syncedAt: typeof obj.syncedAt === 'string' ? obj.syncedAt : null,
      sync: typeof obj.sync === 'string' ? obj.sync : null,
      cookies: normalizeCookieMap(obj.cookies as Record<string, unknown>),
    };
  }
  return null;
}

async function readStoreFile(path: string): Promise<CookieStore | null> {
  try { return storeFromRaw(JSON.parse(await readFile(path, 'utf8')) as unknown); } catch { /* 不存在或损坏都视为空。 */ }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function loadCookies(runtimeDir?: string | null): Promise<CookieStore> {
  const primaryPath = process.env.TAOBAO_COOKIE_FILE
    ?? ((await pathExists(rootCookiePath())) ? rootCookiePath() : null);
  const primary = primaryPath ? await readStoreFile(primaryPath) : null;
  const runtimeCache: CookieStore = (await readStoreFile(cookieStorePath(runtimeDir))) || { syncedAt: null, sync: null, cookies: {} };
  if (!primary) return runtimeCache;
  const store: CookieStore = { ...primary, cookies: { ...primary.cookies } };
  // 只用运行时缓存中「未过期」的令牌覆盖：过期令牌会在发送时被过滤，
  // 反而把主配置里仍有效的旧令牌顶掉，白白发一次无令牌请求。
  for (const key of TOKEN_KEYS) {
    const entry = runtimeCache.cookies[key];
    if (entry && !isExpired(entry)) store.cookies[key] = entry;
  }
  // 设备指纹 cna：主配置已带有效值时尊重主配置；主配置缺失时沿用预热缓存，保持跨进程指纹稳定。
  for (const key of WARM_KEYS) {
    const current = store.cookies[key];
    const cached = runtimeCache.cookies[key];
    if ((!current || isExpired(current)) && cached && !isExpired(cached)) {
      store.cookies[key] = cached;
    }
  }
  return store;
}

// 所有程序写入（令牌续签、sync-cookie 导入）一律进 .runtime 缓存，主配置永不被改写。
export async function saveCookies(store: CookieStore, runtimeDir?: string | null): Promise<void> {
  const path = cookieStorePath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(store, null, 2) + '\n';
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(temp, payload);
  try {
    await rename(temp, path);
  } catch {
    await writeFile(path, payload).catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

function domainOk(domain: unknown): boolean {
  return TAOBAO_DOMAIN.test(String(domain || '').replace(/^\./, ''));
}

function isExpired(entry: CookieEntry): boolean {
  if (typeof entry.expires !== 'number') return false;
  return entry.expires >= 0 && entry.expires <= Math.floor(Date.now() / 1000);
}

function isSendable(entry: CookieEntry | undefined): entry is CookieEntry {
  return Boolean(entry && typeof entry.value === 'string' && entry.value !== '' && domainOk(entry.domain) && !isExpired(entry));
}

export function cookieHeader(store: CookieStore): string {
  return Object.entries(store.cookies)
    .filter(([name, entry]) => Boolean(name) && isSendable(entry))
    .map(([name, entry]) => `${name}=${entry.value}`)
    .join('; ');
}

export function mergeSetCookies(store: CookieStore, setCookieLines: readonly string[] = []): boolean {
  let changed = false;
  for (const line of setCookieLines) {
    const pair = line.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    if (!name) continue;
    const domainAttr = /domain\s*=\s*([^;]+)/i.exec(line)?.[1]?.trim().replace(/^\./, '') || store.cookies[name]?.domain || '.taobao.com';
    const maxAge = /max-age\s*=\s*(-?\d+)/i.exec(line)?.[1];
    const expiresAttr = /expires\s*=\s*([^;]+)/i.exec(line)?.[1];
    let expires = store.cookies[name]?.expires ?? -1;
    if (maxAge !== undefined) expires = Number(maxAge) <= 0 ? 0 : Math.floor(Date.now() / 1000) + Number(maxAge);
    else if (expiresAttr) { const parsed = Date.parse(expiresAttr.trim()); expires = Number.isNaN(parsed) ? expires : Math.floor(parsed / 1000); }
    if (expires === 0) { if (name in store.cookies) { delete store.cookies[name]; changed = true; } continue; }
    store.cookies[name] = { value, domain: domainOk(domainAttr) ? domainAttr : '.taobao.com', expires };
    changed = true;
  }
  return changed;
}

export function mergeCookieString(store: CookieStore, text: string): number {
  let count = 0;
  for (const pair of String(text || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) continue;
    store.cookies[name] = { value, domain: '.taobao.com', expires: -1 };
    count += 1;
  }
  return count;
}

export function cookieSummary(store: CookieStore): CookieSummary {
  const validNames = Object.entries(store.cookies)
    .filter(([name, entry]) => Boolean(name) && isSendable(entry))
    .map(([name]) => name);
  return {
    syncedAt: store.syncedAt,
    sync: store.sync,
    total: validNames.length,
    hasSignToken: validNames.includes('_m_h5_tk'),
    hasLoginState: ['unb', 'cookie2', 'sgcookie'].some(name => validNames.includes(name)),
    hasCna: validNames.includes('cna'),
  };
}
