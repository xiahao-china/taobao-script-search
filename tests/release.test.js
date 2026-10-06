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
import { card, product, firstContextPage } from './fixtures.js';
const fullRelease = resolve('dist/taobao-search-win11-x64');
const liteRelease = resolve('dist/taobao-search-win11-x64-lite');
const powerShell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";

/**
 * Drives the shipped launcher exactly as a user would: read the first comment
 * line, decode the PowerShell entry, and run it with the bundle path. The
 * child gets no Node on PATH and no working proxy on purpose.
 */
function makeCli(folder, distribution, cacheRoot, extraEnv = {}) {
  return (args, cacheOverride = cacheRoot, envOverride = {}) => new Promise((resolveRun, reject) => {
    const script = `$p=${psQuote(join(distribution, 'taobao.js'))}; $r=[IO.File]::OpenText($p); try { $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($r.ReadLine().Substring(3))) } finally { $r.Dispose() }; & ([scriptblock]::Create($s)) $p @(${args.map(psQuote).join(',')}); exit $LASTEXITCODE`;
    const child = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_PATH: '',
        TAOBAO_SEARCH_CACHE_DIR: cacheOverride, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        TAOBAO_SEARCH_PROJECT: join(folder, 'nonexistent-project'), ...extraEnv, ...envOverride },
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
}

/** Locate the extracted bundle inside the isolated cache. */
async function extractedApp(cache) {
  const bundles = await readdir(join(cache, 'bundles'));
  return join(cache, 'bundles', bundles.find(name => !name.startsWith('.')));
}

async function makeTestFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'taobao-release-test-'));
  return { folder, cache: join(folder, 'cache') };
}

