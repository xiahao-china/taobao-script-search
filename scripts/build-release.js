import webpack from 'webpack';
import webpackConfig from '../packaging/webpack.config.js';
import { readFile, writeFile, mkdir, cp, rm, readdir, stat, open, copyFile } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve('.');
const buildRoot = join(root, '.cache/release-build');
const bundleOutput = join(buildRoot, 'bundle');
const playwrightVersion = JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8')).version;
// Keyed by version so a Playwright bump stages a fresh tree instead of mixing
// files, which means the build never has to delete a populated directory.
const runtimeCache = join(buildRoot, 'runtime', playwrightVersion);
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const runPS = script => exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { maxBuffer: 1024 * 1024, windowsHide: true });

/**
 * Two release flavours share one build. `full` embeds the portable Chromium
 * kernel so a machine without Chrome still works offline; `lite` drops the
 * kernel and reuses an installed Chrome or a kernel the user installs with
 * `taobao browser install`, which is roughly six times smaller.
 */
const VARIANTS = {
  full: {
    directory: 'taobao-search-win11-x64',
    bundledChromium: true,
    firstRunNote: 'First run: extracting embedded Node, Playwright and Chromium. No download or installation.',
    variantNote: 'Runtime components, the portable Chromium kernel and licenses are embedded below; no user-side download.',
    chromiumEntry: "TAOBAO_SEARCH_BUNDLED_CHROMIUM = (Join-Path $destination 'browser/chrome-win64/chrome.exe')",
  },
  lite: {
    directory: 'taobao-search-win11-x64-lite',
    bundledChromium: false,
    firstRunNote: 'First run: extracting embedded Node and Playwright. This lite build ships no browser kernel; it reuses the installed Chrome, an already extracted kernel, or one installed with "taobao browser install".',
    variantNote: 'Runtime components and licenses are embedded below. This lite build ships no browser kernel: it reuses the installed Chrome or a kernel installed with "taobao browser install".',
    chromiumEntry: '# Lite build: no portable kernel. An installed Chrome, an extracted bundle kernel or "browser install" provides one.',
  },
};

/** A long step logs elapsed time every 30s so a stall is visible immediately. */
let heartbeat = null;
function track(label) {
  const began = Date.now();
  heartbeat = setInterval(() => console.log(`  ... ${label} (${((Date.now() - began) / 1000).toFixed(0)}s elapsed)`), 30000);
}
function untrack() { if (heartbeat) clearInterval(heartbeat); heartbeat = null; }

function parseVariants(argv) {
  const index = argv.findIndex(value => value === '--variant' || value.startsWith('--variant='));
  if (index === -1) return ['full', 'lite'];
  const argument = argv[index];
  const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[index + 1];
  if (!value || value === 'all') return ['full', 'lite'];
  if (!Object.hasOwn(VARIANTS, value)) throw new Error(`Unknown --variant ${value}; use full, lite or all`);
  return [value];
}

/**
 * Copy a build input only when the staged copy is absent. Overwriting is what
 * the environment's bulk-delete guard forbids (fs.cp removes the old file
 * first), and every input here is content-stable: Node, Playwright and
 * Chromium are pinned, and the staging root is keyed by their versions.
 */
