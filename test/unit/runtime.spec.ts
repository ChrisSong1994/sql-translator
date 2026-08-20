import { afterEach, describe, expect, test } from 'vitest';
import { detectRuntime, __resetRuntimeCache, resolveRuntime } from '../../src/runtime.js';

afterEach(() => {
  __resetRuntimeCache();
});

describe('detectRuntime', () => {
  test('返回 node 或 bun（当前 vitest 在 node 下运行）', () => {
    expect(['node', 'bun']).toContain(detectRuntime());
  });

  test('bun 环境标识（process.versions.bun 存在）', () => {
    const isActuallyBun = detectRuntime() === 'bun';
    // 注入 bun 标识（bun 下原本就有，node 下模拟）
    const orig = (process.versions as any).bun;
    (process.versions as any).bun = '1.3.1';
    __resetRuntimeCache();
    expect(detectRuntime()).toBe('bun');
    __resetRuntimeCache();
    // 还原
    if (orig === undefined) delete (process.versions as any).bun;
    else (process.versions as any).bun = orig;
    // 仅在 node 下断言还原后为 node；bun 下还原后仍是 bun
    if (!isActuallyBun) {
      __resetRuntimeCache();
      expect(detectRuntime()).toBe('node');
    }
  });
});

describe('resolveRuntime', () => {
  test('auto 走探测；显式强制覆盖', () => {
    expect(resolveRuntime('node')).toBe('node');
    expect(resolveRuntime('bun')).toBe('bun');
    expect(resolveRuntime()).toBe(detectRuntime());
    expect(resolveRuntime('auto')).toBe(detectRuntime());
  });
});
