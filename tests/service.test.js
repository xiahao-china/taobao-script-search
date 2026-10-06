import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { discoverEndpoint, validateEndpoint } from '../src/browser/session.js';
import { createTaobaoClient } from '../src/index.js';
import { projectRoot } from '../src/core/config.js';
import { card, product, firstContextPage } from './fixtures.js';

// Chrome is installed in different locations across machines, so probe the known
// roots before falling back to the Playwright browser. A missing browser skips
// this test instead of reporting a false failure.
function resolveChrome() {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, 'Google/Chrome/Application/chrome.exe');
    if (existsSync(candidate)) return candidate;
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* No Playwright browser installed. */ }
  return null;
}

const chromeExecutable = resolveChrome();

test('CDP endpoint restrictions reject remote hosts and credentials', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  assert.throws(() => validateEndpoint('ws://example.com:9222'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validateEndpoint('ws://name:password@localhost:9222'), { code: 'INVALID_ARGUMENT' });
});

test('separate CLI processes share one daemon/browser and leave existing tabs/session after stop', {
  timeout: 45000,
  skip: chromeExecutable ? false : 'No Chrome or Playwright Chromium found for the shared-daemon test.',
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'taobao-service-test-'));
  const profile = join(folder, 'chrome'), runtimeDir = join(folder, 'runtime');
  const chrome = spawn(chromeExecutable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let chromeError = null;
  chrome.once('error', error => { chromeError = error; });
  let owner, client, endpoint;
  const cli = args => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, 'bin/taobao.js'), ...args, '--runtime-dir', runtimeDir], { cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolveRun({ code, value: JSON.parse(stdout), stderr }); }
      catch { reject(new Error(`CLI failed: ${stdout} ${stderr}`)); }
    });
  });
  try {
    // chrome.exe hands the browser off to its own browser process and exits 0
    // within a second, so the spawn handle is not a liveness signal. Only the
    // published CDP endpoint proves the browser came up.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (chromeError) throw new Error(`Could not start the test browser: ${chromeError.message}`);
      try { endpoint = await discoverEndpoint(profile); break; } catch { await delay(50); }
    }
    assert.ok(endpoint, 'Temporary Chrome published its debug port');
    const endpointAlive = async () => {
      try { return (await fetch(`http://127.0.0.1:${Number(new URL(endpoint).port)}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
    };
    owner = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10000 });
    const context = owner.contexts()[0], original = await firstContextPage(context);
    await original.setContent('<title>Existing tab retained</title>');
    await context.addCookies([{ name: 'test_session', value: 'existing-session', domain: 'example.test', path: '/' }]);
    let productNavigations = 0;
    await context.route('https://s.taobao.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: card() }));
    await context.route('https://item.taobao.com/**', route => {
      productNavigations++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: product({ native: true }) });
    });
    const started = await cli(['start', '--cdp-url', endpoint, '--timeout', '5']);
    assert.equal(started.value.ok, true);
    const firstPid = started.value.data.pid;
    const search = await cli(['search', 'fixture-keyword', '--limit', '1']);
    assert.equal(search.value.ok, true, JSON.stringify(search.value));
    const specs = await cli(['specs', '1001']);
    assert.equal(specs.value.ok, true, JSON.stringify(specs.value));
    const selected = specs.value.data.variants.find(value => value.skuId === '102');
    const quoted = await cli(['detail', '1001', '--spec-id', selected.specId]);
    assert.equal(quoted.value.ok, true, JSON.stringify(quoted.value));
    assert.equal(quoted.value.data.price.amount, '4.08');
    assert.equal(productNavigations, 1);
    client = createTaobaoClient({ runtimeDir, autoStart: false });
    const status = await client.status();
    assert.equal(status.data.pid, firstPid);
    assert.equal(status.data.browser.connections, 1);
    assert.equal(status.data.detailNavigations, 1);
    const cached = await client.getDetail('1001', { specId: selected.specId });
    assert.equal(cached.meta.cached, true);
    assert.equal(cached.data.price.observedAt, quoted.value.data.price.observedAt);
    assert.equal((await client.stop()).ok, true);
    // The guarantee is about the browser, not about the launcher process:
    // stop must leave the caller's browser, tabs and session untouched.
    assert.equal(await endpointAlive(), true, 'the browser still serves CDP after stop');
    assert.equal(original.isClosed(), false);
    assert.equal(await original.title(), 'Existing tab retained');
    assert.equal((await context.cookies('https://example.test'))[0].value, 'existing-session');
    const titles = await Promise.all(context.pages().map(page => page.title()));
    assert.ok(titles.includes('测试螺丝-淘宝网'));
    // Runtime authentication is kept in a separate private manifest, never in
    // the normalized output or command's stdout.
    const saved = JSON.parse(await readFile(join(runtimeDir, 'daemon.json'), 'utf8').catch(() => '{}'));
    if (saved.token) assert.ok(!JSON.stringify(quoted.value).includes(saved.token));
  } finally {
    await client?.stop().catch(() => {});
    try {
      const closing = owner?.isConnected() ? owner : endpoint ? await chromium.connectOverCDP(endpoint, { noDefaults: true }) : null;
      if (closing) {
        const cdp = await closing.newBrowserCDPSession();
        await cdp.send('Browser.close');
        if (closing !== owner) await closing.close().catch(() => {});
      }
    } catch { /* Already stopped. */ }
    await owner?.close().catch(() => {});
    await delay(500);
    const cleanup = resolve(folder), temporaryRoot = resolve(tmpdir());
    assert.ok(cleanup.startsWith(temporaryRoot + sep) && cleanup.split(sep).at(-1).startsWith('taobao-service-test-'));
    await rm(cleanup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
