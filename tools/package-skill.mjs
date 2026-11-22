// 打包 WorkBuddy skill：把仓库编译后的纯 JS 运行时（build/ + bin/）收进 skill/ 布局，
// 压成 dist/taobao-product-search.zip（目标机零 npm 依赖，兼容所有 Node >= 22）。
// 目录映射：skill/SKILL.md + skill/scripts/taobao.mjs + {bin,build,package.json,cookie.example.json} → taobao-cli/
// 用法：npm run pkg
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';

const STAGE = '.runtime/skill-stage/taobao-product-search';
const ZIP = 'dist/taobao-product-search.zip';

await rm('.runtime/skill-stage', { recursive: true, force: true });
await mkdir(STAGE + '/scripts/taobao-cli', { recursive: true });
await cp('skill/SKILL.md', STAGE + '/SKILL.md');
await cp('skill/scripts/taobao.mjs', STAGE + '/scripts/taobao.mjs');
await cp('bin', STAGE + '/scripts/taobao-cli/bin', { recursive: true });
// 仅打入编译产物（.js + .d.ts），跳过 .map 减小分发包体积。
await cp('build', STAGE + '/scripts/taobao-cli/build', {
  recursive: true,
  filter: src => !src.endsWith('.map'),
});
for (const file of ['package.json', 'cookie.example.json']) {
  await cp(file, STAGE + '/scripts/taobao-cli/' + file);
}

// 清单核对：src 下每个 .ts 模块都必须在 build staging 里有对应的编译产物 .js（防止漏编或漏带）。
const walk = async dir => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + entry.name;
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
};
const srcFiles = await walk('src');
for (const file of srcFiles) {
  const built = file.replace(/^src\//, 'build/').replace(/\.ts$/, '.js');
  await readFile(STAGE + '/scripts/taobao-cli/' + built); // 不存在会抛
}
console.log('staged files: build=' + srcFiles.length + ' modules (+ bin/package.json/cookie.example.json/SKILL.md/taobao.mjs)');
await writeFile('.runtime/skill-stage/.staged', 'ok\n');

// 压 zip 交给 PowerShell Compress-Archive（见 package.json scripts.pkg）。
console.log('staging 完成：.runtime/skill-stage/taobao-product-search → 执行 pkg:zip 生成 ' + ZIP);
