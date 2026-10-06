import { readdir, mkdir, rename, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaobaoError } from '../core/errors.js';
import { cacheRoot, installDirectory, installedExecutable, browserStatus } from './chromium.js';

const exec = promisify(execFile);
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";

/** Locate chrome.exe inside an unpacked archive, tolerating wrapper folders. */
async function findChromeExecutable(root, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'chrome.exe') return join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findChromeExecutable(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * PowerShell expands the archive without propagating the Mark-of-the-Web zone
 * identifier, so the unpacked kernel starts without a SmartScreen prompt.
 */
async function expandArchive(zipPath, destination) {
  const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
    + `[IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zipPath)}, ${psQuote(destination)})`;
  try {
    await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new TaobaoError('BROWSER_INSTALL_FAILED', '未找到 PowerShell，无法解压内核。请手动解压后改用 browser install <目录>。');
    throw new TaobaoError('BROWSER_INSTALL_FAILED', `解压内核失败：${String(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}

/**
 * Install a user-supplied portable Chromium into the shared cache so that every
 * release variant on this machine reuses it without downloading anything.
 * Accepts either the official chrome-win64.zip or an already unpacked folder.
 */
export async function installChromium(source) {
  if (process.platform !== 'win32') throw new TaobaoError('INVALID_ARGUMENT', '便携内核安装仅支持 Windows。');
  const input = resolve(source);
  const stats = await stat(input).catch(() => null);
  if (!stats) throw new TaobaoError('INVALID_ARGUMENT', `路径不存在：${input}`);

  const stage = join(cacheRoot(), 'browser', `.install-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    let unpacked = input;
    if (!stats.isDirectory()) {
      const archive = join(stage, 'kernel.zip');
      await cp(input, archive);
      unpacked = join(stage, 'unpacked');
      await expandArchive(archive, unpacked);
    }
    const executable = await findChromeExecutable(unpacked);
    if (!executable) throw new TaobaoError('BROWSER_INSTALL_FAILED', '归档中没有 chrome.exe。请下载 Chrome for Testing 的 win64/chrome-win64.zip。');

    // The whole kernel folder moves together so DLLs, pak and locales travel
    // with chrome.exe. Staging plus rename keeps a failed install from
    // destroying a working one.
    const destination = installDirectory(), partial = `${destination}.partial`;
    await rm(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(executable, '..'), partial, { recursive: true });
    if (!existsSync(join(partial, 'chrome.exe'))) throw new TaobaoError('BROWSER_INSTALL_FAILED', '复制内核后未找到 chrome.exe。');
    await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    await rename(partial, destination);
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }

  if (!existsSync(installedExecutable())) throw new TaobaoError('BROWSER_INSTALL_FAILED', `安装后未找到 ${installedExecutable()}。`);
  return browserStatus();
}
