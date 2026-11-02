import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaobaoError } from './errors.js';
import { runtimePaths } from './config.js';
import { loadCookies, saveCookies, cookieHeader, mergeSetCookies } from './cookie-store.js';

// 淘宝 H5 前端共用 appKey；签名 = MD5(token & t & appKey & dataJson)。
const APP_KEY = '12574478';
const HOST = 'https://h5api.m.taobao.com';
const JSV = '2.7.2';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const AUTH_PATTERN = /USER_VALIDATE|RGV587|SESSION_EXPIRED|NEED_LOGIN|FAIL_SYS_ILLEGAL_ACCESS/i;

export function parseBody(body) {
  try { return JSON.parse(body); } catch { /* 退化尝试 JSONP，只解析不执行。 */ }
  const match = body.match(/^[\w$]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (match) try { return JSON.parse(match[1]); } catch { /* 非法响应交给上层报错。 */ }
  return null;
}

function pacingPath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-pacing.json');
}

// 跨进程令牌桶：请求前先占坑（把计划时刻写进文件），其他进程自动排队在其后。
async function reserveSlot(runtimeDir, minIntervalMs, jitterMs) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;
  const path = pacingPath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  let lastAt = 0;
  try { lastAt = Number(JSON.parse(await readFile(path, 'utf8')).lastAt) || 0; } catch { /* 无历史即立即放行。 */ }
  const waitUntil = lastAt + minIntervalMs + Math.floor(Math.random() * Math.max(0, jitterMs));
  const now = Date.now();
  if (waitUntil > now) {
    await writeFile(path, JSON.stringify({ lastAt: waitUntil }));
    await delay(waitUntil - now);
    return;
  }
  await writeFile(path, JSON.stringify({ lastAt: now }));
}

export class MtopClient {
  constructor(options = {}) {
    this.options = {
      runtimeDir: null,
      timeoutMs: 15000,
      minIntervalMs: Number(process.env.TAOBAO_MTOP_MIN_INTERVAL_MS) || 1500,
      jitterMs: Number(process.env.TAOBAO_MTOP_JITTER_MS) || 1500,
      ...options,
    };
  }

  async request(api, version, data, { retry = 0 } = {}) {
    const store = await loadCookies(this.options.runtimeDir);
    const header = cookieHeader(store);
    await reserveSlot(this.options.runtimeDir, this.options.minIntervalMs, this.options.jitterMs);
    const token = (store.cookies._m_h5_tk?.value || '').split('_')[0];
    const timestamp = String(Date.now());
    const dataJson = JSON.stringify(data);
    const sign = createHash('md5').update(`${token}&${timestamp}&${APP_KEY}&${dataJson}`).digest('hex');
    const url = new URL(`/h5/${api.toLowerCase()}/${version}/`, HOST);
    url.search = new URLSearchParams({
      jsv: JSV, appKey: APP_KEY, t: timestamp, sign, api, v: version,
      type: 'originaljson', dataType: 'json', H5Request: 'true', data: dataJson,
    }).toString();
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Referer: 'https://h5.m.taobao.com/',
      Origin: 'https://h5.m.taobao.com',
    };
    if (header) headers.Cookie = header;
    let response;
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      throw new TaobaoError('NETWORK_ERROR', `MTOP 请求失败：${error.message}`);
    }
    mergeSetCookies(store, response.headers.getSetCookie());
    await saveCookies(store, this.options.runtimeDir);
    const parsed = parseBody(await response.text());
    const ret = Array.isArray(parsed?.ret) ? parsed.ret.map(String) : [];
    const codes = ret.map(value => value.split('::')[0]);
    const newToken = (store.cookies._m_h5_tk?.value || '').split('_')[0];
    // 令牌过期：网关已通过 Set-Cookie 下发新 token，重签一次即可，不视为风控。
    if (codes.some(code => code.includes('TOKEN')) && newToken && newToken !== token && retry < 1) {
      return this.request(api, version, data, { retry: retry + 1 });
    }
    if (codes.some(code => AUTH_PATTERN.test(code))) {
      throw new TaobaoError('AUTH_REQUIRED', '淘宝登录态失效或触发风控验证。请先在浏览器登录淘宝，然后执行 taobao sync-cookie 同步 Cookie 后重试。', { ret });
    }
    if (!codes.some(code => code === 'SUCCESS')) {
      throw new TaobaoError('MTOP_ERROR', `MTOP 返回错误：${ret.join('; ') || `HTTP ${response.status}`}`, { ret });
    }
    return parsed.data;
  }
}
