/**
 * Fixtures here are synthetic and deliberately shaped like secrets so that the
 * publication audit can be proven to catch them. Every value is fake; do not
 * replace them with real data. The audit exempts this file from content scans
 * for that reason.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { scanFile, CONTENT_RULES, FORBIDDEN_PATHS } from '../scripts/audit-publish.js';

const KIND = Object.fromEntries([
  ...CONTENT_RULES.map(rule => [rule.label, rule.label]),
  ...FORBIDDEN_PATHS.map(rule => [`path:${rule.label}`, `forbidden path: ${rule.label}`]),
]);

function kinds(findings) {
  return findings.map(item => item.kind).sort();
}

test('content rules cover the documented rule set', () => {
  assert.ok(CONTENT_RULES.length >= 6);
  assert.ok(FORBIDDEN_PATHS.length >= 8);
});

test('detects a Taobao session cookie value', () => {
  const text = 'headers.Cookie = "_m_h5_tk=0000fake0000fake0000fake0000fake_1759700000000";';
  assert.deepEqual(kinds(scanFile('src/demo.js', text)), [KIND['Taobao session cookie value']]);
});

test('detects a platform access token', () => {
  const text = `const token = "ghp_${'a'.repeat(36)}";`;
  assert.deepEqual(kinds(scanFile('src/demo.js', text)), [KIND['platform access token']]);
});

test('detects a private key block', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIfakefakefake\n-----END RSA PRIVATE KEY-----';
  assert.deepEqual(kinds(scanFile('src/demo.js', text)), [KIND['private key block']]);
});

test('detects a hardcoded password but allows placeholders and fixtures', () => {
  const planted = 'const config = { password: "synthetic-value-1234" };';
  assert.deepEqual(kinds(scanFile('src/demo.js', planted)), [KIND['password or secret literal']]);

  const benign = [
    'const password = "placeholder-value";',
    'value: "test_session",  // fixture cookie',
    'name: "portable-session",',
  ];
  for (const line of benign) assert.deepEqual(scanFile('src/demo.js', line), [], line);
});

test('detects personal data', () => {
  assert.deepEqual(
    kinds(scanFile('docs/note.md', '联系人手机 13800138000 待确认')),
    [KIND['Chinese mobile number']],
  );
  assert.deepEqual(
    kinds(scanFile('docs/note.md', '证件号 11010119900307721X 已脱敏')),
    [KIND['resident identity number']],
  );
});

test('detects a maintainer machine path', () => {
  const windows = 'root: C:\\Users\\Example\\repo';
  assert.deepEqual(kinds(scanFile('docs/note.md', windows)), [KIND['maintainer machine path']]);
  const posix = 'cd /c/Users/Example/repo';
  assert.deepEqual(kinds(scanFile('docs/note.md', posix)), [KIND['maintainer machine path']]);
});

test('detects forbidden paths even in exempt files', () => {
  const findings = scanFile('node_modules/playwright/index.js', 'module.exports = 1;');
  assert.deepEqual(kinds(findings), [KIND['path:installed dependencies']]);

  const runtime = scanFile('.runtime/daemon.json', '{"token":"x"}');
  assert.deepEqual(kinds(runtime), [KIND['path:runtime state']]);
});

test('leaves ordinary source and documentation untouched', () => {
  const samples = [
    ['package.json', '{ "name": "taobao-script-search", "version": "0.2.0" }'],
    ['src/service/daemon.js', "const token = randomBytes(32).toString('hex');"],
    ['docs/architecture.md', 'Cookie 不导出、不写入项目，也不由 skill 传入。'],
    ['docs/research/direct-api.md', "cookies.get('_m_h5_tk')?.split('_')[0] ?? ''"],
    ['README.md', 'node bin/taobao.js detail 805012477549 --spec-id "sku:123"'],
  ];
  for (const [path, text] of samples) assert.deepEqual(scanFile(path, text), [], path);
});

test('skips binary blobs instead of decoding them', () => {
  assert.deepEqual(scanFile('docs/logo.png', '\0\0binary'), []);
});
