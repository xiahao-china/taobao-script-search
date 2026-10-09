import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTaobaoClient, startDaemon } from './index.js';
import { failure, TaobaoError } from './core/errors.js';
import { browserStatus } from './browser/chromium.js';
import { installChromium } from './browser/install.js';
import { installAutostart, removeAutostart } from './service/autostart.js';

const help = `淘宝查询：JavaScript / Playwright 常驻服务，无 Browser Use
  taobao start [--cdp-url 本机地址] [--approval-timeout 120]
  taobao status
  taobao search <关键词> [--limit 20] [--page 1] [--sort default]
  taobao specs <商品ID>
  taobao detail <商品ID> --spec-id <规格ID>
  taobao detail <商品ID> --spec '{"selections":[...]}'
  taobao detail <商品ID> --labels '["完整规格标签"]'
  taobao batch --file examples/batch.json [--output artifacts/result.json]
  taobao job <任务ID>
  taobao browser info
  taobao browser install <chrome-win64.zip | 已解压目录>
  taobao autostart [--remove]  注册/移除开机自启守护服务（登录后隐藏常驻，并立即拉起）
  taobao stop
查询可加 --refresh；首次查询自动启动服务。
浏览器优先复用本机日常 Chrome；精简版不含内核，缺内核时用 browser install 安装，或改用完整版发布包。
服务参数须在 start 时指定：--cdp-user-data-dir、--timeout、--manual-timeout、--no-wait、--max-product-tabs、--runtime-dir、--portable-browser。
默认等待人工登录/验证，不计入数据等待超时；Ctrl+C 取消当前任务。`;

export async function main() {
  let operation = 'cli';
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, limit: { type: 'string' }, page: { type: 'string' }, sort: { type: 'string' },
      'spec-id': { type: 'string' }, spec: { type: 'string' }, labels: { type: 'string' },
      file: { type: 'string' }, output: { type: 'string' }, refresh: { type: 'boolean' },
      'cdp-url': { type: 'string' }, 'cdp-user-data-dir': { type: 'string' }, 'runtime-dir': { type: 'string' },
      timeout: { type: 'string' }, 'approval-timeout': { type: 'string' }, 'manual-timeout': { type: 'string' },
      'no-wait': { type: 'boolean' }, 'max-product-tabs': { type: 'string' },
      'portable-browser': { type: 'boolean' }, remove: { type: 'boolean' },
    } });
    if (values.help || !positionals.length) { console.log(help); return; }
    operation = positionals[0];
    const daemonOptions = {
      ...(values['cdp-url'] ? { cdpUrl: values['cdp-url'] } : {}),
      ...(values['cdp-user-data-dir'] ? { userDataDir: values['cdp-user-data-dir'] } : {}),
      ...(values['runtime-dir'] ? { runtimeDir: values['runtime-dir'] } : {}),
      ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
      ...(values['approval-timeout'] ? { approvalTimeoutMs: Number(values['approval-timeout']) * 1000 } : {}),
      ...(values['manual-timeout'] ? { manualTimeoutMs: Number(values['manual-timeout']) * 1000 } : {}),
      ...(values['max-product-tabs'] ? { maxProductTabs: Number(values['max-product-tabs']) } : {}),
      ...(values['no-wait'] ? { waitForLogin: false } : {}),
      ...(values['portable-browser'] ? { portableBrowser: true } : {}),
    };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    const client = createTaobaoClient({ ...daemonOptions, onEvent: value => { if (value.message) console.error(value.message); } });
    const queryOptions = {
      ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values.page ? { page: Number(values.page) } : {}),
      ...(values.sort ? { sort: values.sort } : {}), ...(values.refresh ? { forceRefresh: true } : {}),
    };
    let result;
    const control = { signal: controller.signal };
    if (operation === 'start') result = await startDaemon(daemonOptions);
    else if (operation === 'status') result = await client.status();
    else if (operation === 'stop') result = await client.stop();
    else if (operation === 'job') result = await client.getJob(positionals[1]);
    else if (operation === 'search') result = await client.search(positionals[1], queryOptions, control);
    else if (operation === 'specs') result = await client.getSpecs(positionals[1], queryOptions, control);
    else if (operation === 'detail') {
      const selections = [values['spec-id'], values.spec, values.labels].filter(value => value !== undefined);
      if (selections.length !== 1) throw new TaobaoError('INVALID_ARGUMENT', 'detail 须且只能提供 --spec-id、--spec 或 --labels 之一。');
      const spec = values['spec-id'] ? { specId: values['spec-id'] } : values.spec ? JSON.parse(values.spec) : { labels: JSON.parse(values.labels) };
      result = await client.getDetail(positionals[1], spec, queryOptions, control);
    } else if (operation === 'batch') {
      if (!values.file) throw new TaobaoError('INVALID_ARGUMENT', 'batch 必须指定 --file。');
      const input = JSON.parse(await readFile(resolve(values.file), 'utf8'));
      if (values.refresh) {
        for (const task of input.tasks || []) task.params.options = { ...task.params.options, forceRefresh: true };
        for (const item of input.products || []) item.options = { ...item.options, forceRefresh: true };
        if (input.searches) input.searches = input.searches.map(value => typeof value === 'string' ? { keyword: value, options: { forceRefresh: true } } : { ...value, options: { ...value.options, forceRefresh: true } });
      }
      result = await client.batch(input, control);
    } else if (operation === 'browser') {
      // Kernel inspection and installation touch the shared cache only, so they
      // never start or talk to the resident service.
      const action = positionals[1] || 'info';
      if (action === 'info') result = { ok: true, operation: 'browser', data: browserStatus(), error: null };
      else if (action === 'install') {
        if (!positionals[2]) throw new TaobaoError('INVALID_ARGUMENT', 'browser install 需要 chrome-win64.zip 或已解压目录的路径。');
        result = { ok: true, operation: 'browser', data: await installChromium(positionals[2]), error: null };
      } else throw new TaobaoError('INVALID_ARGUMENT', `未知 browser 子命令：${action}。可用：info、install。`);
    } else if (operation === 'autostart') {
      // Registering the Startup entry is instantaneous; starting the daemon
      // through the regular path makes the same command usable as an
      // immediate fix inside the user's own terminal.
      const registered = values.remove ? await removeAutostart() : await installAutostart(daemonOptions);
      const service = values.remove ? null : await startDaemon(daemonOptions);
      result = { ok: true, operation: 'autostart', data: { ...registered, removed: Boolean(values.remove), service }, error: null };
    } else throw new TaobaoError('INVALID_ARGUMENT', `未知命令：${operation}`);
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
