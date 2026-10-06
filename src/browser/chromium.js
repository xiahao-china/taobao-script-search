import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaobaoError } from '../core/errors.js';

/** Portable Chromium recorded in browsers.json for the pinned Playwright build. */
export const chromiumVersion = '153.0.8010.12';

/** Chrome for Testing archives unpack to this exact executable. */
export const chromiumExecutableEntry = 'chrome-win64/chrome.exe';

/**
 * Official Chrome for Testing mirrors, in order. The Google bucket is the
 * source of record; the Playwright CDN serves the same bytes for CI networks.
 */
export const chromiumDownloadUrls = [
  `https://storage.googleapis.com/chrome-for-testing-public/${chromiumVersion}/win64/chrome-win64.zip`,
  `https://cdn.playwright.dev/builds/cft/${chromiumVersion}/win64/chrome-win64.zip`,
];

export function cacheRoot() {
  return process.env.TAOBAO_SEARCH_CACHE_DIR || join(process.env.LOCALAPPDATA || '', 'TaobaoSearch');
}

/** Where `taobao browser install` places a user-supplied kernel archive. */
export function installDirectory() {
  return join(cacheRoot(), 'browser', 'chrome-win64');
}

export function installedExecutable() {
  return join(installDirectory(), 'chrome.exe');
}

export function profileDirectory() {
  return join(cacheRoot(), 'browser-profile');
}

/** Kernels already extracted by any release variant on this machine. */
export function bundleCandidates() {
  const parent = join(cacheRoot(), 'bundles');
  let names;
  try { names = readdirSync(parent); } catch { return []; }
  return names
    .filter(name => !name.startsWith('.'))
    .map(name => join(parent, name, 'browser', 'chrome-win64', 'chrome.exe'))
    .filter(path => existsSync(path));
}

export function systemChromeCandidates() {
  return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map(folder => join(folder, 'Google/Chrome/Application/chrome.exe'));
}

export function systemChromePath() {
  return systemChromeCandidates().find(path => existsSync(path)) || null;
}

/**
 * Resolution order for a portable kernel: the packaged variant's own binary,
 * then a kernel the user installed, then any kernel another release variant
 * already extracted into the shared bundle cache.
 */
export function resolveBundledChromium() {
  const candidates = [
    process.env.TAOBAO_SEARCH_BUNDLED_CHROMIUM,
    installedExecutable(),
    ...bundleCandidates(),
  ];
  return candidates.find(path => path && existsSync(path)) || null;
}

export function browserStatus() {
  const bundles = bundleCandidates();
  const system = systemChromePath();
  const packaged = process.env.TAOBAO_SEARCH_BUNDLED_CHROMIUM || null;
  const installed = installedExecutable();
  const resolved = resolveBundledChromium();
  const source = !resolved ? null
    : resolved === packaged ? 'packaged'
      : resolved === installed ? 'installed'
        : 'bundle-cache';
  return {
    chromiumVersion,
    cacheRoot: cacheRoot(),
    installDirectory: installDirectory(),
    installed: existsSync(installed),
    installedPath: existsSync(installed) ? installed : null,
    packaged: packaged && existsSync(packaged) ? packaged : null,
    bundleCache: bundles,
    systemChrome: system,
    resolved,
    source,
    downloadUrls: chromiumDownloadUrls,
    installCommand: 'taobao browser install <下载的 chrome-win64.zip 绝对路径>',
  };
}

/**
 * Raised when nothing can drive the browser: no daily Chrome and no portable
 * kernel. The message stays on one line because it travels through the local
 * IPC envelope and is rendered as JSON.
 */
export function browserNotFoundError() {
  const status = browserStatus();
  return new TaobaoError(
    'BROWSER_NOT_FOUND',
    `未找到可用浏览器：未检测到本机 Chrome，也没有便携内核。`
    + `下载 ${chromiumDownloadUrls[0]} 后执行 `
    + `taobao browser install <zip路径>，或安装 Google Chrome，或改用完整版发布包。`,
    {
      downloadUrls: chromiumDownloadUrls,
      installCommand: status.installCommand,
      installDirectory: status.installDirectory,
      systemChromeSearched: systemChromeCandidates(),
    },
  );
}

/** Raised when a packaged-only option is used without any resolved kernel. */
export function portableBrowserUnavailableError() {
  return new TaobaoError(
    'BROWSER_NOT_FOUND',
    '--portable-browser 需要便携内核：请用完整版发布包，或执行 '
    + `taobao browser install <下载的 chrome-win64.zip 路径> 后重试。`,
    { downloadUrls: chromiumDownloadUrls, installCommand: browserStatus().installCommand },
  );
}
