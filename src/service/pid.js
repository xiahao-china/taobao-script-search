/**
 * PID liveness for the single-instance daemon guard. Windows named pipes
 * allow duplicate same-name listeners, so process-level checks — not just a
 * pipe probe — are what keep two daemons from owning one runtime directory.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
