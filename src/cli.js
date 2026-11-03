import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { failure, TaobaoError } from './core/errors.js';
import { loadCookies, saveCookies, mergeCookieString, cookieSummary, rootCookiePath } from './core/cookie-store.js';
import { MtopAdapter } from './adapters/taobao/mtop.js';

const help = `淘宝查询：纯 HTTP MTOP 直连（零浏览器依赖，即用即调）
  taobao search <关键词> [--limit 20] [--page 1] [--sort default]
  taobao specs <商品ID>
  taobao detail <商品ID> --spec-id <规格ID> | --spec '{...}' | --labels '[...]' | --default [--reviews]
      --reviews 附带评价计数（totalFuzzy 模糊总数 / foldedDefault 默认好评数，多 1 次请求）；
      输出 store 块含店铺类型（isTmall）/DSR 三项分/质量分/店铺标签（零额外请求；
      H5 详情路径无店铺数据，此时为 null）。
  taobao batch --file <批量清单.json> [--output 结果.json]
      清单格式：{"searches":[{"keyword":"...","options":{"limit":5}}],
                "products":[{"itemId":"...","specs":[{"labels":["..."]}|null]}]}
      specs 传 null 时该商品只返回规格树；输出含 total/succeeded/failed 统计。
  taobao orders [--page 1] [--tab all] [--pages N] [--output 订单.json]
      已买到的宝贝（购物记录）。服务端固定每页 15 条；--pages N 从 --page 起
      连翻 N 页（页间隔走全局限速）。tabCode 仅实测过 all；金额为字符串。
  taobao sync-cookie --cookie-string "a=b; c=d"   导入 Cookie（或 --stdin 从管道读入）
首次使用：复制仓库根目录 cookie.example.json 为 cookie.json，把 cookie 字段替换成
浏览器里 taobao.com 的完整 Cookie 字符串（获取方法见 README「配置 Cookie」）。
cookie.json 只读不被程序改写；签名令牌自动续签，登录态失效时更新 cookie.json 即可
（已存在 cookie.json 时 sync-cookie 仅刷新令牌缓存，登录态以 cookie.json 为准）。
内置限速：相邻 MTOP 请求间隔 5–10 秒（跨进程生效）。错误细分：AUTH_REQUIRED = 登录态
失效（更新 Cookie 后重试）；RISK_CONTROL = 风控拦截 RGV587（与登录态无关，程序刻意不
自动重试——等待几分钟并在浏览器正常访问一次 taobao.com 后再试；batch 中触发会立即终
止剩余条目，避免带坏状态继续撞接口）。`;

function envelope(operation, payload) {
  return { ok: true, operation, data: payload.data, error: null, meta: payload.meta };
}

// 命令行 JSON 入参/清单文件解析失败必须归类为 INVALID_ARGUMENT，
// 裸 JSON.parse 的 SyntaxError 会被顶层兜底成 INTERNAL_ERROR。
function parseJsonInput(raw, label) {
  try { return JSON.parse(raw); }
  catch (error) { throw new TaobaoError('INVALID_ARGUMENT', `${label} 不是合法的 JSON：${error.message}`); }
}

async function readBatchFile(path) {
  let text;
  try { text = await readFile(resolve(path), 'utf8'); }
  catch (error) { throw new TaobaoError('INVALID_ARGUMENT', `批量清单文件不可读（${path}）：${error.message}`); }
  return parseJsonInput(text, '批量清单文件');
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
  const data = cookieSummary(store);
  // 主配置存在时登录态以它为准（设计约定），导入只刷新令牌缓存——必须明说，避免误以为已生效。
  if (process.env.TAOBAO_COOKIE_FILE || existsSync(rootCookiePath())) {
    data.warning = '检测到主配置 cookie.json：后续请求的登录态仍以它为准，本次导入仅刷新 .runtime 中的签名令牌。如需更换登录态，请同步更新 cookie.json。';
  }
  return { ok: true, operation: 'sync-cookie', data, error: null, meta: null };
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
  if (operation === 'orders') {
    const page = Number(values.page || 1);
    const pages = Number(values.pages || 1);
    if (!Number.isInteger(pages) || pages < 1 || pages > 50) throw new TaobaoError('INVALID_ARGUMENT', 'pages 须为 1–50 的整数。');
    if (pages === 1) return envelope('orders', await adapter.getOrders({ page, ...(values.tab ? { tab: values.tab } : {}) }, control.signal));
    // 连续翻页：逐页请求合并。空页即止；有分页元数据时到 totalPage 提前收尾；
    // 翻过最后一页时接口会抛 NO_RESULTS——非首轮捕获后视为正常到末页，保留已拉取数据。
    const merged = [];
    let last = null;
    for (let offset = 0; offset < pages; offset++) {
      let result;
      try {
        result = await adapter.getOrders({ page: page + offset, ...(values.tab ? { tab: values.tab } : {}) }, control.signal);
      } catch (error) {
        if (error.code === 'NO_RESULTS' && offset > 0 && last) break;
        throw error;
      }
      last = result;
      merged.push(...result.data.orders);
      const totalPage = result.data.pagination?.totalPage;
      if (!result.data.orders.length || (Number.isInteger(totalPage) && page + offset >= totalPage)) break;
    }
    return envelope('orders', { data: { ...last.data, page, orders: merged }, meta: last.meta });
  }
  if (operation === 'detail') {
    const selections = [values['spec-id'], values.spec, values.labels, values.default].filter(value => value !== undefined);
    if (selections.length !== 1) throw new TaobaoError('INVALID_ARGUMENT', 'detail 须且只能提供 --spec-id、--spec、--labels、--default 之一。');
    const spec = values['spec-id'] ? { specId: values['spec-id'] }
      : values.spec ? parseJsonInput(values.spec, '--spec')
      : values.labels ? { labels: parseJsonInput(values.labels, '--labels') }
      : { kind: 'default' };
    let result = await adapter.getDetail(positionals[1], spec, queryOptions, control.signal);
    if (values.reviews) {
      const summary = await adapter.getReviewSummary(positionals[1], control.signal);
      result = { ...result, data: { ...result.data, reviewSummary: summary.data }, meta: { ...result.meta, rateProvider: summary.meta.provider } };
    }
    return envelope('detail', result);
  }
  if (!values.file) throw new TaobaoError('INVALID_ARGUMENT', 'batch 必须指定 --file。');
  const input = await readBatchFile(values.file);
  return envelope('batch', await adapter.batch(input, control.signal));
}

export async function main() {
  let operation = 'cli';
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, page: { type: 'string' }, sort: { type: 'string' },
      pages: { type: 'string' }, tab: { type: 'string' },
      'spec-id': { type: 'string' }, spec: { type: 'string' }, labels: { type: 'string' }, default: { type: 'boolean' },
      reviews: { type: 'boolean' },
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
    else if (['search', 'specs', 'detail', 'batch', 'orders'].includes(operation)) result = await mtopCommand(operation, positionals, values, control);
    else throw new TaobaoError('INVALID_ARGUMENT', `未知命令：${operation}。可用：search / specs / detail / batch / orders / sync-cookie。`);
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
