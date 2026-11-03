import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { projectRoot, runtimePaths } from './config.js';

// MTOP H5 网关只挂 .taobao.com 域；tmall 域 Cookie 不发送，减少指纹噪音。
const TAOBAO_DOMAIN = /(?:^|\.)taobao\.com$/i;

export function cookieStorePath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-cookies.json');
}

// 根目录 cookie.json：面向使用者的显式配置（模板见 cookie.example.json），**只读**——
// 程序从不覆写它，令牌续签与 sync-cookie 全部落到 .runtime 运行时缓存。
// 支持两种格式：
//   简单格式：{"cookie": "name=value; name2=value2"}
//   内部格式：{"cookies": {"name": {"value": "...", "domain": "...", "expires": ...}}}
// 加载规则：主配置存在时以其为登录态基准，仅令牌键（_m_h5_tk/_m_h5_tk_enc）用
// .runtime 里的续签值覆盖——那两个键是网关临时下发的，配置文件里的永远更旧。
// 可用环境变量 TAOBAO_COOKIE_FILE 指定其他主配置路径（测试与多账号场景用，显式指定即独占）。
const TOKEN_KEYS = ['_m_h5_tk', '_m_h5_tk_enc'];

export function rootCookiePath() {
  return process.env.TAOBAO_COOKIE_FILE
    || join(projectRoot, 'cookie.json');
}

function storeFromRaw(raw) {
  if (raw && typeof raw.cookie === 'string' && raw.cookie.trim()) {
    const store = { syncedAt: null, sync: null, cookies: {} };
    mergeCookieString(store, raw.cookie);
    return store;
  }
  if (raw && typeof raw.cookies === 'object' && raw.cookies) return { syncedAt: raw.syncedAt ?? null, sync: raw.sync ?? null, cookies: raw.cookies };
  return null;
}

async function readStoreFile(path) {
  try { return storeFromRaw(JSON.parse(await readFile(path, 'utf8'))); } catch { /* 不存在或损坏都视为空。 */ }
  return null;
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function loadCookies(runtimeDir) {
  const primaryPath = process.env.TAOBAO_COOKIE_FILE
    ?? ((await pathExists(rootCookiePath())) ? rootCookiePath() : null);
  const primary = primaryPath ? await readStoreFile(primaryPath) : null;
  const runtimeCache = (await readStoreFile(cookieStorePath(runtimeDir))) || { syncedAt: null, sync: null, cookies: {} };
  if (!primary) return runtimeCache;
  const store = { ...primary, cookies: { ...primary.cookies } };
  // 只用运行时缓存中「未过期」的令牌覆盖：过期令牌会在发送时被过滤，
  // 反而把主配置里仍有效的旧令牌顶掉，白白发一次无令牌请求。
  for (const key of TOKEN_KEYS) {
    const entry = runtimeCache.cookies[key];
    if (entry && !isExpired(entry)) store.cookies[key] = entry;
  }
  return store;
}

// 所有程序写入（令牌续签、sync-cookie 导入）一律进 .runtime 缓存，主配置永不被改写。
export async function saveCookies(store, runtimeDir) {
  const path = cookieStorePath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n');
}

function domainOk(domain) {
  return TAOBAO_DOMAIN.test(String(domain || '').replace(/^\./, ''));
}

function isExpired(entry) {
  if (typeof entry.expires !== 'number') return false;
  return entry.expires >= 0 && entry.expires <= Math.floor(Date.now() / 1000);
}

export function cookieHeader(store) {
  return Object.entries(store.cookies)
    .filter(([name, entry]) => name && entry && typeof entry.value === 'string' && domainOk(entry.domain) && !isExpired(entry))
    .map(([name, entry]) => `${name}=${entry.value}`)
    .join('; ');
}

export function mergeSetCookies(store, setCookieLines = []) {
  let changed = false;
  for (const line of setCookieLines) {
    const pair = line.split(';', 1)[0];
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

export function mergeCookieString(store, text) {
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

export function cookieSummary(store) {
  const names = Object.keys(store.cookies);
  return {
    syncedAt: store.syncedAt,
    sync: store.sync,
    total: names.length,
    hasSignToken: names.includes('_m_h5_tk'),
    hasLoginState: ['unb', 'cookie2', 'sgcookie'].some(name => names.includes(name)),
  };
}
