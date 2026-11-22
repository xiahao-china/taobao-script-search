import { parseArgs } from 'node:util';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { failure, TaobaoError, getErrorCode, getErrorMessage } from './core/errors.js';
import { loadCookies, saveCookies, mergeCookieString, cookieSummary, rootCookiePath } from './core/cookie-store.js';
import { MtopAdapter } from './adapters/taobao/mtop.js';
import { ShopSearchAdapter } from './adapters/taobao/shop-search.js';
import type {
  BatchInput,
  BatchProgress,
  CliEnvelope,
  CookieSummary,
  OperationMeta,
  SdkResult,
  SearchOptions,
  SearchSort,
  SpecInput,
} from './types.js';

const help = `淘宝查询：纯 HTTP MTOP 直连（零浏览器依赖，即用即调）
  taobao search <关键词> [--limit 20] [--page 1] [--sort default]
  taobao specs <商品ID>
  taobao detail <商品ID> --spec-id <规格ID> | --spec '{...}' | --labels '[...]' | --default [--reviews]
      --reviews 附带评价计数（totalFuzzy 模糊总数 / foldedDefault 默认好评数，多 1 次请求）；
      输出 store 块含店铺类型（isTmall）/DSR 三项分/质量分/店铺标签（零额外请求；
      H5 详情路径无店铺数据，此时为 null）。detail 额外串联一次店铺接口，
      附带 fansNum（粉丝数）/ifHideFansNum/goldenSeller（金牌卖家）——失败静默降级，
      不影响 detail 本身。
  taobao batch --file <批量清单.json> [--output 结果.json]
      清单格式：{"searches":[{"keyword":"...","options":{"limit":5}}],
                "products":[{"itemId":"...","specs":[{"labels":["..."]}|null]}]}
      specs 传 null 时该商品只返回规格树；输出含 total/succeeded/failed 统计。
  taobao orders [--page 1] [--tab all] [--pages N] [--output 订单.json]
      已买到的宝贝（购物记录）。服务端固定每页 15 条；--pages N 从 --page 起
      连翻 N 页（页间隔走全局限速）。tabCode 仅实测过 all；金额为字符串。
  taobao shop-search <关键词> <店铺URL或shopId> [--page 1] [--pages 1] [--output 结果.json]
      店铺内搜索。店铺引用支持完整 URL（https://shop123.taobao.com/... 或昵称子域名页）
      或数字 shopId。价格经字体反爬还原（划线价/现价），解不出时 priceText=null、
      priceUnknown=true。wid（店铺挂件号）自动提取并缓存于 .runtime/shop-wid.json；
      每次搜索先抓一次店铺页配对价格字体，全程走全局限速。
  taobao cart-list
      查看购物车当前内容（只读）。返回条目列表（cartId/itemId/规格/数量/实价/店铺）
      与结算汇总（勾选数/合计）。登录态接口，走 ecode=1。
  taobao cart-add <商品ID> [--sku-id <规格ID>] [--quantity 1]
      加入购物车（写操作）。无规格商品不传 --sku-id；有规格商品用 specs 输出的
      skuId。加购后自动回读购物车核对（entryFound=true 为确认成功）。PC 网页
      端点实现，需 Cookie 含 _tb_token_（浏览器登录态自带）。
  taobao cart-remove <cartId>
      从购物车删除条目（写操作，不可逆）。cartId 用 cart-list 输出的条目 ID。
      走 mtop.trade.update.bag 4.0，删除后自动回读核对（entryGone=true 为确认
      成功）。共 3 次请求，全程走全局限速。
  taobao sync-cookie --cookie-string "a=b; c=d"   导入 Cookie（或 --stdin 从管道读入）
首次使用：复制仓库根目录 cookie.example.json 为 cookie.json，把 cookie 字段替换成
浏览器里 taobao.com 的完整 Cookie 字符串（获取方法见 README「配置 Cookie」）。
cookie.json 只读不被程序改写；签名令牌自动续签，登录态失效时更新 cookie.json 即可
（已存在 cookie.json 时 sync-cookie 仅刷新令牌缓存，登录态以 cookie.json 为准）。
内置限速：相邻 MTOP 请求间隔 5–10 秒（跨进程生效）。错误细分：AUTH_REQUIRED = 登录态
失效（更新 Cookie 后重试）；RISK_CONTROL = 风控拦截 RGV587（与登录态无关，程序刻意不
自动重试——等待几分钟并在浏览器正常访问一次 taobao.com 后再试；batch 中触发会立即终
止剩余条目，避免带坏状态继续撞接口）。
请求日志：.runtime/log/mtop-request-log.jsonl 每行记录一次真实请求（时间/接口/结果/等待与
耗时），被风控或异常时用它复盘查询节奏；操作日志：.runtime/log/mtop-operation-log.jsonl
每行记录一次业务查询（时间/查询类型 search·specs·detail·orders·shop-search·cart-*/入参/完整结果内容或错误），
查「当时搜了什么、搜到了什么」用它。两份日志均超 5MB 轮转为同文件夹 .old，可随时整文件删除。`;

