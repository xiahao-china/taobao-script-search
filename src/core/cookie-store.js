import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from './config.js';

// MTOP H5 网关只挂 .taobao.com 域；tmall 域 Cookie 不发送，减少指纹噪音。
const TAOBAO_DOMAIN = /(?:^|\.)taobao\.com$/i;

export function cookieStorePath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-cookies.json');
}

// 根目录 cookie.json：面向使用者的显式配置（模板见 cookie.example.json），
// 优先于 .runtime/ 自动缓存。支持两种格式：
//   简单格式：{"cookie": "name=value; name2=value2"}
//   内部格式：{"cookies": {"name": {"value": "...", "domain": "...", "expires": ...}}}（令牌自动续签后写回的形态）
// 可用环境变量 TAOBAO_COOKIE_FILE 指定其他路径（测试与多账号场景用）。
export function rootCookiePath() {
  return process.env.TAOBAO_COOKIE_FILE
    || join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'cookie.json');
}

async function existingStorePath(runtimeDir) {
  if (process.env.TAOBAO_COOKIE_FILE) return process.env.TAOBAO_COOKIE_FILE; // 显式指定即独占，不回退
  const root = rootCookiePath();
  try {
    await access(root);
    return root;
  } catch { /* 根目录未提供 cookie.json，回退到 .runtime 缓存 */ }
  return cookieStorePath(runtimeDir);
}

export async function loadCookies(runtimeDir) {
  try {
    const raw = JSON.parse(await readFile(await existingStorePath(runtimeDir), 'utf8'));
    if (raw && typeof raw.cookie === 'string' && raw.cookie.trim()) {
      const store = { syncedAt: null, sync: null, cookies: {} };
      mergeCookieString(store, raw.cookie);
      return store;
    }
    if (raw && typeof raw.cookies === 'object' && raw.cookies) return { syncedAt: raw.syncedAt ?? null, sync: raw.sync ?? null, cookies: raw.cookies };
  } catch { /* 首次使用或文件损坏时都从空罐开始。 */ }
  return { syncedAt: null, sync: null, cookies: {} };
}

export async function saveCookies(store, runtimeDir) {
  const path = await existingStorePath(runtimeDir);
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
