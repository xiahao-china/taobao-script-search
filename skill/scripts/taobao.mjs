#!/usr/bin/env node
// 淘宝商品查询 CLI 包装器。Cookie 解析优先级：
//   1. 环境变量 TAOBAO_COOKIE_FILE（显式指定即独占）
//   2. 本 skill 同级的 cookie.json（即 SKILL.md 旁边——分发后放一个配置文件即可用，无需重新打包）
//   3. 主项目 D:\项目\taobao-script-search\.runtime\mtop-cookies.json（开发机回退）
// 运行时目录（限速排队记录）同理指回主项目；都没有时由 CLI 默认到 scripts/taobao-cli/.runtime。
// 其余参数原样透传给捆绑的 bin/taobao.js（parseArgs 读 argv.slice(2)，无需改写 argv）。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const skillDir = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ 的上一级
// 开发机回退路径可用 TAOBAO_PROJECT_ROOT 覆盖（分发/换机场景），避免绑定个人绝对路径。
const mainProject = process.env.TAOBAO_PROJECT_ROOT || 'D:\\项目\\taobao-script-search';
const cli = join(skillDir, 'scripts', 'taobao-cli', 'bin', 'taobao.js');

if (!process.env.TAOBAO_COOKIE_FILE) {
  const skillCookie = join(skillDir, 'cookie.json');
  const mainCookie = join(mainProject, '.runtime', 'mtop-cookies.json');
  if (existsSync(skillCookie)) process.env.TAOBAO_COOKIE_FILE = skillCookie;
  else if (existsSync(mainCookie)) process.env.TAOBAO_COOKIE_FILE = mainCookie;
}
if (!process.env.TAOBAO_SEARCH_RUNTIME_DIR && existsSync(join(mainProject, '.runtime'))) {
  process.env.TAOBAO_SEARCH_RUNTIME_DIR = join(mainProject, '.runtime');
}

await import('file://' + cli.replaceAll('\\', '/'));
