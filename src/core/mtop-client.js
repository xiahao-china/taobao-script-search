import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaobaoError, checkAbort } from './errors.js';
import { runtimePaths } from './config.js';
import { loadCookies, saveCookies, cookieHeader, mergeSetCookies } from './cookie-store.js';
import { parseBody } from './json-body.js';

export { parseBody };

// 淘宝 H5 前端共用 appKey；签名 = MD5(token & t & appKey & dataJson)。
const APP_KEY = '12574478';
const HOST = 'https://h5api.m.taobao.com';
const JSV = '2.7.2';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const AUTH_PATTERN = /USER_VALIDATE|RGV587|SESSION_EXPIRED|NEED_LOGIN|FAIL_SYS_ILLEGAL_ACCESS/i;

function pacingPath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-pacing.json');
}

// 跨进程令牌桶：请求前先占坑（把计划时刻写进文件），其他进程自动排队在其后。
// 读-算-写存在窗口；用「写后复读校验」收敛竞争——发现被其他进程抢先写入
// 更晚的计划时，以其为准顺延一次，避免双进程同时放行。
// 写入用「临时文件 + rename 原子替换」：writeFile 先截断再写，并发读会读到
// 半截 JSON，readLastAt 捕获后返回 0，导致限速被击穿。
async function reserveSlot(runtimeDir, minIntervalMs, jitterMs, signal) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;
  checkAbort(signal);
  const path = pacingPath(runtimeDir);
  await mkdir(dirname(path), { recursive: true });
  const readLastAt = async () => {
    try { return Number(JSON.parse(await readFile(path, 'utf8')).lastAt) || 0; } catch { return 0; }
  };
  const writePlanned = async planned => {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify({ lastAt: planned }));
    try { await rename(temp, path); }
    catch {
      // rename 失败（如跨设备/平台限制）时退回直写，仍优于放弃占坑。
      await writeFile(path, JSON.stringify({ lastAt: planned })).catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  };
  let planned = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const lastAt = await readLastAt();
    const now = Date.now();
    planned = lastAt + minIntervalMs + Math.floor(Math.random() * Math.max(0, jitterMs));
    if (planned <= now) {
      await writePlanned(now);
      // 复读竞争校验同样适用于「无需等待」分支：被抢先写入更晚计划时照常排队。
      const current = await readLastAt();
      if (current > now) { planned = current; break; }
      return;
    }
    await writePlanned(planned);
    // 复读竞争校验：文件里仍是自己的计划 → 占坑成功。
    if (Number(await readLastAt()) === planned) break;
  }
  checkAbort(signal);
  const wait = planned - Date.now();
  if (wait > 0) await delay(wait, undefined, { signal });
}

export class MtopClient {
  constructor(options = {}) {
    this.options = {
      runtimeDir: null,
      timeoutMs: 15000,
      minIntervalMs: Number(process.env.TAOBAO_MTOP_MIN_INTERVAL_MS) || 5000,
      jitterMs: Number(process.env.TAOBAO_MTOP_JITTER_MS) || 5000,
      ...options,
    };
  }

  async request(api, version, data, { retry = 0, signal, extraParams = null, referer = null } = {}) {
    checkAbort(signal);
    const store = await loadCookies(this.options.runtimeDir);
    const header = cookieHeader(store);
    await reserveSlot(this.options.runtimeDir, this.options.minIntervalMs, this.options.jitterMs, signal);
    checkAbort(signal);
    const token = (store.cookies._m_h5_tk?.value || '').split('_')[0];
    const timestamp = String(Date.now());
    const dataJson = JSON.stringify(data);
    const sign = createHash('md5').update(`${token}&${timestamp}&${APP_KEY}&${dataJson}`).digest('hex');
    const url = new URL(`/h5/${api.toLowerCase()}/${version}/`, HOST);
    const baseParams = {
      jsv: JSV, appKey: APP_KEY, t: timestamp, sign, api, v: version,
      type: 'originaljson', dataType: 'json', H5Request: 'true', data: dataJson,
    };
    url.search = new URLSearchParams({ ...baseParams, ...(extraParams || {}) }).toString();
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Referer: referer || 'https://h5.m.taobao.com/',
      Origin: referer ? new URL(referer).origin : 'https://h5.m.taobao.com',
    };
    if (header) headers.Cookie = header;
    let response;
    const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), signal]) : AbortSignal.timeout(this.options.timeoutMs);
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: fetchSignal });
    } catch (error) {
      if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
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
      return this.request(api, version, data, { retry: retry + 1, signal, extraParams, referer });
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
