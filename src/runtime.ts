/**
 * 运行时探测：Node / Bun
 */

import type { RuntimeChoice, RuntimeName } from './types/config.js';

let cached: RuntimeName | null = null;

/** 探测当前运行时 */
export function detectRuntime(): RuntimeName {
  if (cached) return cached;
  const isBun =
    typeof process !== 'undefined' &&
    typeof (process as any).versions === 'object' &&
    (process as any).versions !== null &&
    typeof (process as any).versions.bun === 'string';
  cached = isBun ? 'bun' : 'node';
  return cached;
}

/** 根据 config.runtime（auto 缺省）解析实际运行时 */
export function resolveRuntime(choice?: RuntimeChoice): RuntimeName {
  if (choice === 'node' || choice === 'bun') return choice;
  return detectRuntime();
}

export type { RuntimeName, RuntimeChoice } from './types/config.js';

/** 测试辅助：重置探测缓存（改变 process.versions.bun 后调用） */
export function __resetRuntimeCache(): void {
  cached = null;
}
