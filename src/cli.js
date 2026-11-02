import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { failure, TaobaoError } from './core/errors.js';
import { loadCookies, saveCookies, mergeCookieString, cookieSummary } from './core/cookie-store.js';
import { MtopAdapter } from './adapters/taobao/mtop.js';

const help = `淘宝查询：纯 HTTP MTOP 直连（零浏览器依赖，即用即调）
  taobao search <关键词> [--limit 20] [--page 1] [--sort default]
  taobao specs <商品ID>
  taobao detail <商品ID> --spec-id <规格ID> | --spec '{...}' | --labels '[...]'
  taobao batch --file examples/batch.json [--output artifacts/result.json]
  taobao sync-cookie --cookie-string "a=b; c=d"   导入 Cookie（或 --stdin 从管道读入）
首次使用：复制仓库根目录 cookie.example.json 为 cookie.json，把 cookie 字段替换成
浏览器里 taobao.com 的完整 Cookie 字符串（获取方法见 README「配置 Cookie」）；
或执行一次 sync-cookie 导入。登录态失效时更新 cookie.json 即可。
内置限速：相邻 MTOP 请求间隔 1.5–3.0 秒（跨进程生效），触发滑块会明确报 AUTH_REQUIRED。`;

function envelope(operation, payload) {
  return { ok: true, operation, data: payload.data, error: null, meta: payload.meta };
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolvePromise(text.trim()));
    process.stdin.on('error', reject);
  });
}

async function syncCookie(values) {
  const runtimeDir = values['runtime-dir'] || null;
  const manual = values['cookie-string'] !== undefined ? String(values['cookie-string'])
    : values.stdin ? await readStdin() : null;
  if (manual === null) throw new TaobaoError('INVALID_ARGUMENT', '请提供 --cookie-string "..." 或 --stdin（从管道读入 Cookie 字符串）。');
  const store = await loadCookies(runtimeDir);
  if (!mergeCookieString(store, manual)) throw new TaobaoError('INVALID_ARGUMENT', 'Cookie 字符串解析结果为空，请检查格式（应为 name=value; name=value）。');
  store.syncedAt = new Date().toISOString();
  store.sync = 'manual';
  await saveCookies(store, runtimeDir);
  return { ok: true, operation: 'sync-cookie', data: cookieSummary(store), error: null, meta: null };
}

async function mtopCommand(operation, positionals, values, control) {
  const runtimeDir = values['runtime-dir'] || null;
  const store = await loadCookies(runtimeDir);
  if (!cookieSummary(store).hasLoginState) {
    throw new TaobaoError('AUTH_REQUIRED',
      '尚未配置淘宝登录 Cookie。两种配置方式：'
      + '1) 复制仓库根目录 cookie.example.json 为 cookie.json，把 cookie 字段替换为浏览器中 taobao.com 的完整 Cookie 字符串（F12 → Network → 任意请求 → Cookie 请求头）；'
      + '2) 执行 taobao sync-cookie --cookie-string "name=value; ..."。详见 README「配置 Cookie」。');
  }
  const adapter = new MtopAdapter({
    runtimeDir: values['runtime-dir'] || null,
    ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
  });
  const queryOptions = {
    ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.page ? { page: Number(values.page) } : {}),
    ...(values.sort ? { sort: values.sort } : {}),
  };
  if (operation === 'search') return envelope('search', await adapter.search(positionals[1], queryOptions, control.signal));
  if (operation === 'specs') return envelope('specs', await adapter.getSpecs(positionals[1], queryOptions, control.signal));
  if (operation === 'detail') {
    const selections = [values['spec-id'], values.spec, values.labels].filter(value => value !== undefined);
    if (selections.length !== 1) throw new TaobaoError('INVALID_ARGUMENT', 'detail 须且只能提供 --spec-id、--spec 或 --labels 之一。');
    const spec = values['spec-id'] ? { specId: values['spec-id'] } : values.spec ? JSON.parse(values.spec) : { labels: JSON.parse(values.labels) };
    return envelope('detail', await adapter.getDetail(positionals[1], spec, queryOptions, control.signal));
  }
  if (!values.file) throw new TaobaoError('INVALID_ARGUMENT', 'batch 必须指定 --file。');
  const input = JSON.parse(await readFile(resolve(values.file), 'utf8'));
  return envelope('batch', await adapter.batch(input, control.signal));
}

export async function main() {
  let operation = 'cli';
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, page: { type: 'string' }, sort: { type: 'string' },
      'spec-id': { type: 'string' }, spec: { type: 'string' }, labels: { type: 'string' },
      file: { type: 'string' }, output: { type: 'string' },
      'cookie-string': { type: 'string' }, stdin: { type: 'boolean' },
      'runtime-dir': { type: 'string' }, timeout: { type: 'string' },
    } });
    if (values.help || !positionals.length) { console.log(help); return; }
    operation = positionals[0];
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    let result;
    const control = { signal: controller.signal };
    if (operation === 'sync-cookie') result = await syncCookie(values);
    else if (['search', 'specs', 'detail', 'batch'].includes(operation)) result = await mtopCommand(operation, positionals, values, control);
    else throw new TaobaoError('INVALID_ARGUMENT', `未知命令：${operation}。可用：search / specs / detail / batch / sync-cookie。`);
    process.removeListener('SIGINT', cancel);
    const rendered = JSON.stringify(result, null, 2) + '\n';
    if (values.output) { const path = resolve(values.output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, rendered); }
    process.stdout.write(rendered);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(operation, error), null, 2) + '\n');
    process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
  }
}
