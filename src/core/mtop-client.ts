import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm, mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaobaoError, checkAbort, getErrorCode, getErrorMessage } from './errors.js';
import { runtimePaths } from './config.js';
import { loadCookies, saveCookies, cookieHeader, cookieSummary, mergeSetCookies } from './cookie-store.js';
import { parseBody } from './json-body.js';
import type {
  CookieStore,
  FetchLike,
  MtopClientLike,
  MtopClientOptions,
  MtopRequestOptions,
  ResolvedMtopClientOptions,
  ResponseLike,
  TaobaoErrorCode,
} from '../types.js';

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
const TOKEN_PROBE: readonly [string, string] = ['mtop.common.getTimestamp', '1.0'];

function pacingPath(runtimeDir?: string | null): string {
  return join(runtimePaths(runtimeDir || undefined).directory, 'mtop-pacing.json');
}

function requestLogPath(runtimeDir?: string | null): string {
  // 日志统一归 .runtime/log/ 文件夹（与限速占坑等状态文件分开），轮转件也在其中。
  return join(runtimePaths(runtimeDir || undefined).directory, 'log', 'mtop-request-log.jsonl');
}

const LEGACY_LOG_PATH = (runtimeDir?: string | null): string =>
  join(runtimePaths(runtimeDir || undefined).directory, 'mtop-request-log.jsonl');

// 单文件 5MB 上限：超过后整体挪到同文件夹 .old（复盘看最近行为，老日志留档一份即可）。
const LOG_MAX_BYTES = 5 * 1024 * 1024;

// JSONL 追加的公共件：建目录 + 超限轮转（<名>.old.jsonl）+ 追加一行。
// 并发进程同时轮转的 rename 竞争由 catch 兜底（最坏情况多留一份，不丢已写入行）。
async function appendJsonl(path: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const info = await stat(path);
    if (info.size > LOG_MAX_BYTES) {
      await rename(path, join(dirname(path), `${basename(path, '.jsonl')}.old.jsonl`)).catch(() => {});
    }
  } catch { /* 首次写入前无文件，非错误 */ }
  await appendFile(path, JSON.stringify(entry) + '\n');
}

// 请求日志（JSONL，每行一次真实 HTTP 尝试）：时间戳、接口、结果、限速等待、耗时。
// 用途：被风控/异常时回溯「当时查了什么、什么节奏」。是旁路功能——任何写日志
// 失败都不影响主链路。
export async function appendRequestLog(runtimeDir: string | null | undefined, entry: Record<string, unknown>): Promise<void> {
  try {
    const path = requestLogPath(runtimeDir);
    // 一次性迁移：旧版日志直接躺在 .runtime 根下，见到就搬进 log/ 文件夹。
    // 注意先建目录——rename 的目标父目录不存在时整个迁移会静默失败。
    try {
      await mkdir(dirname(path), { recursive: true });
      await rename(LEGACY_LOG_PATH(runtimeDir), path);
    } catch { /* 无旧文件，正常 */ }
    await appendJsonl(path, entry);
  } catch { /* 旁路，吞掉 */ }
}

// 操作日志（JSONL，每行一次业务查询）：查询类型（search/specs/detail/orders/
// review-summary/batch）、入参、完整业务结果（商品列表/详情/规格树）或错误。
// 与请求日志互补：请求日志管协议层节奏，操作日志管「查了什么、查到了什么」。
// 同样是旁路功能，写失败静默。
export async function appendOperationLog(runtimeDir: string | null | undefined, entry: Record<string, unknown>): Promise<void> {
  try {
    await appendJsonl(join(runtimePaths(runtimeDir || undefined).directory, 'log', 'mtop-operation-log.jsonl'), entry);
  } catch { /* 旁路，吞掉 */ }
}

// 公共操作日志包装器：MtopAdapter 与 ShopSearchAdapter 共用。
export async function withOperationLog<T extends { data?: unknown }>(
  runtimeDir: string | null | undefined,
  operation: string,
  params: Record<string, unknown>,
  fallbackCode: TaobaoErrorCode,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const base = { t: start, ts: new Date(start).toISOString(), operation, params };
  try {
    const result = await fn();
    await appendOperationLog(runtimeDir, {
      ...base, ok: true, ms: Date.now() - start, data: result?.data ?? null,
    });
    return result;
  } catch (error: unknown) {
    await appendOperationLog(runtimeDir, {
      ...base, ok: false, ms: Date.now() - start,
      error: { code: getErrorCode(error, fallbackCode), message: getErrorMessage(error) },
    });
    throw error;
  }
}

