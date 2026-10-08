import { mkdir, readFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { config, runtimePaths, projectRoot } from '../core/config.js';
import { TaobaoError } from '../core/errors.js';
import { rpc } from './protocol.js';

async function manifest(paths) { try { return JSON.parse(await readFile(paths.manifest, 'utf8')); } catch { return null; } }

const PACKAGED = typeof __TAOBAO_PACKAGED__ !== 'undefined' && __TAOBAO_PACKAGED__;

/**
 * Where to find the daemon entry point.
 *
 * A packaged release ships `daemon.cjs` next to `cli.cjs`, but a source checkout
 * keeps it at `src/service/daemon.js`. Resolve by what is actually on disk
 * instead of assuming the development layout: a packaged CLI taking the source
 * path dies with "Cannot find module ...src/service/daemon.js", and because the
 * daemon never starts, every later command restarts the browser.
 */
export function pickDaemonEntry({ root, packaged, onDisk }) {
  const candidates = packaged
    ? [join(root, 'daemon.cjs'), join(root, 'src/service/daemon.js')]
    : [join(root, 'src/service/daemon.js'), join(root, 'daemon.cjs')];
  return candidates.find(onDisk) ?? candidates[0];
}

export function resolveDaemonEntry() {
  return process.env.TAOBAO_SEARCH_DAEMON_ENTRY
    || pickDaemonEntry({ root: projectRoot, packaged: PACKAGED, onDisk: existsSync });
}

export async function daemonStatus(paths) {
  const value = await manifest(paths);
  if (!value) return null;
  try { return await rpc(paths, value.token, 'status'); } catch { return null; }
}

export async function startDaemon(input = {}) {
  const options = config(input), paths = runtimePaths(options.runtimeDir || undefined);
  const existing = await daemonStatus(paths);
  if (existing) return existing;
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const log = await open(paths.log, 'a', 0o600);
  const entry = resolveDaemonEntry();
  const encodedConfig = `--config=${Buffer.from(JSON.stringify(options)).toString('base64')}`;
  let child;
  if (process.platform === 'win32' && process.env.TAOBAO_SEARCH_DAEMON_ENTRY) {
    // CreateProcess with DETACHED_PROCESS and no inherited handles keeps the
    // daemon independent of the outer PowerShell caller and its output pipes.
    const literal = value => "'" + value.replace(/'/g, "''") + "'";
    const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${literal(join(projectRoot, 'detach-daemon.ps1'))})))`;
    child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
        TAOBAO_DETACHED_EXE: process.execPath, TAOBAO_DETACHED_COMMAND: '"' + process.execPath + '" "' + entry + '" ' + encodedConfig },
    });
  } else {
    child = spawn(process.execPath, [entry, encodedConfig], { cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  }
  let launchError;
  child.on('error', error => { launchError = error; });
  child.unref();
  await log.close();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (launchError) throw new TaobaoError('SERVICE_START_FAILED', `后台启动失败：${launchError.message}`);
    const status = await daemonStatus(paths);
    if (status) return status;
    await delay(100);
  }
  throw new TaobaoError('SERVICE_START_FAILED', `常驻服务未启动，请查看 ${paths.log}。`);
}

export class TaobaoClient {
  constructor(options = {}) {
    const { onEvent = () => {}, autoStart = true, ...daemonOptions } = options;
    this.options = config(daemonOptions);
    this.paths = runtimePaths(this.options.runtimeDir || undefined);
    this.onEvent = onEvent;
    this.autoStart = autoStart;
  }

  async request(operation, params, { signal } = {}) {
    if (!await daemonStatus(this.paths)) {
      if (!this.autoStart) throw new TaobaoError('SERVICE_NOT_RUNNING', '常驻服务未启动。');
      await startDaemon(this.options);
    }
    const value = await manifest(this.paths);
    let jobId;
    const abortJob = () => { if (jobId) void rpc(this.paths, value.token, 'cancel', { jobId }).catch(() => {}); };
    signal?.addEventListener('abort', abortJob, { once: true });
    try {
      return await rpc(this.paths, value.token, operation, params, {
        signal, onEvent: this.onEvent,
        onAccepted: id => { jobId = id; this.onEvent({ state: 'queued', jobId: id, message: `任务已提交：${id}` }); if (signal?.aborted) abortJob(); },
      });
    } finally { signal?.removeEventListener('abort', abortJob); }
  }

  search(keyword, options = {}, control = {}) { return this.request('search', { keyword, options }, control); }
  getSpecs(itemId, options = {}, control = {}) { return this.request('getSpecs', { itemId, options }, control); }
  getDetail(itemId, spec, options = {}, control = {}) { return this.request('getDetail', { itemId, spec, options }, control); }
  batch(input, control = {}) { return this.request('batch', input, control); }
  async status() { return await daemonStatus(this.paths) || { ok: true, operation: 'status', data: { running: false }, error: null }; }
  async stop() { const value = await manifest(this.paths); return value && await daemonStatus(this.paths) ? rpc(this.paths, value.token, 'stop') : { ok: true, operation: 'stop', data: { stopped: true, alreadyStopped: true }, error: null }; }
  async getJob(jobId) { const value = await manifest(this.paths); if (!value) throw new TaobaoError('SERVICE_NOT_RUNNING', '服务未启动。'); return rpc(this.paths, value.token, 'getJob', { jobId }); }
}