async function ensureCopy(source, destination) {
  if (await stat(destination).catch(() => null)) return;
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

/**
 * The staging trees are variant- and version-scoped and repopulated in place.
 * Nothing here deletes a populated directory: a lite build can never inherit
 * a kernel from an earlier full build because the two never share a path.
 */
async function filesAt(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), key = prefix ? prefix + '/' + name : name;
    if ((await stat(path)).isDirectory()) files.push(...await filesAt(path, key));
    else files.push({ path: key, sha256: digest(await readFile(path)) });
  }
  return files;
}
async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download ${response.status}: ${url}`);
  const file = await open(target + '.partial', 'w');
  try { for await (const chunk of response.body) await file.write(chunk); } finally { await file.close(); }
  await cp(target + '.partial', target); await rm(target + '.partial');
}

/** Fixed build-time inputs shared by every variant: Node, Playwright, launcher. */
async function prepareRuntime() {
  const nodeVersion = '24.21.0';
  const archiveName = `node-v${nodeVersion}-win-x64.zip`;
  const archiveHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
  const nodeZip = join(root, '.cache', archiveName);
  await mkdir(runtimeCache, { recursive: true });
  if (!await stat(join(runtimeCache, 'node.exe')).catch(() => null)) {
    try { await stat(nodeZip); } catch { console.log('Downloading build-time portable Node runtime...'); await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, nodeZip); }
    if (digest(await readFile(nodeZip)) !== archiveHash) throw new Error('Official Node archive SHA-256 mismatch');
    const nodeDirectory = join(buildRoot, `node-v${nodeVersion}-win-x64`);
    try { await stat(join(nodeDirectory, 'node.exe')); } catch {
      await runPS(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(nodeZip)}, ${psQuote(buildRoot)})`);
    }
    await cp(join(nodeDirectory, 'node.exe'), join(runtimeCache, 'node.exe'));
    await mkdir(join(runtimeCache, 'licenses'), { recursive: true });
    await cp(join(nodeDirectory, 'LICENSE'), join(runtimeCache, 'licenses/Node-LICENSE.txt'));
  }
  for (const name of ['playwright', 'playwright-core']) {
    await ensureCopy(join(root, 'node_modules', name), join(runtimeCache, 'node_modules', name));
  }
  await copyFile(join(root, 'packaging/detach-daemon.ps1'), join(runtimeCache, 'detach-daemon.ps1'));
  return nodeVersion;
}

/**
 * The kernel is downloaded once and cached under .cache/release-browser, so
 * repeated full builds stay offline.
 */
