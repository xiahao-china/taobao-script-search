import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { TaobaoError } from './errors.js';

export const projectRoot = process.env.TAOBAO_SEARCH_PROJECT_ROOT || (
  typeof __TAOBAO_PACKAGED__ !== 'undefined' && __TAOBAO_PACKAGED__
    ? dirname(process.argv[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../..')
);

export function runtimePaths(runtimeDir = process.env.TAOBAO_SEARCH_RUNTIME_DIR || join(projectRoot, '.runtime')) {
  const directory = resolve(runtimeDir);
  const key = createHash('sha256').update(`${directory}\0${homedir()}`).digest('hex').slice(0, 16);
  return {
    directory, manifest: join(directory, 'daemon.json'), log: join(directory, 'daemon.log'),
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\taobao-search-${key}` : join(tmpdir(), `taobao-search-${key}.sock`),
  };
}

export function config(options = {}) {
  const merged = {
    timeoutMs: 30000, approvalTimeoutMs: 120000, manualTimeoutMs: 0,
    waitForLogin: true, maxProductTabs: 3, cacheTtlMs: 60000, maxJobs: 200,
    channel: 'chrome', cdpUrl: null, userDataDir: null, runtimeDir: null, portableBrowser: false,
    ...options,
  };
  for (const key of ['timeoutMs', 'approvalTimeoutMs', 'maxProductTabs', 'maxJobs']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw new TaobaoError('INVALID_ARGUMENT', `${key} 必须为正整数。`);
  }
  for (const key of ['manualTimeoutMs', 'cacheTtlMs']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 0) throw new TaobaoError('INVALID_ARGUMENT', `${key} 不能为负数。`);
  }
  return merged;
}
