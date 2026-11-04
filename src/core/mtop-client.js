import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm, mkdir, appendFile, stat } from 'node:fs/promises';
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
// RGV587 是「请求指纹/频率被风控拦截」，与登录态无关（带有效 Cookie 也会触发），
// 必须与 USER_VALIDATE 等真正的登录态问题分开报错、分开处置。
const RISK_PATTERN = /RGV587/i;
const AUTH_PATTERN = /USER_VALIDATE|SESSION_EXPIRED|NEED_LOGIN|FAIL_SYS_ILLEGAL_ACCESS/i;
// 零成本匿名探针：签名对不对无所谓——网关拒签时照样 Set-Cookie 下发新令牌，
// 响应体直接丢弃。用于裸会话领令牌，避免让业务请求带空令牌硬闯。
const TOKEN_PROBE = ['mtop.common.getTimestamp', '1.0'];

function pacingPath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-pacing.json');
}

function requestLogPath(runtimeDir) {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-request-log.jsonl');
}

// 单文件 5MB 上限：超过后整体挪到 .old（风控复盘看最近行为，老日志留档一份即可）。
const REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024;

// 请求日志（JSONL，每行一次真实 HTTP 尝试）：时间戳、接口、结果、限速等待、耗时。
// 用途：被风控/异常时回溯「当时查了什么、什么节奏」。是旁路功能——任何写日志
// 失败都不影响主链路；并发进程同时轮转的 rename 竞争由 catch 兜底。
export async function appendRequestLog(runtimeDir, entry) {
  try {
    const path = requestLogPath(runtimeDir);
    await mkdir(dirname(path), { recursive: true });
    try {
      const info = await stat(path);
      if (info.size > REQUEST_LOG_MAX_BYTES) await rename(path, `${path}.old`).catch(() => {});
    } catch { /* 首次写入前无文件，非错误 */ }
    await appendFile(path, JSON.stringify(entry) + '\n');
  } catch { /* 旁路，吞掉 */ }
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
    this.sessionWarmed = false;
  }

  // 会话预热（进程内至多一次，裸会话特征是风控重点关照对象）：
  // 1) 缺 cna（设备指纹 Cookie）时先访问一次主页领取，之后保持稳定不换；
  // 2) 缺签名令牌时先用零成本哑请求向网关换取 _m_h5_tk——避免业务请求带空
  //    令牌硬闯、白白吃一次 TOKEN_EXPIRED 并累积坏指纹。预热是尽力而为：
  //    失败静默放行，后续请求仍走原有的 TOKEN 重签链路兜底。
  async warmSession(store, signal) {
    if (this.sessionWarmed) return;
    this.sessionWarmed = true;
    try {
      if (!store.cookies.cna) {
        const response = await fetch('https://www.taobao.com/', {
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
        mergeSetCookies(store, response.headers.getSetCookie());
        await saveCookies(store, this.options.runtimeDir);
      }
      if (!store.cookies._m_h5_tk) {
        await this.request(TOKEN_PROBE[0], TOKEN_PROBE[1], {}, { signal, probe: true });
      }
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
    }
  }

  async request(api, version, data, { retry = 0, signal, extraParams = null, referer = null, probe = false } = {}) {
    checkAbort(signal);
    let store = await loadCookies(this.options.runtimeDir);
    if (!probe && (!store.cookies.cna || !store.cookies._m_h5_tk)) {
      await this.warmSession(store, signal);
      // 预热可能已把 cna/令牌写进磁盘缓存，重读一份保证签名用上新令牌。
      store = await loadCookies(this.options.runtimeDir);
    }
    const header = cookieHeader(store);
    const waitStart = Date.now();
    await reserveSlot(this.options.runtimeDir, this.options.minIntervalMs, this.options.jitterMs, signal);
    const waitMs = Date.now() - waitStart; // 本次为满足限速实际等待的毫秒数（0=无需等待）
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
    const reqStart = Date.now();
    // 请求日志：每次真实 HTTP 尝试一行（含重签重试、失败、取消），供风控/异常复盘。
    const logOutcome = async outcome => {
      await appendRequestLog(this.options.runtimeDir, {
        t: reqStart, ts: new Date(reqStart).toISOString(), api, v: version,
        ...(probe ? { probe: true } : {}), ...(retry ? { retry } : {}),
        waitMs, ms: Date.now() - reqStart, ...outcome,
      });
    };
    const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), signal]) : AbortSignal.timeout(this.options.timeoutMs);
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: fetchSignal });
    } catch (error) {
      if (signal?.aborted) {
        await logOutcome({ ok: false, code: 'CANCELLED' });
        throw new TaobaoError('CANCELLED', '任务已取消。');
      }
      await logOutcome({ ok: false, code: 'NETWORK_ERROR' });
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
      await logOutcome({ ok: false, code: 'TOKEN_EXPIRED_RETRIED', http: response.status });
      return this.request(api, version, data, { retry: retry + 1, signal, extraParams, referer });
    }
    if (codes.some(code => RISK_PATTERN.test(code))) {
      // 刻意不自动重试：风控是按请求指纹拦的，原地重试只会加重封禁。
      await logOutcome({ ok: false, code: 'RISK_CONTROL', http: response.status, ret });
      throw new TaobaoError('RISK_CONTROL',
        '触发淘宝风控拦截（RGV587）：请求特征或频率被判不可信，与登录态无关。'
        + '请等待几分钟到十几分钟，期间在浏览器正常访问一次 taobao.com 再重试；若连续触发请拉长请求间隔。',
        { ret });
    }
    if (codes.some(code => AUTH_PATTERN.test(code))) {
      await logOutcome({ ok: false, code: 'AUTH_REQUIRED', http: response.status, ret });
      throw new TaobaoError('AUTH_REQUIRED', '淘宝登录态失效。请先在浏览器登录淘宝，然后执行 taobao sync-cookie 同步 Cookie 后重试。', { ret });
    }
    if (!codes.some(code => code === 'SUCCESS')) {
      await logOutcome({ ok: false, code: 'MTOP_ERROR', http: response.status, ret });
      throw new TaobaoError('MTOP_ERROR', `MTOP 返回错误：${ret.join('; ') || `HTTP ${response.status}`}`, { ret });
    }
    await logOutcome({ ok: true, http: response.status });
    return parsed.data;
  }
}