async function prepareBrowser() {
  const browsers = JSON.parse(await readFile(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const chromium = browsers.browsers.find(value => value.name === 'chromium');
  const browserCache = join(root, '.cache/release-browser');
  const browser = join(browserCache, `chromium-${chromium.revision}`, 'chrome-win64');
  try { await stat(join(browser, 'chrome.exe')); } catch {
    console.log('Downloading build-time portable Chromium...');
    track('Chromium download');
    try {
      const result = await exec(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium', '--no-shell'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache }, maxBuffer: 1024 * 1024, windowsHide: true });
      console.log(result.stdout);
    } finally { untrack(); }
  }
  return { chromium, browser };
}

async function assemble(variant, nodeVersion) {
  const config = VARIANTS[variant];
  const app = join(buildRoot, 'staging', `${variant}-node${nodeVersion}-pw${playwrightVersion}`, 'app');
  await mkdir(app, { recursive: true });
  // Staging is variant-scoped, so a lite build can never inherit a kernel.
  // Fail loudly instead of silently shipping 433 MiB if that ever changes.
  if (!config.bundledChromium && await stat(join(app, 'browser')).catch(() => null)) {
    throw new Error(`Light staging tree ${app} already contains a browser directory; remove it before building.`);
  }
  await ensureCopy(join(runtimeCache, 'node.exe'), join(app, 'node.exe'));
  await ensureCopy(join(runtimeCache, 'licenses'), join(app, 'licenses'));
  await ensureCopy(join(runtimeCache, 'node_modules'), join(app, 'node_modules'));
  await ensureCopy(join(runtimeCache, 'detach-daemon.ps1'), join(app, 'detach-daemon.ps1'));
  const browser = config.bundledChromium ? await prepareBrowser() : null;
  if (browser) await ensureCopy(browser.browser, join(app, 'browser/chrome-win64'));
  // The only inputs that change every build, so they are copied over in place.
  await copyFile(join(bundleOutput, 'cli.cjs'), join(app, 'cli.cjs'));
  await copyFile(join(bundleOutput, 'daemon.cjs'), join(app, 'daemon.cjs'));

  // The manifest must not list itself: it is written after this scan, so a
  // reused staging tree would otherwise record the previous run's hash for it
  // and the bootstrap would reject the extraction as a checksum mismatch.
  const files = (await filesAt(app)).filter(entry => entry.path !== 'bundle-manifest.json');
  const manifest = {
    variant, platform: 'win32', arch: 'x64', nodeVersion, playwright: playwrightVersion,
    bundledChromium: config.bundledChromium,
    chromium: browser ? browser.chromium.browserVersion : null,
    chromiumRevision: browser ? browser.chromium.revision : null,
    nodeArchiveSha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    files,
  };
  await writeFile(join(app, 'bundle-manifest.json'), JSON.stringify(manifest));

  const zip = join(buildRoot, `payload-${variant}.zip`);
  await rm(zip, { force: true });
  console.log(`Compressing the ${variant} runtime...`);
  track(`${variant} zip`);
  try {
    await runPS(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(app)}, ${psQuote(zip)}, [IO.Compression.CompressionLevel]::Optimal, $false)`);
  } finally { untrack(); }

  const payload = await readFile(zip), hash = digest(payload);
  const bootstrap = (await readFile(join(root, 'packaging/bootstrap.ps1'), 'utf8'))
    .replace('__BUNDLED_CHROMIUM_ENTRY__', config.chromiumEntry)
    .replaceAll('__FIRST_RUN_NOTE__', config.firstRunNote)
    .replaceAll('__PAYLOAD_HASH__', hash);
  const launcher = (await readFile(join(root, 'packaging/launcher.js'), 'utf8'))
    .replace('__VARIANT_NOTE__', config.variantNote)
    .replaceAll('__PAYLOAD_HASH__', hash)
    .replace('__BOOTSTRAP_BASE64__', Buffer.from(bootstrap, 'utf8').toString('base64'));
  const [header, footer] = launcher.split('__PAYLOAD_BASE64__');
  // A dropped footer produces a file that extracts halfway and then fails with
  // "Embedded payload is incomplete", so refuse to build it at all.
  if (!header?.includes('__TAOBAO_PAYLOAD_BEGIN__') || !footer?.includes('__TAOBAO_PAYLOAD_END__')) {
    throw new Error('Launcher template is missing the payload begin/end markers');
  }
  const distribution = join(root, 'dist', config.directory);
  await mkdir(distribution, { recursive: true });
  const output = await open(join(distribution, 'taobao.js'), 'w');
  console.log(`Writing ${(payload.length * 4 / 3 / 1024 / 1024).toFixed(0)} MiB of Base64...`);
  try {
    await output.write(header);
    // 6144 input bytes -> 8192 Base64 characters. The bootstrap decodes one
    // line at a time, avoiding a giant PowerShell Base64 string allocation.
    const total = payload.length;
    const chunks = Math.ceil(total / 6144), reportEvery = Math.max(1, Math.floor(chunks / 10));
    let chunk = 0;
    for (let offset = 0; offset < total; offset += 6144) {
      await output.write(payload.subarray(offset, offset + 6144).toString('base64') + '\n');
      chunk += 1;
      if (chunk % reportEvery === 0) console.log(`  ... Base64 ${((chunk / chunks) * 100).toFixed(0)}%`);
    }
    await output.write(footer);
  } finally { await output.close(); untrack(); }
  await cp(join(root, 'skills/taobao-search/SKILL.md'), join(distribution, 'SKILL.md'));
  const releaseBytes = (await stat(join(distribution, 'taobao.js'))).size;
  const receipt = { builtAt: new Date().toISOString(), payloadHash: hash, ...manifest, releaseBytes, payloadBytes: payload.length };
  await mkdir(join(root, 'artifacts/release'), { recursive: true });
  await writeFile(join(root, `artifacts/release/build-${variant}.json`), JSON.stringify(receipt, null, 2));
  console.log(`Release ${variant}: ${relative(root, distribution)} (exactly taobao.js + SKILL.md)`);
  return { variant, directory: config.directory, releaseBytes, payloadBytes: payload.length, bundledChromium: config.bundledChromium };
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows x64 on Windows x64');
const variants = parseVariants(process.argv.slice(2));
await mkdir(buildRoot, { recursive: true });
console.log(`Bundling application with webpack (variants: ${variants.join(', ')})...`);
await new Promise((resolveBuild, reject) => {
  const compiler = webpack(webpackConfig);
  compiler.run((error, stats) => {
    compiler.close(() => {});
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
    else { console.log(stats.toString({ all: false, assets: true, warnings: true })); resolveBuild(); }
  });
});
const nodeVersion = await prepareRuntime();
const built = [];
for (const variant of variants) built.push(await assemble(variant, nodeVersion));
console.log('\nSummary');
for (const value of built) {
  console.log(`  ${value.variant.padEnd(6)} ${(value.releaseBytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  `
    + `payload ${(value.payloadBytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  `
    + `chromium ${value.bundledChromium ? 'embedded' : 'reused'}`);
}
