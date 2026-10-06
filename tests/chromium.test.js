import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { browserStatus, resolveBundledChromium, bundleCandidates, installedExecutable, browserNotFoundError, chromiumDownloadUrls, chromiumVersion } from '../src/browser/chromium.js';
import { installChromium } from '../src/browser/install.js';

const exec = promisify(execFile);
const powerShell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const KEYS = ['TAOBAO_SEARCH_CACHE_DIR', 'TAOBAO_SEARCH_BUNDLED_CHROMIUM'];

/** Every case isolates the shared cache root so nothing real is touched. */
async function withSandbox(run) {
  const folder = await mkdtemp(join(tmpdir(), 'taobao-kernel-test-'));
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  process.env.TAOBAO_SEARCH_CACHE_DIR = join(folder, 'cache');
  delete process.env.TAOBAO_SEARCH_BUNDLED_CHROMIUM;
  try { return await run(join(folder, 'cache')); } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function fakeKernel(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'chrome.exe'), 'stub');
  await writeFile(join(directory, 'resources.pak'), 'stub');
}

test('browser status advertises the pinned kernel and its official mirrors', async () => {
  await withSandbox(async cache => {
    const status = browserStatus();
    assert.equal(status.chromiumVersion, chromiumVersion);
    assert.equal(status.cacheRoot, cache);
    assert.equal(status.installed, false);
    assert.equal(status.resolved, null);
    assert.deepEqual(status.downloadUrls, chromiumDownloadUrls);
    assert.ok(status.downloadUrls.every(url => url.startsWith('https://')));
  });
});

test('a kernel installed by hand or extracted by another release is reused', async () => {
  await withSandbox(async cache => {
    await fakeKernel(join(cache, 'bundles', 'a'.repeat(16), 'browser', 'chrome-win64'));
    assert.equal(bundleCandidates().length, 1);
    assert.equal(resolveBundledChromium(), join(cache, 'bundles', 'a'.repeat(16), 'browser', 'chrome-win64', 'chrome.exe'));

    // The packaged variant wins over every shared-cache copy.
    await fakeKernel(join(cache, 'browser', 'chrome-win64'));
    assert.equal(resolveBundledChromium(), installedExecutable());
    const packaged = join(cache, 'packaged', 'chrome.exe');
    await fakeKernel(join(cache, 'packaged'));
    process.env.TAOBAO_SEARCH_BUNDLED_CHROMIUM = packaged;
    assert.equal(resolveBundledChromium(), packaged);
    assert.equal(browserStatus().source, 'packaged');
  });
});

test('a lite build without any kernel reports where to get one', async () => {
  await withSandbox(async () => {
    const error = browserNotFoundError();
    assert.equal(error.code, 'BROWSER_NOT_FOUND');
    assert.equal(error.message.includes('\n'), false, 'the message travels through the JSON envelope');
    assert.match(error.message, /chrome-win64\.zip/);
    assert.match(error.message, /browser install/);
    assert.deepEqual(error.details.downloadUrls, chromiumDownloadUrls);
    assert.match(error.details.installDirectory, /browser[\\/]chrome-win64$/);
  });
});

test('browser install unpacks an official archive into the shared cache', { skip: process.platform !== 'win32' }, async () => {
  await withSandbox(async cache => {
    const staging = join(cache, '..', 'download');
    await fakeKernel(join(staging, 'chrome-win64'));
    const archive = join(cache, '..', 'chrome-win64.zip');
    await mkdir(join(cache, '..'), { recursive: true });
    const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
      + `[IO.Compression.ZipFile]::CreateFromDirectory('${staging.replace(/'/g, "''")}', '${archive.replace(/'/g, "''")}')`;
    await exec(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });

    const status = await installChromium(archive);
    assert.equal(status.installed, true);
    assert.equal(status.resolved, installedExecutable());
    assert.equal(status.source, 'installed');
    assert.ok(existsSync(join(installedExecutable())));
    assert.ok(existsSync(join(status.installDirectory, 'resources.pak')), 'the whole kernel folder travels with chrome.exe');
    // Reinstalling over an existing kernel must not leave the staging folder behind.
    await installChromium(join(cache, '..', 'download'));
    assert.equal(browserStatus().installed, true);
  });
});
