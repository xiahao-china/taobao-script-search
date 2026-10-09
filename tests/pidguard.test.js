import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon, TaobaoClient } from '../src/service/client.js';
import { pidAlive } from '../src/service/pid.js';

const sleepers = [];
afterEach(() => { for (const child of sleepers.splice(0)) child.kill(); });

function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  sleepers.push(child);
  return child.pid;
}

test('startDaemon refuses when a live manifest pid owns the runtime without a pipe', { skip: process.platform !== 'win32' }, async () => {
  const dir = join(tmpdir(), `taobao-pidguard-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const pid = spawnSleeper();
  await writeFile(join(dir, 'daemon.json'), JSON.stringify({ version: 1, pid, token: 'x', startedAt: new Date().toISOString() }));
  try {
    await assert.rejects(() => startDaemon({ runtimeDir: dir }), error => {
      assert.equal(error.code, 'SERVICE_START_FAILED');
      assert.match(error.message, /已在运行/);
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop force-kills a hung daemon pid and clears the manifest', { skip: process.platform !== 'win32' }, async () => {
  const dir = join(tmpdir(), `taobao-pidstop-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const pid = spawnSleeper();
  await writeFile(join(dir, 'daemon.json'), JSON.stringify({ version: 1, pid, token: 'x', startedAt: new Date().toISOString() }));
  const client = new TaobaoClient({ runtimeDir: dir, autoStart: false });
  const result = await client.stop();
  assert.equal(result.data.forceKilled, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const manifestGone = await readFile(join(dir, 'daemon.json'), 'utf8').then(() => false, error => error.code === 'ENOENT');
  assert.equal(manifestGone, true);
  await rm(dir, { recursive: true, force: true });
});

test('pidAlive reports false for a terminated pid whose handles may linger', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise(resolve => child.on('exit', resolve));
  child.unref();
  // The pid could in theory be reused within this window; poll briefly and
  // require a definitive dead verdict, which the signal-0-only check (pre-fix)
  // could not give for a lingering-handle ghost.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(`pid ${pid} still reported alive 10s after exit`);
});
