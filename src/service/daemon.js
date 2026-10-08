import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, runtimePaths } from '../core/config.js';
import { TaobaoEngine } from '../core/engine.js';
import { failure, TaobaoError } from '../core/errors.js';
import { consumeLines, send, protocolVersion } from './protocol.js';

export async function createDaemon(input = {}, dependencies = {}) {
  const options = config(input), paths = runtimePaths(options.runtimeDir || undefined);
  const token = randomBytes(32).toString('hex');
  const jobs = new Map(), sockets = new Set();
  let queue = Promise.resolve(), currentJob = null, stopping = false;
  const event = value => {
    if (!currentJob) return;
    currentJob.state = value.state;
    currentJob.progress = value;
    send(currentJob.socket, { kind: 'event', jobId: currentJob.id, event: value });
  };
  const engine = dependencies.engine || new TaobaoEngine(options, event);
  if (dependencies.engine) engine.onEvent = event;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let handled = false;
    consumeLines(socket, message => {
      if (handled) return;
      handled = true;
      if (message.token !== token || message.version !== protocolVersion) {
        send(socket, { kind: 'error', error: { code: 'SERVICE_AUTH_FAILED', message: 'IPC 令牌或协议版本不匹配。' } }); socket.end(); return;
      }
      const result = value => { send(socket, { kind: 'result', result: value }); socket.end(); };
      if (message.operation === 'status') {
        result({ ok: true, operation: 'status', data: { running: true, pid: process.pid, config: { timeoutMs: options.timeoutMs, manualTimeoutMs: options.manualTimeoutMs, waitForLogin: options.waitForLogin, maxProductTabs: options.maxProductTabs, cacheTtlMs: options.cacheTtlMs }, ...engine.status(), jobs: [...jobs.values()].map(job => ({ jobId: job.id, state: job.state, operation: job.operation, progress: job.progress, finished: Boolean(job.result) })) }, error: null }); return;
      }
      if (message.operation === 'getJob') {
        const job = jobs.get(message.params?.jobId);
        result(job ? { ok: true, operation: 'getJob', data: { jobId: job.id, state: job.state, result: job.result || null }, error: null } : failure('getJob', new TaobaoError('JOB_NOT_FOUND', '任务不存在。'))); return;
      }
      if (message.operation === 'cancel') {
        const job = jobs.get(message.params?.jobId);
        job?.controller.abort();
        result({ ok: Boolean(job), operation: 'cancel', data: { jobId: job?.id || null }, error: null }); return;
      }
      if (message.operation === 'stop') {
        result({ ok: true, operation: 'stop', data: { stopped: true }, error: null });
        void close(); return;
      }
      if (stopping || !['search', 'getSpecs', 'getDetail', 'batch'].includes(message.operation)) {
        result(failure(message.operation, new TaobaoError('INVALID_ARGUMENT', '无效任务或服务正在退出。'))); return;
      }
      if (jobs.size >= options.maxJobs) {
        for (const [id, job] of jobs) if (job.result) { jobs.delete(id); break; }
        if (jobs.size >= options.maxJobs) { result(failure(message.operation, new TaobaoError('QUEUE_FULL', '任务队列已满。'))); return; }
      }
      const job = { id: randomUUID(), operation: message.operation, params: message.params || {}, state: 'queued', socket, controller: new AbortController(), progress: null, result: null };
      jobs.set(job.id, job);
      send(socket, { kind: 'accepted', jobId: job.id });
      queue = queue.then(async () => {
        currentJob = job;
        event({ state: 'running', message: '任务开始。' });
        try { job.result = await engine.execute(job.operation, job.params, job.controller.signal); }
        catch (error) { job.result = failure(job.operation, error); }
        job.state = job.result.ok ? 'completed' : job.result.error?.code === 'CANCELLED' ? 'cancelled' : 'failed';
        send(socket, { kind: 'result', jobId: job.id, result: job.result }); socket.end();
        currentJob = null;
      }).catch(error => { job.result = failure(job.operation, error); job.state = 'failed'; currentJob = null; });
    }, error => { send(socket, { kind: 'error', error: { code: 'INVALID_ARGUMENT', message: String(error.message) } }); socket.end(); });
  });

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  // A stale Unix socket belongs to this exact project runtime only.
  if (process.platform !== 'win32') {
    try {
      const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
      try { process.kill(manifest.pid, 0); } catch { await unlink(paths.endpoint).catch(() => {}); }
    } catch { /* First run. */ }
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, resolve); });
  await writeFile(paths.manifest, JSON.stringify({ version: protocolVersion, pid: process.pid, token, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });

  async function close() {
    if (stopping) return;
    stopping = true;
    for (const job of jobs.values()) if (!job.result) job.controller.abort();
    await engine.close();
    for (const socket of sockets) socket.end();
    await new Promise(resolve => server.close(resolve));
    try { const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')); if (manifest.token === token) await unlink(paths.manifest); } catch { /* Already removed. */ }
  }
  return { paths, token, server, engine, close };
}

if (typeof __TAOBAO_PACKAGED__ === 'undefined' && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const argument = process.argv.find(value => value.startsWith('--config='));
    const input = argument ? JSON.parse(Buffer.from(argument.slice(9), 'base64').toString('utf8')) : {};
    const daemon = await createDaemon(input);
    const trace = message => { try { appendFileSync(join(daemon.paths.directory, 'daemon-exit.log'), `[${new Date().toISOString()}] ${message}\n`); } catch { /* Diagnostics must never break the daemon. */ } };
    trace(`started pid=${process.pid} config=${JSON.stringify(input).slice(0, 120)}`);
    process.on('exit', code => trace(`exit code=${code}`));
    process.on('beforeExit', code => trace(`beforeExit code=${code}`));
    process.on('uncaughtException', error => trace(`uncaughtException: ${error.stack?.split('\n')[0]}`));
    process.on('unhandledRejection', error => trace(`unhandledRejection: ${String(error).split('\n')[0]}`));
    process.on('SIGINT', () => { trace('SIGINT'); void daemon.close(); });
    process.on('SIGTERM', () => { trace('SIGTERM'); void daemon.close(); });
    process.on('SIGHUP', () => { trace('SIGHUP'); void daemon.close(); });
  } catch (error) {
    console.error(String(error.message).split('Call log:')[0]);
    process.exitCode = 1;
  }
}
