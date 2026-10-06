/**
 * Publication audit for the staged Git snapshot.
 *
 * Stage the files you intend to publish, then run `npm run audit:publish`.
 * The script reads the staged blobs (not the working tree) so that exactly what
 * would be committed is checked. Pass `--ref <rev>` to audit a committed tree
 * instead, which is what CI does. It is dependency-free and read-only.
 *
 * It fails on: credentials and session material, personal data, absolute paths
 * from the maintainer's machine, and generated or private directories that are
 * supposed to stay out of Git.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SELF = 'scripts/audit-publish.js';

/** Directories and file shapes that must never reach the public snapshot. */
export const FORBIDDEN_PATHS = [
  { label: 'installed dependencies', re: /^node_modules\// },
  { label: 'generated output', re: /^(?:dist|artifacts|coverage)\// },
  { label: 'runtime state', re: /^\.runtime\// },
  { label: 'vendored caches', re: /^(?:\.cache|\.venv)\// },
  { label: 'local prototypes and records', re: /^legacy\// },
  { label: 'environment file', re: /(?:^|\/)\.env(?:\.|$)/ },
  { label: 'key material', re: /\.(?:pem|key|p12|pfx|jks|keystore)$/ },
  { label: 'browser session data', re: /(?:^|\/)(?:Cookies|Login Data|Local State|DevToolsActivePort)$/ },
  { label: 'captured session archive', re: /(?:storage-?state|storageState|cookies).*\.json$/i },
  { label: 'network capture', re: /\.har$/ },
];

/**
 * Content patterns that indicate real secrets or personal data.
 * `allow` lists benign substrings that make a match a false positive
 * (documentation, fixtures, values generated at runtime).
 */
export const CONTENT_RULES = [
  {
    label: 'private key block',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    label: 'Taobao session cookie value',
    re: /(?:^|[^A-Za-z0-9_])(?:_m_h5_tk|_tb_token|cookie2|sgcookie|lgc|tracknick)=[A-Za-z0-9%_.-]{6,}/,
  },
  {
    label: 'platform access token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    label: 'password or secret literal',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/i,
    allow: ['test_session', 'portable-session', 'existing-session', 'placeholder', 'example', 'redacted', 'your-', '<', 'xxx'],
  },
  {
    label: 'Chinese mobile number',
    re: /(?<![0-9A-Za-z])1[3-9][0-9]{9}(?![0-9A-Za-z])/,
  },
  {
    label: 'resident identity number',
    re: /(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/,
  },
  {
    label: 'maintainer machine path',
    re: /(?:[A-Za-z]:\\+Users\\+|\/c\/Users\/)/,
  },
];

/** Files whose purpose is to document these patterns, plus synthetic fixtures. */
const SCAN_EXEMPT = new Set([
  SELF,
  'SECURITY.md',
  'CONTRIBUTING.md',
  'tests/audit.test.js',
]);

/** Scan one staged file: first the path shape, then its text content. */
export function scanFile(path, text) {
  const findings = [];
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.re.test(path)) findings.push({ path, line: 0, kind: `forbidden path: ${rule.label}` });
  }
  if (SCAN_EXEMPT.has(path) || text.includes('\0')) return findings;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of CONTENT_RULES) {
      if (!rule.re.test(line)) continue;
      if (rule.allow?.some(token => line.includes(token))) continue;
      findings.push({ path, line: index + 1, kind: rule.label, excerpt: line.trim().slice(0, 120) });
    }
  }
  return findings;
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EBUSY') {
      console.error(`Could not run git (${error.code}). Run this from a normal shell inside the repository.`);
      process.exit(2);
    }
    throw error;
  }
}

/**
 * Which snapshot to audit. `--ref <rev>` audits a committed tree (used by CI);
 * without arguments the staged index is audited, which is what a contributor
 * checks before committing.
 */
function selectSnapshot(argv) {
  const flag = argv.findIndex(value => value === '--ref' || value.startsWith('--ref='));
  if (flag === -1) {
    return {
      label: 'staged index',
      list: () => git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
      read: path => git(['show', `:${path}`]),
    };
  }
  const argument = argv[flag];
  const rev = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[flag + 1];
  if (!rev) {
    console.error('--ref needs a revision, for example --ref HEAD.');
    process.exit(2);
  }
  const resolved = git(['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  return {
    label: `${rev} (${resolved.slice(0, 12)})`,
    list: () => git(['ls-tree', '-r', '--name-only', '-z', resolved]),
    read: path => git(['show', `${resolved}:${path}`]),
  };
}

function main() {
  const snapshot = selectSnapshot(process.argv.slice(2));
  const files = snapshot.list()
    .split('\0')
    .filter(Boolean)
    .map(value => value.replace(/\\/g, '/'));

  if (files.length === 0) {
    console.error(`Nothing to audit in the ${snapshot.label}. Stage the intended files first, or pass --ref <rev>.`);
    process.exit(1);
  }

  const findings = [];
  for (const path of files) {
    findings.push(...scanFile(path, snapshot.read(path)));
  }

  if (findings.length > 0) {
    console.error(`Publication audit failed: ${findings.length} finding(s) in the ${snapshot.label}.\n`);
    for (const item of findings) {
      const where = item.line > 0 ? `${item.path}:${item.line}` : item.path;
      console.error(`  ${where}  [${item.kind}]`);
      if (item.excerpt) console.error(`      ${item.excerpt}`);
    }
    console.error('\nRemove the material from the snapshot, or narrow the ignore rules deliberately.');
    process.exit(1);
  }

  console.log(`Publication audit passed: ${files.length} file(s) clear in the ${snapshot.label}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
