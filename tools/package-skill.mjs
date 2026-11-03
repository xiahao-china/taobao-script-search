// 打包 WorkBuddy skill：把仓库 CLI 收进 skill/ 布局，压成 dist/taobao-product-search.zip。
// 目录映射：skill/SKILL.md + skill/scripts/taobao.mjs + {bin,src,package.json,cookie.example.json} → taobao-cli/
// 用法：node tools/package-skill.mjs
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';

const STAGE = '.runtime/skill-stage/taobao-product-search';
const ZIP = 'dist/taobao-product-search.zip';

await rm('.runtime/skill-stage', { recursive: true, force: true });
await mkdir(STAGE + '/scripts/taobao-cli', { recursive: true });
await cp('skill/SKILL.md', STAGE + '/SKILL.md');
await cp('skill/scripts/taobao.mjs', STAGE + '/scripts/taobao.mjs');
await cp('bin', STAGE + '/scripts/taobao-cli/bin', { recursive: true });
await cp('src', STAGE + '/scripts/taobao-cli/src', { recursive: true });
for (const file of ['package.json', 'cookie.example.json']) {
  await cp(file, STAGE + '/scripts/taobao-cli/' + file);
}

// 清单核对：src 下所有 .js 必须都在 staging 里（防止漏带新模块）。
const walk = async dir => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + entry.name;
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
};
const srcFiles = await walk('src');
for (const file of srcFiles) {
  await readFile(STAGE + '/scripts/taobao-cli/' + file); // 不存在会抛
}
console.log('staged files: src=' + srcFiles.length + ' (+ bin/package.json/cookie.example.json/SKILL.md/taobao.mjs)');
await writeFile('.runtime/skill-stage/.staged', 'ok\n');

// 压 zip 交给 PowerShell Compress-Archive（见 package.json scripts.pkg）。
console.log('staging 完成：.runtime/skill-stage/taobao-product-search → 执行 pkg:zip 生成 ' + ZIP);
