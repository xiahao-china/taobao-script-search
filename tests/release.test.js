import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, readdir, mkdtemp, readFile, rm, open, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { discoverEndpoint } from '../src/browser/session.js';
import { card, product } from './fixtures.js';
const release = resolve('dist/taobao-search-win11-x64');

test('two-file release runs offline without Node on PATH, portable browser and project dependencies', {
  timeout: 300000, skip: !existsSync(join(release, 'taobao.js')),
}, async () => {
  assert.deepEqual((await readdir(release)).sort(), ['SKILL.md', 'taobao.js']);
  const folder = await mkdtemp(join(tmpdir(), 'taobao-release-test-'));
  const distribution = join(folder, '下载 空格中文'), cache = join(folder, 'cache');
  await cp(release, distribution, { recursive: true });
  const cli = (args, cacheRoot = cache) => new Promise((resolveRun, reject) => {
    const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
    const script = `$p=${psQuote(join(distribution, 'taobao.js'))}; $r=[IO.File]::OpenText($p); try { $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.ReadLine().Substring(3))) } finally { $r.Dispose() }; & ([scriptblock]::Create($s)) $p @(${args.map(psQuote).join(',')}); exit $LASTEXITCODE`;
    const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_PATH: '',
        TAOBAO_SEARCH_CACHE_DIR: cacheRoot, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        TAOBAO_SEARCH_PROJECT: join(folder, 'nonexistent-project') },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolveRun({ code, value: JSON.parse(stdout), stderr }); }
      catch { reject(new Error(`Release CLI failed (${code}): ${stdout} ${stderr}`)); }
    });
  });
  let browserProcess, owner;
  const record = { checkedAt: new Date().toISOString(), noSystemNode: true, independentDirectory: true, disconnectedDependencyDownloads: true };
  try {
    const began = Date.now();
    const cold = await cli(['status']);
    record.coldStartMs = Date.now() - began;
    assert.equal(cold.code, 0, JSON.stringify(cold));
    assert.equal(cold.value.data.running, false);
    const bundles = await readdir(join(cache, 'bundles'));
    const app = join(cache, 'bundles', bundles.find(name => !name.startsWith('.')));
    const manifest = JSON.parse(await readFile(join(app, 'bundle-manifest.json'), 'utf8'));
    assert.equal(manifest.arch, 'x64');
    assert.equal(manifest.nodeVersion, '24.21.0');
    assert.ok(existsSync(join(app, 'node_modules/playwright-core/lib/coreBundle.js')));
    assert.ok(existsSync(join(app, 'licenses/Node-LICENSE.txt')));
    record.embeddedNode = manifest.nodeVersion;
    record.embeddedChromium = manifest.chromium;
    const profile = join(cache, 'browser-profile');
    browserProcess = spawn(join(app, 'browser/chrome-win64/chrome.exe'), ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let endpoint;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { try { endpoint = await discoverEndpoint(profile); break; } catch { await delay(100); } }
    assert.ok(endpoint, 'Embedded Chromium works without an installed browser');
    owner = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = owner.contexts()[0], existingPage = context.pages()[0];
    await existingPage.setContent('<title>Portable browser retained</title>');
    await context.addCookies([{ name: 'test_session', value: 'portable-session', domain: 'example.test', path: '/' }]);
    await context.route('https://s.taobao.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: card() }));
    let navigations = 0;
    await context.route('https://item.taobao.com/**', route => {
      navigations++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: product({ native: true }) });
    });
    const started = await cli(['start', '--portable-browser', '--timeout', '5']);
    assert.equal(started.value.ok, true, JSON.stringify(started) + '\n' + await readFile(join(cache, 'runtime/daemon.log'), 'utf8').catch(() => ''));
    const search = await cli(['search', '中文关键词 "quoted" & $test', '--limit', '1']);
    assert.equal(search.value.ok, true, JSON.stringify(search));
    assert.equal(search.value.data.keyword, '中文关键词 "quoted" & $test');
    const specs = await cli(['specs', '1001']);
    assert.equal(specs.value.ok, true, JSON.stringify(specs));
    const spec = specs.value.data.variants.find(value => value.skuId === '102');
    const detail = await cli(['detail', '1001', '--spec-id', spec.specId]);
    assert.equal(detail.value.ok, true, JSON.stringify(detail));
    assert.equal(detail.value.data.price.amount, '4.08');
    const inputFile = join(folder, '批量 输入.json'), outputFile = join(folder, '批量 输出.json');
    await writeFile(inputFile, JSON.stringify({ products: [{ itemId: '1001', specs: [ { specId: 'sku:101' }, { specId: 'sku:102' } ] }] }));
    const batch = await cli(['batch', '--file', inputFile, '--output', outputFile]);
    assert.equal(batch.value.ok, true, JSON.stringify(batch));
    assert.deepEqual(batch.value.data.results.filter(value => value.operation === 'getDetail').map(value => value.data.price.amount), ['9.00', '4.08']);
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), batch.value);
    const warmBegan = Date.now();
    const warm = await cli(['status']);
    record.warmStartMs = Date.now() - warmBegan;
    assert.equal(warm.value.data.pid, started.value.data.pid);
    assert.equal(warm.value.data.browser.connections, 1);
    assert.equal(warm.value.data.detailNavigations, 1);
    assert.equal(navigations, 1);
    record.browserConnections = 1; record.productNavigations = 1;
    const invalid = await cli(['detail', '1001', '--spec-id', 'missing']);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.value.ok, false);
    assert.equal((await cli(['stop'])).value.ok, true);
    assert.equal(browserProcess.exitCode, null);
    assert.equal(existingPage.isClosed(), false);
    assert.equal((await context.cookies('https://example.test'))[0].value, 'portable-session');
    const corruptFile = await open(join(distribution, 'taobao.js'), 'r+');
    try {
      const header = Buffer.alloc(65536); await corruptFile.read(header, 0, header.length, 0);
      const marker = Buffer.from('__TAOBAO_PAYLOAD_BEGIN__\n');
      const start = header.indexOf(marker); assert.ok(start >= 0);
      const offset = start + marker.length;
      await corruptFile.write(header[offset] === 65 ? 'B' : 'A', offset, 'ascii');
    } finally { await corruptFile.close(); }
    const corrupted = await cli(['status'], join(folder, 'corrupted-cache'));
    assert.equal(corrupted.code, 1);
    assert.equal(corrupted.value.error.code, 'BUNDLE_START_FAILED');
    assert.match(corrupted.value.error.message, /checksum mismatch/);
    record.tamperedPayloadRejected = true;
    record.batchQuotes = ['9.00', '4.08'];
    record.passed = true;
    await mkdir(resolve('artifacts/release'), { recursive: true });
    await writeFile(resolve('artifacts/release/acceptance.json'), JSON.stringify(record, null, 2));
  } finally {
    await cli(['stop']).catch(() => {});
    if (owner?.isConnected()) {
      try { const cdp = await owner.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch { /* Already closed. */ }
      await owner.close().catch(() => {});
    }
    const deadline = Date.now() + 5000;
    while (browserProcess && browserProcess.exitCode === null && Date.now() < deadline) await delay(50);
    if (browserProcess?.exitCode === null) browserProcess.kill();
    const cleanup = resolve(folder);
    assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && cleanup.split(sep).at(-1).startsWith('taobao-release-test-'));
    await rm(cleanup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
