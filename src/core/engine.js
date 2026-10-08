import { performance } from 'node:perf_hooks';
import { config } from './config.js';
import { failure, TaobaoError, checkAbort } from './errors.js';
import { BrowserSession } from '../browser/session.js';
import { SearchAdapter } from '../adapters/taobao/search.js';
import { DetailAdapter } from '../adapters/taobao/detail.js';

const operations = new Set(['search', 'getSpecs', 'getDetail']);

/**
 * Consecutive keyword searches reuse one search tab, so a long list walks the
 * page through every result in a burst. Taobao's rate limiter answers that with
 * a slider/verification wall and, before that, the tab visibly jumps between
 * result pages. Keep the per-call ceiling low and require an explicit spread of
 * separate calls instead.
 */
export const MAX_BATCH_SEARCHES = 3;

export function expandBatch(input) {
  let tasks = input.tasks;
  if (!tasks) {
    const searches = input.searches || [];
    if (searches.length > MAX_BATCH_SEARCHES) {
      throw new TaobaoError('INVALID_ARGUMENT', `一次最多提交 ${MAX_BATCH_SEARCHES} 个关键词（收到 ${searches.length} 个）。连续搜索会触发淘宝风控并导致搜索页反复跳转，请拆成多次调用，每次间隔 ≥25 秒。`);
    }
    tasks = [];
    for (const value of searches) tasks.push({ operation: 'search', params: typeof value === 'string' ? { keyword: value } : value });
    for (const product of input.products || []) {
      tasks.push({ operation: 'getSpecs', params: { itemId: product.itemId, options: product.options || {} } });
      for (const spec of product.specs || []) tasks.push({ operation: 'getDetail', params: { itemId: product.itemId, spec, options: product.options || {} } });
    }
  }
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 200 || tasks.some(task => !operations.has(task.operation) || !task.params || typeof task.params !== 'object')) throw new TaobaoError('INVALID_ARGUMENT', '批量任务须为 1–200 个 search/getSpecs/getDetail 任务。');
  return tasks;
}

export class TaobaoEngine {
  constructor(options = {}, onEvent = () => {}, session = null) {
    this.options = config(options);
    this.onEvent = onEvent;
    this.session = session || new BrowserSession(this.options, onEvent);
    this.searchAdapter = new SearchAdapter(this.session, this.options, onEvent);
    this.detailAdapter = new DetailAdapter(this.session, this.options, onEvent);
    this.cache = new Map();
    this.tasksRun = 0;
  }

  async execute(operation, params = {}, signal, overrides = {}) {
    const started = performance.now();
    try {
      checkAbort(signal);
      if (operation === 'batch') return await this.batch(params, signal);
      if (!operations.has(operation)) throw new TaobaoError('INVALID_ARGUMENT', 'operation 必须为 search、getSpecs 或 getDetail。');
      const options = { ...params.options, ...overrides };
      const key = JSON.stringify([operation, params]);
      const hit = this.cache.get(key);
      if (!options.forceRefresh && hit && Date.now() - hit.savedAt < this.options.cacheTtlMs) {
        return { ...structuredClone(hit.result), meta: { ...hit.result.meta, cached: true, elapsedMs: Math.round(performance.now() - started) } };
      }
      const adapterOptions = { ...options, refreshPage: options.refreshPage ?? Boolean(options.forceRefresh) };
      let value;
      if (operation === 'search') {
        value = await this.searchAdapter.search(params.keyword, options, signal);
        this.detailAdapter.remember(value.data.items);
      } else if (operation === 'getSpecs') value = await this.detailAdapter.getSpecs(params.itemId, adapterOptions, signal);
      else value = await this.detailAdapter.getDetail(params.itemId, params.spec, adapterOptions, signal);
      this.tasksRun += 1;
      const result = { ok: true, operation, data: value.data, error: null, meta: { ...value.meta, cached: false, elapsedMs: Math.round(performance.now() - started) } };
      this.cache.set(key, { savedAt: Date.now(), result: structuredClone(result) });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      return result;
    } catch (error) {
      return failure(operation, error, { cached: false, elapsedMs: Math.round(performance.now() - started) });
    }
  }

  async batch(input, signal) {
    const tasks = expandBatch(input);
    const groups = new Map();
    tasks.forEach((task, index) => {
      const key = task.operation === 'search' ? 'search' : `item:${task.params.itemId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ task, index });
    });
    const results = Array(tasks.length), refreshed = new Set(), quotedItems = new Set();
    let blocked = null, completed = 0;
    for (const entries of groups.values()) {
      for (const { task, index } of entries) {
        if (blocked || signal?.aborted) results[index] = failure(task.operation, new TaobaoError(signal?.aborted ? 'CANCELLED' : 'SKIPPED_SESSION_REQUIRED', blocked || '任务已取消。'));
        else {
          const id = task.params.itemId;
          const forced = task.operation !== 'search' && task.params.options?.forceRefresh;
          const overrides = { ...(forced ? { refreshPage: !refreshed.has(id) } : {}), ...(task.operation === 'getDetail' ? { reuseSnapshot: quotedItems.has(id) } : {}) };
          results[index] = await this.execute(task.operation, task.params, signal, overrides);
          if (forced && results[index].ok) refreshed.add(id);
          if (task.operation === 'getDetail' && results[index].ok) quotedItems.add(id);
          if (['AUTH_REQUIRED', 'VERIFICATION_REQUIRED', 'CANCELLED'].includes(results[index].error?.code)) blocked = results[index].error.message;
        }
        completed += 1;
        this.onEvent({ state: 'running', completed, total: tasks.length, message: `批量任务 ${completed}/${tasks.length}` });
      }
    }
    const succeeded = results.filter(value => value.ok).length;
    return { ok: succeeded === results.length, operation: 'batch', data: { results, total: results.length, succeeded, failed: results.length - succeeded }, error: succeeded === results.length ? null : { code: 'BATCH_PARTIAL_FAILURE', message: '部分任务失败，详见各项结果。', details: null }, meta: { provider: 'playwright', observedAt: new Date().toISOString(), groupedByItem: true } };
  }

  status() { return { browser: this.session.status(), tasksRun: this.tasksRun, detailNavigations: this.detailAdapter.navigations, cacheEntries: this.cache.size }; }
  async close() { await this.session.close(); }
}