export function parseEnvMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

let slotSeq = 0;
const slotQueues = new Map<string, Promise<void>>();

// 跨进程令牌桶：请求前先占坑（把计划时刻 + 唯一 owner 写进文件），其他进程自动排队在其后。
// 同进程并发通过 per-path Promise 队列串行化；跨进程通过「原子写入 + owner 复读校验」收敛竞争——
// 即使双进程在同一毫秒到达，rename 后文件只会保留一个 owner，落败方立即重算并排在对方之后。
// 导出供非网关 HTTP 通道复用（店铺内搜索的 *.taobao.com 页面请求同享全局限速）。
async function reserveSlotOnce(
  path: string,
  minIntervalMs: number,
  jitterMs: number,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  await mkdir(dirname(path), { recursive: true });
  const myOwner = `${process.pid}:${++slotSeq}:${Math.random().toString(36).slice(2, 6)}`;
  const readState = async (): Promise<{ lastAt: number; owner: string | null }> => {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { lastAt?: unknown; owner?: unknown };
      return { lastAt: Number(parsed.lastAt) || 0, owner: typeof parsed.owner === 'string' ? parsed.owner : null };
    } catch { return { lastAt: 0, owner: null }; }
  };
  const writePlanned = async (planned: number): Promise<void> => {
    const body = JSON.stringify({ lastAt: planned, owner: myOwner });
    const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await writeFile(temp, body);
    try { await rename(temp, path); }
    catch {
      // rename 失败（如跨设备/平台限制）时退回直写，仍优于放弃占坑。
      await writeFile(path, body).catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  };
  let planned = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { lastAt } = await readState();
    const now = Date.now();
    planned = lastAt + minIntervalMs + Math.floor(Math.random() * Math.max(0, jitterMs));
    if (planned <= now) {
      await writePlanned(now);
      const current = await readState();
      if (current.owner === myOwner) return;
      // 同一毫秒被其他进程抢先占坑 → 重算并排在对方之后。
      continue;
    }
    await writePlanned(planned);
    const current = await readState();
    if (current.owner === myOwner && current.lastAt === planned) break;
  }
  checkAbort(signal);
  const wait = planned - Date.now();
  if (wait > 0) {
    try { await delay(wait, undefined, { signal }); }
    catch (error: unknown) {
      if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
      throw error;
    }
  }
}

export async function reserveSlot(
  runtimeDir: string | null | undefined,
  minIntervalMs: number,
  jitterMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;
  checkAbort(signal);
  const path = pacingPath(runtimeDir);
  const prev = slotQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => reserveSlotOnce(path, minIntervalMs, jitterMs, signal));
  const tail = next.then(() => undefined, () => undefined);
  slotQueues.set(path, tail);
  try {
    await next;
  } finally {
    if (slotQueues.get(path) === tail) slotQueues.delete(path);
  }
}

export class MtopClient implements MtopClientLike {
  readonly options: ResolvedMtopClientOptions;
  readonly fetch: FetchLike;
  private sessionWarmed: boolean;

  constructor(options: MtopClientOptions = {}) {
    this.options = {
      runtimeDir: null,
      timeoutMs: 15000,
      minIntervalMs: parseEnvMs(process.env.TAOBAO_MTOP_MIN_INTERVAL_MS, 5000),
      jitterMs: parseEnvMs(process.env.TAOBAO_MTOP_JITTER_MS, 5000),
      ...options,
    };
    this.fetch = options.fetch || (globalThis.fetch as unknown as FetchLike);
    this.sessionWarmed = false;
  }