interface CliValues {
  help?: boolean;
  limit?: string;
  page?: string;
  sort?: string;
  pages?: string;
  tab?: string;
  'spec-id'?: string;
  spec?: string;
  labels?: string;
  default?: boolean;
  'sku-id'?: string;
  quantity?: string;
  reviews?: boolean;
  file?: string;
  output?: string;
  'cookie-string'?: string;
  stdin?: boolean;
  'runtime-dir'?: string;
  timeout?: string;
}

function envelope<T>(operation: string, payload: SdkResult<T>): CliEnvelope<T, OperationMeta> {
  return { ok: true, operation, data: payload.data, error: null, meta: payload.meta };
}

// 命令行 JSON 入参/清单文件解析失败必须归类为 INVALID_ARGUMENT，
// 裸 JSON.parse 的 SyntaxError 会被顶层兜底成 INTERNAL_ERROR。
function parseJsonInput(raw: string, label: string): unknown {
  try { return JSON.parse(raw) as unknown; }
  catch (error: unknown) { throw new TaobaoError('INVALID_ARGUMENT', `${label} 不是合法的 JSON：${getErrorMessage(error)}`); }
}

async function readBatchFile(path: string): Promise<BatchInput> {
  let text: string;
  try { text = await readFile(resolve(path), 'utf8'); }
  catch (error: unknown) { throw new TaobaoError('INVALID_ARGUMENT', `批量清单文件不可读（${path}）：${getErrorMessage(error)}`); }
  return parseJsonInput(text, '批量清单文件') as BatchInput;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += String(chunk); });
    process.stdin.on('end', () => resolvePromise(text.trim()));
    process.stdin.on('error', reject);
  });
}

