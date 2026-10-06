import webpack from 'webpack';
import webpackConfig from '../packaging/webpack.config.js';
import { readFile, writeFile, mkdir, cp, rm, readdir, stat, open } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve('.');
const buildRoot = join(root, '.cache/release-build');
const app = join(buildRoot, 'app');
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const runPS = script => exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { maxBuffer: 1024 * 1024, windowsHide: true });
async function removeBuild(path) {
  if (!resolve(path).startsWith(buildRoot + sep)) throw new Error('Unsafe build cleanup');
  await rm(path, { recursive: true, force: true });
}
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
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows x64 on Windows x64');
await mkdir(buildRoot, { recursive: true });
await removeBuild(app);
console.log('Bundling application with webpack...');
await new Promise((resolveBuild, reject) => {
  const compiler = webpack(webpackConfig);
  compiler.run((error, stats) => {
    compiler.close(() => {});
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
    else { console.log(stats.toString({ all: false, assets: true, warnings: true })); resolveBuild(); }
  });
});
const nodeVersion = '24.21.0';
const archiveName = `node-v${nodeVersion}-win-x64.zip`;
const archiveHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const nodeZip = join(root, '.cache', archiveName);
try { await stat(nodeZip); } catch { console.log('Downloading build-time portable Node runtime...'); await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, nodeZip); }
if (digest(await readFile(nodeZip)) !== archiveHash) throw new Error('Official Node archive SHA-256 mismatch');
const nodeDirectory = join(buildRoot, `node-v${nodeVersion}-win-x64`);
try { await stat(join(nodeDirectory, 'node.exe')); } catch {
  await runPS(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(nodeZip)}, ${psQuote(buildRoot)})`);
}
await cp(join(nodeDirectory, 'node.exe'), join(app, 'node.exe'));
await mkdir(join(app, 'licenses'), { recursive: true });
await cp(join(nodeDirectory, 'LICENSE'), join(app, 'licenses/Node-LICENSE.txt'));
for (const name of ['playwright', 'playwright-core']) {
  await cp(join(root, 'node_modules', name), join(app, 'node_modules', name), { recursive: true });
}
const browsers = JSON.parse(await readFile(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
const chromium = browsers.browsers.find(value => value.name === 'chromium');
const browserCache = join(root, '.cache/release-browser');
const browser = join(browserCache, `chromium-${chromium.revision}`, 'chrome-win64');
try { await stat(join(browser, 'chrome.exe')); } catch {
  console.log('Downloading build-time portable Chromium...');
  const result = await exec(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium', '--no-shell'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache }, maxBuffer: 1024 * 1024, windowsHide: true });
  console.log(result.stdout);
}
await cp(browser, join(app, 'browser/chrome-win64'), { recursive: true });
await cp(join(root, 'packaging/detach-daemon.ps1'), join(app, 'detach-daemon.ps1'));
const manifest = { platform: 'win32', arch: 'x64', nodeVersion, playwright: '1.63.0', chromium: chromium.browserVersion, nodeArchiveSha256: archiveHash, files: await filesAt(app) };
await writeFile(join(app, 'bundle-manifest.json'), JSON.stringify(manifest));
const zip = join(buildRoot, 'payload.zip');
await rm(zip, { force: true });
console.log('Compressing runtime, browser, application and licenses...');
await runPS(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(app)}, ${psQuote(zip)}, [IO.Compression.CompressionLevel]::Optimal, $false)`);
const payload = await readFile(zip), hash = digest(payload);
const bootstrap = (await readFile(join(root, 'packaging/bootstrap.ps1'), 'utf8')).replaceAll('__PAYLOAD_HASH__', hash);
const launcher = (await readFile(join(root, 'packaging/launcher.js'), 'utf8')).replaceAll('__PAYLOAD_HASH__', hash).replace('__BOOTSTRAP_BASE64__', Buffer.from(bootstrap, 'utf8').toString('base64'));
const [header, footer] = launcher.split('__PAYLOAD_BASE64__');
const distribution = join(root, 'dist', 'taobao-search-win11-x64');
await mkdir(distribution, { recursive: true });
const output = await open(join(distribution, 'taobao.js'), 'w');
try {
  await output.write(header);
  // 6144 input bytes -> 8192 Base64 characters. The bootstrap decodes one
  // line at a time, avoiding a giant PowerShell Base64 string allocation.
  for (let offset = 0; offset < payload.length; offset += 6144) await output.write(payload.subarray(offset, offset + 6144).toString('base64') + '\n');
  await output.write(footer);
} finally { await output.close(); }
await cp(join(root, 'skills/taobao-search/SKILL.md'), join(distribution, 'SKILL.md'));
const receipt = { builtAt: new Date().toISOString(), payloadHash: hash, ...manifest, releaseBytes: (await stat(join(distribution, 'taobao.js'))).size };
await mkdir(join(root, 'artifacts/release'), { recursive: true });
await writeFile(join(root, 'artifacts/release/build.json'), JSON.stringify(receipt, null, 2));
console.log(`Release: ${relative(root, distribution)} (exactly taobao.js + SKILL.md)`);
console.log(`JS size: ${(receipt.releaseBytes / 1024 / 1024).toFixed(1)} MiB; payload SHA-256: ${hash}`);
