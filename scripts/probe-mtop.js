/**
 * Anonymous, bounded MTOP connectivity probe. This is not the product SDK.
 * Uses only Node's HTTP fetch; does not open Chrome or read login credentials.
 * Cookie values, signatures, response bodies and redirect URLs are never saved.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    keyword: { type: 'string', default: 'M3盘头螺丝' },
    'item-id': { type: 'string', default: '805012477549' },
    'timeout-ms': { type: 'string', default: '8000' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log('node scripts/probe-mtop.js [--keyword 关键词] [--item-id 商品ID] [--timeout-ms 8000] [--output 文件.json]');
  console.log('匿名 HTTP 探测；每个接口最多两次请求。不会读取 Chrome 或登录 Cookie。');
  process.exit(0);
}

const timeoutMs = Number(values['timeout-ms']);
if (!values.keyword.trim() || !/^\d+$/.test(values['item-id']) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) {
  console.error('关键词须非空，商品 ID 须为数字，timeout-ms 须为 1000–15000 的整数。');
  process.exit(2);
}

const appKey = '12574478';
const host = 'https://h5api.m.taobao.com';
// One host, one short-lived anonymous session. A production cookie jar needs
// domain/path/expiry handling and must not reuse this minimal probe jar.
const cookies = new Map();
const calls = [
  {
    capability: 'search', api: 'mtop.taobao.wsearch.appsearch', version: '1.0',
    data: { q: values.keyword, search_action: 'initiative', page: '1', n: '24', sversion: '9.9.9' },
  },
  {
    capability: 'detail-mobile', api: 'mtop.taobao.detail.getdetail', version: '6.0',
    data: { id: values['item-id'], exParams: JSON.stringify({ id: values['item-id'] }) },
  },
  {
    capability: 'detail-desktop', api: 'mtop.taobao.pcdetail.data.get', version: '1.0',
    data: {
      id: values['item-id'], detail_v: '3.3.2',
      exParams: JSON.stringify({ id: values['item-id'], domain: 'https://item.taobao.com', path_name: '/item.htm' }),
    },
  },
];

function parseBody(body) {
  try { return JSON.parse(body); } catch { /* Try JSONP without evaluating JS. */ }
  const match = body.match(/^[\w$]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (match) {
    try { return JSON.parse(match[1]); } catch { /* Report invalid JSON. */ }
  }
  return null;
}

function shape(data) {
  const parts = [data];
  for (const entry of Array.isArray(data?.apiStack) ? data.apiStack : []) {
    const nested = typeof entry.value === 'string' ? parseBody(entry.value) : entry.value;
    if (nested && typeof nested === 'object') parts.push(nested);
  }
  const skuBase = parts.find(part => part?.skuBase)?.skuBase;
  const skuCore = parts.find(part => part?.skuCore)?.skuCore;
  return {
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    itemCount: Array.isArray(data?.itemsArray) ? data.itemsArray.length : null,
    specGroupCount: Array.isArray(skuBase?.props) ? skuBase.props.length : null,
    skuCount: Array.isArray(skuBase?.skus) ? skuBase.skus.length : null,
    skuPriceRecordCount: skuCore?.sku2info ? Object.keys(skuCore.sku2info).filter(id => id !== '0').length : null,
  };
}

async function attempt(call) {
  const beforeToken = cookies.get('_m_h5_tk')?.split('_')[0] ?? '';
  const timestamp = String(Date.now());
  const data = JSON.stringify(call.data);
  const sign = createHash('md5').update(`${beforeToken}&${timestamp}&${appKey}&${data}`).digest('hex');
  const url = new URL(`/h5/${call.api.toLowerCase()}/${call.version}/`, host);
  url.search = new URLSearchParams({
    jsv: '2.7.2', appKey, t: timestamp, sign, api: call.api, v: call.version,
    type: 'originaljson', dataType: 'json', H5Request: 'true', data,
  }).toString();
  const headers = { Accept: 'application/json', Referer: 'https://h5.m.taobao.com/', Origin: 'https://h5.m.taobao.com' };
  if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const start = performance.now();
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1);
      if (!value || /max-age\s*=\s*0(?:;|$)/i.test(entry)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const body = await response.text();
    const parsed = parseBody(body);
    const ret = Array.isArray(parsed?.ret) ? parsed.ret.map(value => String(value).split('::', 1)[0]) : [];
    const afterToken = cookies.get('_m_h5_tk')?.split('_')[0] ?? '';
    return {
      httpStatus: response.status,
      elapsedMs: Math.round(performance.now() - start),
      retCodes: ret,
      success: ret.some(code => code === 'SUCCESS'),
      tokenChanged: Boolean(afterToken && afterToken !== beforeToken),
      hasRedirect: response.status >= 300 && response.status < 400,
      jsonResponse: parsed !== null,
      ...shape(parsed?.data),
    };
  } catch (error) {
    return {
      httpStatus: null, elapsedMs: Math.round(performance.now() - start),
      retCodes: [], success: false, tokenChanged: false,
      transportError: error.name, transportCode: error.cause?.code ?? null,
    };
  }
}

const startedAt = new Date().toISOString();
const results = [];
for (const call of calls) {
  const attempts = [await attempt(call)];
  const first = attempts[0];
  // One refresh retry only when the server explicitly returns a token error
  // and supplies a new token. Login/verification responses are not retried.
  const onlyTokenError = first.retCodes.length > 0 && first.retCodes.every(code => code.includes('TOKEN'));
  if (onlyTokenError && first.tokenChanged && !first.hasRedirect) attempts.push(await attempt(call));
  results.push({ capability: call.capability, api: call.api, version: call.version, attempts });
}

const report = {
  startedAt, finishedAt: new Date().toISOString(), nodeVersion: process.version,
  mode: 'anonymous-http', keyword: values.keyword, itemId: values['item-id'],
  maxRequestsPerEndpoint: 2, results,
  interpretation: '探测结果仅代表匿名请求；不能推断已登录会话的可用性或指定 SKU 价格已核验。',
};
const rendered = JSON.stringify(report, null, 2) + '\n';
if (values.output) {
  const outputPath = resolve(values.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered, { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(rendered);
