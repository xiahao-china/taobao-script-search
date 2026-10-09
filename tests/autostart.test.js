import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installAutostart, removeAutostart } from '../src/service/autostart.js';

const dir = join(tmpdir(), `taobao-autostart-test-${process.pid}`);
const runtimeDir = join(dir, 'runtime');

test('autostart writes a hidden-run VBS with the baked runtime dir and removes cleanly', async () => {
  process.env.TAOBAO_SEARCH_AUTOSTART_DIR = dir;
  try {
    const installed = await installAutostart({ runtimeDir });
    assert.equal(installed.script, join(dir, 'TaobaoSearchDaemon.vbs'));
    assert.equal(installed.runtimeDir, runtimeDir);
    const text = await readFile(installed.script, 'utf8');
    assert.match(text, /^CreateObject\("WScript\.Shell"\)\.Run "/);
    assert.match(text, /", 0, False$/);
    assert.ok(text.includes('""'), 'exe and entry paths must be double-quoted inside the Run string');
    const expectedConfig = Buffer.from(JSON.stringify({ runtimeDir })).toString('base64');
    assert.ok(text.includes(`--config=${expectedConfig}`), 'the daemon config must bake the runtime dir');
    const removed = await removeAutostart();
    assert.equal(removed.removed, true);
    const again = await removeAutostart();
    assert.equal(again.removed, false);
  } finally {
    delete process.env.TAOBAO_SEARCH_AUTOSTART_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