async function cleanupFolder(folder) {
  const cleanup = resolve(folder);
  assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && cleanup.split(sep).at(-1).startsWith('taobao-release-test-'));
  await rm(cleanup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('two-file full release runs offline without Node on PATH, portable browser and project dependencies', {
  timeout: 300000, skip: !existsSync(join(fullRelease, 'taobao.js')),
}, async () => {
  assert.deepEqual((await readdir(fullRelease)).sort(), ['SKILL.md', 'taobao.js']);
  const { folder, cache } = await makeTestFolder();
  const distribution = join(folder, '下载 空格中文');
  await cp(fullRelease, distribution, { recursive: true });
  const cli = makeCli(folder, distribution, cache);
  let browserProcess, owner, endpoint;
  const record = { variant: 'full', checkedAt: new Date().toISOString(), noSystemNode: true, independentDirectory: true, disconnectedDependencyDownloads: true };
  try {
    const began = Date.now();
    const cold = await cli(['status']);
    record.coldStartMs = Date.now() - began;
    assert.equal(cold.code, 0, JSON.stringify(cold));
    assert.equal(cold.value.data.running, false);
    const app = await extractedApp(cache);
    const manifest = JSON.parse(await readFile(join(app, 'bundle-manifest.json'), 'utf8'));
    assert.equal(manifest.arch, 'x64');
    assert.equal(manifest.nodeVersion, '24.21.0');
    assert.equal(manifest.variant, 'full');
    assert.equal(manifest.bundledChromium, true);
    assert.ok(existsSync(join(app, 'node_modules/playwright-core/lib/coreBundle.js')));
    assert.ok(existsSync(join(app, 'licenses/Node-LICENSE.txt')));
    assert.ok(existsSync(join(app, 'browser/chrome-win64/chrome.exe')));
    record.embeddedNode = manifest.nodeVersion;
    record.embeddedChromium = manifest.chromium;
    const profile = join(cache, 'browser-profile');
    browserProcess = spawn(join(app, 'browser/chrome-win64/chrome.exe'), ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = () => Number(new URL(endpoint).port);
    const endpointAlive = async () => {
      try { return (await fetch(`http://127.0.0.1:${port()}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
    };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { try { endpoint = await discoverEndpoint(profile); break; } catch { await delay(100); } }
    assert.ok(endpoint, 'Embedded Chromium works without an installed browser');
    owner = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = owner.contexts()[0], existingPage = await firstContextPage(context);
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
    // chrome.exe hands the browser off to its own browser process and exits 0
    // straight away, so the spawn handle is not a liveness signal. Assert the
    // guarantee itself: stop disconnects the service without closing the
    // browser, the caller's pre-existing page, or its cookies.
    assert.equal(await endpointAlive(), true, 'the browser still serves CDP after stop');
    record.browserSurvivedStop = true;
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
    try {
      const closing = owner?.isConnected() ? owner : endpoint ? await chromium.connectOverCDP(endpoint, { noDefaults: true }) : null;
      if (closing) {
        const cdp = await closing.newBrowserCDPSession();
        await cdp.send('Browser.close');
        if (closing !== owner) await closing.close().catch(() => {});
      }
    } catch { /* Already closed. */ }
    await owner?.close().catch(() => {});
    const deadline = Date.now() + 5000;
    while (browserProcess && browserProcess.exitCode === null && Date.now() < deadline) await delay(50);
    if (browserProcess?.exitCode === null) browserProcess.kill();
    await cleanupFolder(folder);
  }
});

test('lite release embeds no kernel and tells the user how to supply one', {
  timeout: 180000, skip: !existsSync(join(liteRelease, 'taobao.js')),
}, async () => {
  assert.deepEqual((await readdir(liteRelease)).sort(), ['SKILL.md', 'taobao.js']);
  assert.ok((await readFile(join(liteRelease, 'taobao.js'))).length < 100 * 1024 * 1024, 'the lite build stays under 100 MiB');
  const { folder, cache } = await makeTestFolder();
  const distribution = join(folder, '精简 空格');
  await cp(liteRelease, distribution, { recursive: true });
  // Hide every system Chrome location so the missing-kernel path is reachable
  // even on a machine that does have Chrome installed.
  const hideChrome = { PROGRAMFILES: 'C:\\nonexistent-program-files', 'PROGRAMFILES(X86)': 'C:\\nonexistent-program-files' };
  const cli = makeCli(folder, distribution, cache, hideChrome);
  const record = { variant: 'lite', checkedAt: new Date().toISOString(), noSystemNode: true, noEmbeddedKernel: true };
  try {
    const cold = await cli(['status']);
    assert.equal(cold.code, 0, JSON.stringify(cold));
    const app = await extractedApp(cache);
    const manifest = JSON.parse(await readFile(join(app, 'bundle-manifest.json'), 'utf8'));
    assert.equal(manifest.variant, 'lite');
    assert.equal(manifest.bundledChromium, false);
    assert.equal(manifest.nodeVersion, '24.21.0');
    assert.ok(!existsSync(join(app, 'browser')), 'no browser directory is shipped');
    assert.ok(existsSync(join(app, 'node_modules/playwright-core/lib/coreBundle.js')));

    const info = await cli(['browser', 'info']);
    assert.equal(info.value.ok, true, JSON.stringify(info));
    assert.equal(info.value.data.resolved, null);
    assert.equal(info.value.data.installed, false);
    assert.deepEqual(info.value.data.bundleCache, []);
    assert.match(info.value.data.downloadUrls[0], /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//);

    // A query cannot silently "succeed" without a browser to drive.
    const search = await cli(['search', 'M3盘头螺丝', '--limit', '1']);
    assert.equal(search.code, 1);
    assert.equal(search.value.error.code, 'BROWSER_NOT_FOUND');
    assert.match(search.value.error.message, /chrome-win64\.zip/);
    assert.match(search.value.error.message, /browser install/);
    assert.equal(search.value.error.message.includes('\n'), false);
    record.missingKernelReported = search.value.error.code;

    // --portable-browser is a daemon-start option, so it is the first browser
    // access that resolves the kernel and reports it as unavailable.
    await cli(['stop']).catch(() => {});
    const portable = await cli(['search', 'M3盘头螺丝', '--limit', '1', '--portable-browser']);
    assert.equal(portable.code, 1);
    assert.equal(portable.value.error.code, 'BROWSER_NOT_FOUND');
    assert.match(portable.value.error.message, /--portable-browser/);
    record.portableBrowserWithoutKernel = portable.value.error.code;
    await cli(['stop']).catch(() => {});

    // The documented manual path: install a kernel archive, then it is reused.
    const staging = join(folder, 'kernel/chrome-win64');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'chrome.exe'), 'stub');
    await writeFile(join(staging, 'resources.pak'), 'stub');
    const archive = join(folder, 'chrome-win64.zip');
    const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
      + `[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(join(folder, 'kernel'))}, ${psQuote(archive)})`;
    await new Promise((resolveCreate, reject) => {
      const child = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
      child.on('error', reject); child.on('close', code => code === 0 ? resolveCreate() : reject(new Error(`zip failed: ${code}`)));
    });
    const installed = await cli(['browser', 'install', archive]);
    assert.equal(installed.value.ok, true, JSON.stringify(installed));
    assert.equal(installed.value.data.installed, true);
    assert.equal(installed.value.data.source, 'installed');
    record.kernelInstalledFromArchive = true;
    record.passed = true;
    await mkdir(resolve('artifacts/release'), { recursive: true });
    await writeFile(resolve('artifacts/release/acceptance-lite.json'), JSON.stringify(record, null, 2));
  } finally {
    await cli(['stop']).catch(() => {});
    await cleanupFolder(folder);
  }
});
