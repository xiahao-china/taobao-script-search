/**
 * Regression tests for the three defects behind "the browser kept jumping between
 * two URLs" (2026-10-08):
 *
 *  1. A packaged (lite) CLI looked for the daemon at `src/service/daemon.js`,
 *     which does not exist inside a bundle, so every command failed with
 *     SERVICE_START_FAILED and restarted the browser.
 *  2. A batch could carry an unbounded list of keywords, each one navigating the
 *     shared search tab — the visible page jumping, followed by a rate-limit wall.
 *  3. The PowerShell launcher wrote ProcessStartInfo.EnvironmentVariables before
 *     touching it, which Windows PowerShell 5.1 rejects with "Cannot index into a
 *     null array" — the bootstrap died before Node ever started.
 *
 * These tests are host-only: no browser, no daemon, no network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expandBatch, MAX_BATCH_SEARCHES } from '../src/core/engine.js';
import { pickDaemonEntry } from '../src/service/client.js';

/** Build an `onDisk` predicate from a set of paths that "exist". */
function present(...paths) {
  const set = new Set(paths);
  return candidate => set.has(candidate);
}

test('packaged CLI resolves the bundled daemon.cjs, not the source path', () => {
  const root = 'C:\\bundle';
  const entry = pickDaemonEntry({
    root,
    packaged: true,
    onDisk: present('C:\\bundle\\daemon.cjs'),
  });
  assert.equal(entry, 'C:\\bundle\\daemon.cjs');
});

test('packaged CLI still finds the source path when no bundled daemon exists', () => {
  const root = 'C:\\somewhere';
  const entry = pickDaemonEntry({
    root,
    packaged: true,
    onDisk: present('C:\\somewhere\\src\\service\\daemon.js'),
  });
  assert.equal(entry, 'C:\\somewhere\\src\\service\\daemon.js');
});

test('development runs prefer the source daemon even if a bundle file lurks', () => {
  const root = 'C:\\repo';
  const entry = pickDaemonEntry({
    root,
    packaged: false,
    onDisk: present('C:\\repo\\src\\service\\daemon.js', 'C:\\repo\\daemon.cjs'),
  });
  assert.equal(entry, 'C:\\repo\\src\\service\\daemon.js');
});

test('a packaged bundle never resolves the missing source path', () => {
  const root = 'C:\\bundle';
  // Only the bundle layout exists; the source path must not be selected.
  const entry = pickDaemonEntry({
    root,
    packaged: true,
    onDisk: present('C:\\bundle\\daemon.cjs', 'C:\\bundle\\cli.cjs'),
  });
  assert.ok(!entry.endsWith('src\\service\\daemon.js'), `unexpected source path: ${entry}`);
  assert.equal(entry, 'C:\\bundle\\daemon.cjs');
});

test(`a batch carries at most ${MAX_BATCH_SEARCHES} keywords`, () => {
  const allowed = Array.from({ length: MAX_BATCH_SEARCHES }, (_, index) => ({ keyword: `关键词${index}` }));
  const tasks = expandBatch({ searches: allowed });
  assert.equal(tasks.length, MAX_BATCH_SEARCHES);
  assert.deepEqual(tasks.map(task => task.operation), Array(MAX_BATCH_SEARCHES).fill('search'));

  const overflow = Array.from({ length: MAX_BATCH_SEARCHES + 1 }, (_, index) => ({ keyword: `关键词${index}` }));
  assert.throws(() => expandBatch({ searches: overflow }), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    // The message has to teach the caller what to do instead.
    assert.match(error.message, /关键词/);
    assert.match(error.message, /25/);
    return true;
  });
});

test('the keyword ceiling leaves product spec batches alone', () => {
  const tasks = expandBatch({
    products: [{ itemId: '805012477549', specs: [{ labels: ['M3*10(200个)'] }, { labels: ['M3*6(500个)'] }] }],
  });
  // One getSpecs plus one getDetail per spec, independent of the search ceiling.
  assert.deepEqual(tasks.map(task => task.operation), ['getSpecs', 'getDetail', 'getDetail']);
});

test('explicit tasks keep their own 200-item ceiling', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => ({ operation: 'search', params: { keyword: `k${index}` } }));
  assert.equal(expandBatch({ tasks }).length, 200);
  assert.throws(() => expandBatch({ tasks: [...tasks, { operation: 'search', params: { keyword: 'overflow' } }] }), { code: 'INVALID_ARGUMENT' });
});

test('the PowerShell launcher passes settings through the process environment', () => {
  const launcher = readFileSync(resolve('packaging/bootstrap.ps1'), 'utf8');
  // Windows PowerShell 5.1 exposes ProcessStartInfo.Environment[Variables] as
  // $null. Indexing it throws NullArray; leaving it empty spawns node.exe with a
  // gutted environment that aborts in CSPRNG. Publish the settings on the parent
  // environment, which an untouched ProcessStartInfo inherits intact.
  assert.match(launcher, /\[Environment\]::SetEnvironmentVariable\(\$key, \[string\]\$settings\[\$key\], 'Process'\)/,
    'launcher must publish each setting on the process environment');
  assert.match(launcher, /\[Environment\]::SetEnvironmentVariable\(\$key, \$previous\[\$key\], 'Process'\)/,
    'launcher must restore the previous value after spawning');

  // Writing straight through the ProcessStartInfo dictionary is the exact shape
  // that crashes (or silently empties the child environment) on 5.1.
  assert.doesNotMatch(launcher, /\$info\.EnvironmentVariables\s*\[/, 'must not index $info.EnvironmentVariables');
  assert.doesNotMatch(launcher, /\$info\.Environment\s*\[/, 'must not index $info.Environment');
});
