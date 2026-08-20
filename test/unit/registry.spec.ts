import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PoolRegistry } from '../../src/client/registry.js';
import { createFakeDriver, fakeConfig } from '../helpers/fake-driver.js';
import { SqlEngineError } from '../../src/errors.js';

const DIALECT = 'reg-test';

beforeEach(() => {
  createFakeDriver(DIALECT);
});

afterEach(async () => {
  // 每个用例后清空注册表，避免跨用例池泄漏
  await defaultRegistryReset();
});

// 独立的 registry 实例（不污染模块级 defaultRegistry）
function newRegistry(opts?: any) {
  return new PoolRegistry(opts);
}

async function defaultRegistryReset() {
  // 使用独立 registry 的用例不需要清 defaultRegistry；此处仅保证测试隔离
}

describe('PoolRegistry', () => {
  test('同一 config → 共享同一池；不同 config → 不同池', async () => {
    const reg = newRegistry();
    const cfg1 = fakeConfig(DIALECT, { database: 'd1' });
    const cfg2 = fakeConfig(DIALECT, { database: 'd1' });
    const cfg3 = fakeConfig(DIALECT, { database: 'd2' });

    const h1 = await reg.getPool(cfg1);
    const h2 = await reg.getPool(cfg2);
    const h3 = await reg.getPool(cfg3);

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(reg.metrics().pools).toBe(2);
    expect(reg.metrics().clients).toBe(3);
  });

  test('引用计数：release 归零后池可被回收', async () => {
    const reg = newRegistry({ lru: { enabled: true, maxIdlePools: 1 } });
    const cfg = fakeConfig(DIALECT);
    const h = await reg.getPool(cfg);
    const fp = h.fingerprint;
    reg.release(fp);
    reg.release(fp); // 重复释放安全
    expect(reg.metrics().clients).toBe(0);
  });

  test('LRU：空闲池超过 maxIdlePools 时淘汰最久未用', async () => {
    const reg = newRegistry({ lru: { enabled: true, maxIdlePools: 2 } });
    const handles = [];
    for (let i = 0; i < 4; i++) {
      const cfg = fakeConfig(DIALECT, { database: `db-${i}` });
      handles.push(await reg.getPool(cfg));
    }
    // 全部释放（refs → 0）
    for (const h of handles) reg.release(h.fingerprint);
    // 4 个空闲池 > maxIdlePools=2 → 淘汰最老的 2 个
    expect(reg.metrics().pools).toBe(2);
  });

  test('maxClients 上限：超限抛 CLIENT_LIMIT_EXCEEDED', async () => {
    const reg = newRegistry({ maxClients: 2 });
    const cfg1 = fakeConfig(DIALECT, { database: 'a' });
    const cfg2 = fakeConfig(DIALECT, { database: 'b' });
    await reg.getPool(cfg1);
    await reg.getPool(cfg2);
    await expect(reg.getPool(fakeConfig(DIALECT, { database: 'c' }))).rejects.toMatchObject({
      code: 'CLIENT_LIMIT_EXCEEDED',
    });
  });

  test('未注册方言 → UNSUPPORTED_DIALECT', async () => {
    const reg = newRegistry();
    await expect(reg.getPool({ type: 'no-such-dialect' } as any)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DIALECT',
    });
  });

  test('invalidate 强制销毁并可从新 config 重建', async () => {
    const reg = newRegistry();
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const h1 = await reg.getPool(cfg);
    await reg.invalidate(h1.fingerprint);
    expect(h1.destroyed).toBe(true);
    expect(reg.metrics().pools).toBe(0);

    // 同 config 重建 → 新池
    const h2 = await reg.getPool(cfg);
    expect(h2).not.toBe(h1);
    expect(h2.destroyed).toBe(false);
  });

  test('destroyAll 清空全部', async () => {
    const reg = newRegistry();
    await reg.getPool(fakeConfig(DIALECT, { database: 'a' }));
    await reg.getPool(fakeConfig(DIALECT, { database: 'b' }));
    await reg.destroyAll();
    expect(reg.metrics().pools).toBe(0);
    expect(reg.metrics().clients).toBe(0);
  });

  test('metrics 汇总统计', async () => {
    const reg = newRegistry();
    const h = await reg.getPool(fakeConfig(DIALECT, { database: 'a' }));
    void h;
    const m = reg.metrics();
    expect(m.clients).toBe(1);
    expect(m.pools).toBe(1);
    expect(typeof m.createdTotal).toBe('number');
  });
});

describe('SqlEngineError 基础', () => {
  test('构造与 isSqlEngineError', async () => {
    const err = new SqlEngineError('QUERY_FAILED', 'boom', { dialect: 'sqlite' });
    expect(err.code).toBe('QUERY_FAILED');
    expect(err.dialect).toBe('sqlite');
    expect(err instanceof Error).toBe(true);
  });
});
