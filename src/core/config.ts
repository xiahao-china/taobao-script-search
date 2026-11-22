import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

declare const __TAOBAO_PACKAGED__: boolean | undefined;

export const projectRoot: string = process.env.TAOBAO_SEARCH_PROJECT_ROOT || (
  typeof __TAOBAO_PACKAGED__ !== 'undefined' && __TAOBAO_PACKAGED__
    ? dirname(process.argv[1] || '.')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../..')
);

// 运行时目录：Cookie 缓存、跨进程限速记录等程序可写状态都在这里。
export function runtimePaths(
  runtimeDir: string = process.env.TAOBAO_SEARCH_RUNTIME_DIR || join(projectRoot, '.runtime'),
): { directory: string } {
  return { directory: resolve(runtimeDir) };
}