async function syncCookie(values: CliValues): Promise<CliEnvelope<CookieSummary, null>> {
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

async function mtopCommand(
  operation: string,
  positionals: string[],
  values: CliValues,
  control: { signal: AbortSignal },
): Promise<CliEnvelope<unknown, OperationMeta>> {
  const runtimeDir = values['runtime-dir'] || null;
  const store = await loadCookies(runtimeDir);
  if (!cookieSummary(store).hasLoginState) {
    throw new TaobaoError('AUTH_REQUIRED',
      '尚未配置淘宝登录 Cookie。两种配置方式：'
      + '1) 复制仓库根目录 cookie.example.json 为 cookie.json，把 cookie 字段替换为浏览器中 taobao.com 的完整 Cookie 字符串（F12 → Network → 任意请求 → Cookie 请求头）；'
      + '2) 执行 taobao sync-cookie --cookie-string "name=value; ..."。详见 README「配置 Cookie」。');
  }
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = Number(values.timeout);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new TaobaoError('INVALID_ARGUMENT', 'timeout 须为正数（单位：秒）。');
    timeoutMs = parsed * 1000;
  }
  const adapter = new MtopAdapter({
    runtimeDir,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const queryOptions: SearchOptions = {
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.page ? { page: Number(values.page) } : {}),
    ...(values.sort ? { sort: values.sort as SearchSort } : {}),
  };
  if (operation === 'search') return envelope('search', await adapter.search(positionals[1] ?? '', queryOptions, control.signal));
  if (operation === 'shop-search') {
    if (!positionals[1] || !positionals[2]) {
      throw new TaobaoError('INVALID_ARGUMENT', 'shop-search 需要 <关键词> 和 <店铺URL或shopId> 两个参数。');
    }
    const shopAdapter = new ShopSearchAdapter({
      runtimeDir,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    const pages = Number(values.pages || 1);
    return envelope('shop-search', await shopAdapter.shopSearch(positionals[1], positionals[2],
      { page: Number(values.page || 1), pages }, control.signal));
  }
  if (operation === 'specs') return envelope('specs', await adapter.getSpecs(positionals[1] ?? '', queryOptions as Record<string, unknown>, control.signal));
  if (operation === 'orders') {
    const page = Number(values.page || 1);
    const pages = Number(values.pages || 1);
    return envelope('orders', await adapter.getOrders(
      { page, pages, ...(values.tab ? { tab: values.tab } : {}) },
      control.signal,
    ));
  }
  if (operation === 'cart-list') return envelope('cart-list', await adapter.getCartList(control.signal));
  if (operation === 'cart-add') {
    if (!positionals[1]) throw new TaobaoError('INVALID_ARGUMENT', 'cart-add 需要 <商品ID> 参数（有规格商品另传 --sku-id）。');
    const quantity = Number(values.quantity || 1);
    return envelope('cart-add', await adapter.addToCart(positionals[1],
      { skuId: values['sku-id'] || null, quantity }, control.signal));
  }
  if (operation === 'cart-remove') {
    if (!positionals[1]) throw new TaobaoError('INVALID_ARGUMENT', 'cart-remove 需要 <cartId> 参数（cart-list 输出的条目 ID）。');
    return envelope('cart-remove', await adapter.removeFromCart(positionals[1], control.signal));
  }
  if (operation === 'detail') {
    const selections = [values['spec-id'], values.spec, values.labels, values.default].filter(value => value !== undefined);
    if (selections.length !== 1) throw new TaobaoError('INVALID_ARGUMENT', 'detail 须且只能提供 --spec-id、--spec、--labels、--default 之一。');
    const spec: SpecInput = values['spec-id'] ? { specId: values['spec-id'] }
      : values.spec ? (parseJsonInput(values.spec, '--spec') as SpecInput)
      : values.labels ? { labels: parseJsonInput(values.labels, '--labels') as string[] }
      : { kind: 'default' };
    const itemId = positionals[1] ?? '';
    let result = await adapter.getDetail(itemId, spec, queryOptions as Record<string, unknown>, control.signal);
    if (values.reviews) {
      const summary = await adapter.getReviewSummary(itemId, control.signal);
      result = { ...result, data: { ...result.data, reviewSummary: summary.data }, meta: { ...result.meta, rateProvider: summary.meta.provider } };
    }
    return envelope('detail', result);
  }
  if (!values.file) throw new TaobaoError('INVALID_ARGUMENT', 'batch 必须指定 --file。');
  const input = await readBatchFile(values.file);
  const outputPath = values.output ? resolve(values.output) : null;
  const onProgress = outputPath ? async (progress: BatchProgress): Promise<void> => {
    await mkdir(dirname(outputPath), { recursive: true });
    const body = JSON.stringify({
      ok: false, operation: 'batch', partial: true, data: progress, error: null,
      meta: { provider: 'mtop-http', observedAt: new Date().toISOString() },
    }, null, 2) + '\n';
    const temp = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, body);
    try { await rename(temp, outputPath); }
    catch { await writeFile(outputPath, body).catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
  } : undefined;
  return envelope('batch', await adapter.batch(input, control.signal, { onProgress }));
}

export async function main(): Promise<void> {
  let operation = 'cli';
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, page: { type: 'string' }, sort: { type: 'string' },
        pages: { type: 'string' }, tab: { type: 'string' },
        'spec-id': { type: 'string' }, spec: { type: 'string' }, labels: { type: 'string' }, default: { type: 'boolean' },
        'sku-id': { type: 'string' }, quantity: { type: 'string' },
        reviews: { type: 'boolean' },
        file: { type: 'string' }, output: { type: 'string' },
        'cookie-string': { type: 'string' }, stdin: { type: 'boolean' },
        'runtime-dir': { type: 'string' }, timeout: { type: 'string' },
      },
    });
    const cliValues = values as CliValues;
    if (cliValues.help || !positionals.length) { console.log(help); return; }
    operation = positionals[0] ?? 'cli';
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    let result: CliEnvelope<unknown, OperationMeta | null>;
    const control = { signal: controller.signal };
    try {
      if (operation === 'sync-cookie') result = await syncCookie(cliValues);
      else if (['search', 'specs', 'detail', 'batch', 'orders', 'shop-search', 'cart-list', 'cart-add', 'cart-remove'].includes(operation)) {
        result = await mtopCommand(operation, positionals, cliValues, control);
      } else {
        throw new TaobaoError('INVALID_ARGUMENT', `未知命令：${operation}。可用：search / specs / detail / shop-search / batch / orders / cart-list / cart-add / cart-remove / sync-cookie。`);
      }
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    const rendered = JSON.stringify(result, null, 2) + '\n';
    if (cliValues.output) { const path = resolve(cliValues.output); await mkdir(dirname(path), { recursive: true }); await writeFile(path, rendered); }
    process.stdout.write(rendered);
    if (!result.ok) process.exitCode = 1;
  } catch (error: unknown) {
    process.stdout.write(JSON.stringify(failure(operation, error), null, 2) + '\n');
    process.exitCode = getErrorCode(error) === 'CANCELLED' ? 130 : 1;
  }
}