  // 会话预热（进程内至多一次，裸会话特征是风控重点关照对象）：
  // 1) 缺 cna（设备指纹 Cookie）时先访问一次主页领取，之后写入 .runtime 保持跨进程稳定不换；
  // 2) 缺签名令牌时先用零成本哑请求向网关换取 _m_h5_tk——避免业务请求带空
  //    令牌硬闯、白白吃一次 TOKEN_EXPIRED 并累积坏指纹。预热是尽力而为：
  //    失败静默放行，后续请求仍走原有的 TOKEN 重签链路兜底。
  async warmSession(store: CookieStore, signal?: AbortSignal): Promise<void> {
    if (this.sessionWarmed) return;
    this.sessionWarmed = true;
    try {
      if (!store.cookies.cna) {
        const started = Date.now();
        const timeoutSignal = AbortSignal.timeout(10000);
        const fetchSignal = signal
          ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, signal]) : signal)
          : timeoutSignal;
        try {
          const response = await this.fetch('https://www.taobao.com/', {
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
            redirect: 'manual',
            signal: fetchSignal,
          });
          mergeSetCookies(store, response.headers.getSetCookie());
          await saveCookies(store, this.options.runtimeDir);
          await appendRequestLog(this.options.runtimeDir, {
            t: started, ts: new Date(started).toISOString(), api: 'warm-cna', probe: true,
            ok: Boolean(store.cookies.cna), http: response.status, ms: Date.now() - started,
            gotCna: Boolean(store.cookies.cna),
          });
        } catch (error: unknown) {
          if (signal?.aborted) throw new TaobaoError('CANCELLED', '任务已取消。');
          await appendRequestLog(this.options.runtimeDir, {
            t: started, ts: new Date(started).toISOString(), api: 'warm-cna', probe: true,
            ok: false, code: 'NETWORK_ERROR', ms: Date.now() - started,
            message: getErrorMessage(error),
          });
        }
      }
      if (!store.cookies._m_h5_tk) {
        await this.request(TOKEN_PROBE[0], TOKEN_PROBE[1], {}, { signal, probe: true });
      }
    } catch (error: unknown) {
      if (getErrorCode(error) === 'CANCELLED') throw error;
    }
  }

  async request(
    api: string,
    version: string,
    data: Record<string, unknown>,
    { retry = 0, signal, extraParams = null, referer = null, probe = false, method = 'GET' }: MtopRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    checkAbort(signal);
    let store = await loadCookies(this.options.runtimeDir);
    if (!probe && (!store.cookies.cna || !store.cookies._m_h5_tk)) {
      await this.warmSession(store, signal);
      // 预热可能已把 cna/令牌写进磁盘缓存，重读一份保证签名用上新令牌。
      store = await loadCookies(this.options.runtimeDir);
    }
    const header = cookieHeader(store);
    const summary = cookieSummary(store);
    const waitStart = Date.now();
    await reserveSlot(this.options.runtimeDir, this.options.minIntervalMs, this.options.jitterMs, signal);
    const waitMs = Date.now() - waitStart; // 本次为满足限速实际等待的毫秒数（0=无需等待）
    checkAbort(signal);
    const token = (store.cookies._m_h5_tk?.value || '').split('_')[0] ?? '';
    const timestamp = String(Date.now());
    const dataJson = JSON.stringify(data);
    const sign = createHash('md5').update(`${token}&${timestamp}&${APP_KEY}&${dataJson}`).digest('hex');
    const url = new URL(`/h5/${api.toLowerCase()}/${version}/`, HOST);
    const baseParams: Record<string, string> = {
      jsv: JSV, appKey: APP_KEY, t: timestamp, sign, api, v: version,
      type: 'originaljson', dataType: 'json', H5Request: 'true', data: dataJson,
    };
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Referer: referer || 'https://h5.m.taobao.com/',
      Origin: referer ? new URL(referer).origin : 'https://h5.m.taobao.com',
    };
    if (header) headers.Cookie = header;
    const allParams: Record<string, string> = { ...baseParams, ...(extraParams || {}) };
    // POST 通道（购物车 update.bag 等大 payload 写接口）：参数走 form body，
    // 签名算法与 GET 完全一致（dataJson 参与摘要），仅传输位置不同。
    let requestBody: string | null = null;
    if (String(method).toUpperCase() === 'POST') {
      requestBody = new URLSearchParams(allParams).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      url.search = new URLSearchParams(allParams).toString();
    }
    let response: ResponseLike;
    const reqStart = Date.now();
    // 请求日志：每次真实 HTTP 尝试一行（含重签重试、失败、取消），供风控/异常复盘。
    // 仅记非敏感诊断标志（cookieCount/hasLogin/hasCna/hasToken，均按实际可发送口径统计），绝不落明文 Cookie。
    const logOutcome = async (outcome: Record<string, unknown>): Promise<void> => {
      await appendRequestLog(this.options.runtimeDir, {
        t: reqStart, ts: new Date(reqStart).toISOString(), api, v: version,
        ...(probe ? { probe: true } : {}), ...(retry ? { retry } : {}),
        cookieCount: summary.total, hasLogin: summary.hasLoginState,
        hasCna: summary.hasCna, hasToken: Boolean(token),
        waitMs, ms: Date.now() - reqStart, ...outcome,
      });
    };
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const fetchSignal = signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, signal]) : signal) : timeoutSignal;
    try {
      response = await this.fetch(url, {
        method: requestBody ? 'POST' : 'GET',
        headers,
        body: requestBody,
        redirect: 'manual',
        signal: fetchSignal,
      });
    } catch (error: unknown) {
      if (signal?.aborted) {
        await logOutcome({ ok: false, code: 'CANCELLED' });
        throw new TaobaoError('CANCELLED', '任务已取消。');
      }
      await logOutcome({ ok: false, code: 'NETWORK_ERROR' });
      throw new TaobaoError('NETWORK_ERROR', `MTOP 请求失败：${getErrorMessage(error)}`);
    }
    mergeSetCookies(store, response.headers.getSetCookie());
    await saveCookies(store, this.options.runtimeDir);
    const rawText = response.text ? await response.text() : '';
    const parsed = parseBody(rawText) as { ret?: unknown; data?: Record<string, unknown> } | null;
    const location = response.headers.get?.('location') || '';
    // 网关有时不返回 JSON ret 而是直接下发 TMD 滑块/punish HTML 页或登录跳转：
    // 若笼统归为 MTOP_ERROR，会诱发 fetchCatalog 降级与 batch 继续撞接口，必须精准识别并熔断。
    if (!parsed) {
      const bodyHead = rawText.slice(0, 160).replace(/\s+/g, ' ').trim();
      if (/_____tmd_____|x5sec|punish/i.test(rawText) || /_____tmd_____|punish/i.test(location)) {
        await logOutcome({ ok: false, code: 'RISK_CONTROL', http: response.status, nonJson: true, bodyHead });
        throw new TaobaoError('RISK_CONTROL',
          '触发淘宝风控拦截（非 JSON 滑块/验证页）：请求特征或频率被判不可信，与登录态无关。'
          + '请等待几分钟到十几分钟，期间在浏览器正常访问一次 taobao.com 再重试；若连续触发请拉长请求间隔。',
          { http: response.status, nonJson: true });
      }
      if (/login\.taobao\.com|login\.htm/i.test(location)) {
        await logOutcome({ ok: false, code: 'AUTH_REQUIRED', http: response.status, nonJson: true, location });
        throw new TaobaoError('AUTH_REQUIRED', '淘宝登录态失效（网关跳转登录页）。请先在浏览器登录淘宝，然后更新 cookie.json 后重试。', { http: response.status });
      }
      await logOutcome({ ok: false, code: 'MTOP_ERROR', http: response.status, ret: [], nonJson: true, bodyHead, ...(location ? { location } : {}) });
      throw new TaobaoError('MTOP_ERROR', `MTOP 返回非 JSON 响应：HTTP ${response.status}`, { ret: [], bodyHead });
    }
    const ret = Array.isArray(parsed.ret) ? parsed.ret.map(String) : [];
    const codes = ret.map(value => value.split('::')[0] ?? '');
    const newToken = (store.cookies._m_h5_tk?.value || '').split('_')[0] ?? '';
    // 令牌过期：网关已通过 Set-Cookie 下发新 token，重签一次即可，不视为风控。
    if (codes.some(code => code.includes('TOKEN')) && newToken && newToken !== token && retry < 1) {
      await logOutcome({ ok: false, code: 'TOKEN_EXPIRED_RETRIED', http: response.status });
      return this.request(api, version, data, { retry: retry + 1, signal, extraParams, referer, method });
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
    return parsed.data ?? {};
  }
}
