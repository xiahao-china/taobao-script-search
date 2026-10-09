/**
 * PID liveness for the single-instance daemon guard. Windows named pipes
 * allow duplicate same-name listeners, so process-level checks — not just a
 * pipe probe — are what keep two daemons from owning one runtime directory.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'EPERM'; }
  if (process.platform !== 'win32') return true;
  // Windows quirk: OpenProcess succeeds for a terminated process while any
  // handle lingers, so signal-0 alone can report a sandbox-killed daemon as
  // alive and wedge both the start guard and stop cleanup on a ghost pid.
  // Confirm against the process table; if the table itself cannot be queried
  // (spawn blocked, timeout), keep the signal-0 verdict instead of guessing.
  try {
    execFileSync(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command',
        `exit [int](-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue))`],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    );
    return true;
  } catch (error) {
    return typeof error?.status === 'number' ? error.status === 0 : true;
  }
}
