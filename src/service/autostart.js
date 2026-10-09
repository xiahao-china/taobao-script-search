import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, runtimePaths } from '../core/config.js';
import { resolveDaemonEntry } from './client.js';
import { TaobaoError } from '../core/errors.js';

/**
 * Login autostart for the resident daemon.
 *
 * A daemon spawned inside a managed tool session dies with that session's
 * process tree, which is why a consent click can land on an already-dead
 * client. A daemon launched by Windows itself (Startup folder, hidden window)
 * lives outside every session, so the skill reuses one long-lived connection:
 * one consent click per Chrome run, nothing else. The runtime directory is
 * baked into the daemon config so the login-time daemon serves the exact pipe
 * every CLI call looks for.
 */

export function autostartPaths(override) {
  const directory = override || join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return { directory, script: join(directory, 'TaobaoSearchDaemon.vbs') };
}

export function autostartScript({ exe, entry, runtimeDir }) {
  const encoded = `--config=${Buffer.from(JSON.stringify({ runtimeDir })).toString('base64')}`;
  const line = `"${exe}" "${entry}" ${encoded}`;
  return `CreateObject("WScript.Shell").Run "${line.replace(/"/g, '""')}", 0, False`;
}

export async function installAutostart(input = {}) {
  if (process.platform !== 'win32') throw new TaobaoError('INVALID_ARGUMENT', 'autostart 仅支持 Windows。');
  const options = config(input), paths = runtimePaths(options.runtimeDir || undefined);
  const { directory, script } = autostartPaths(process.env.TAOBAO_SEARCH_AUTOSTART_DIR);
  await mkdir(directory, { recursive: true });
  const exe = process.execPath, entry = resolveDaemonEntry();
  await writeFile(script, autostartScript({ exe, entry, runtimeDir: paths.directory }), 'utf8');
  return { script, exe, entry, runtimeDir: paths.directory };
}

export async function removeAutostart() {
  if (process.platform !== 'win32') throw new TaobaoError('INVALID_ARGUMENT', 'autostart 仅支持 Windows。');
  const { script } = autostartPaths(process.env.TAOBAO_SEARCH_AUTOSTART_DIR);
  try { await unlink(script); return { removed: true, script }; }
  catch (error) { if (error.code === 'ENOENT') return { removed: false, script }; throw error; }
}
