import { afterEach, describe, expect, test } from 'vitest';
import { ClientManager } from '../../src/client/manager.js';
import { defaultRegistry } from '../../src/client/registry.js';
import { createFakeDriver, fakeConfig } from '../helpers/fake-driver.js';
import { createClient } from '../../src/client/index.js';

const DIALECT = 'mgr-test';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

describe('ClientManager（多数据源注册表）', () => {
  test('getClient 命中共享池：多次获取连接数不增长', async () => {
    createFakeDriver(DIALECT);
    const manager = new ClientManager();
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const c1 = manager.getClient(cfg);
    const c2 = manager.getClient(cfg);
    expect(c1.fingerprint).toBe(c2.fingerprint);
    // 触发建池（ping 走池；testConnection 是一次性连接不入池）
    await c1.ping();
    await c2.ping();
    const m = manager.metrics();
    expect(m.pools).toBe(1);
    expect(m.clients).toBe(2); // 两个 client 各持一引用，共享同一池
    await c1.destroy();
    await c2.destroy();
  });

  test('register + getClientById + release', async () => {
    createFakeDriver(DIALECT);
    const manager = new ClientManager();
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const client = await manager.register('ds-1', cfg);
    expect(manager.getClientById('ds-1')).toBe(client);
    expect(manager.getConfigById('ds-1')).toEqual(cfg);
    await manager.release('ds-1');
    expect(manager.getClientById('ds-1')).toBeUndefined();
  });

  test('invalidate(dsId) 强制销毁旧池', async () => {
    createFakeDriver(DIALECT);
    const manager = new ClientManager();
    await manager.register('ds-1', fakeConfig(DIALECT, { database: 'd1' }));
    expect(manager.metrics().pools).toBe(1);
    await manager.invalidate('ds-1');
    expect(manager.metrics().pools).toBe(0);
    expect(manager.getClientById('ds-1')).toBeUndefined();
  });

  test('invalidate(config) 按指纹销毁', async () => {
    createFakeDriver(DIALECT);
    const manager = new ClientManager();
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const client = manager.getClient(cfg);
    await client.ping();
    expect(manager.metrics().pools).toBe(1);
    await manager.invalidate(cfg);
    expect(manager.metrics().pools).toBe(0);
  });

  test('destroyAll 清理', async () => {
    createFakeDriver(DIALECT);
    const manager = new ClientManager();
    manager.getClient(fakeConfig(DIALECT, { database: 'a' }));
    manager.getClient(fakeConfig(DIALECT, { database: 'b' }));
    await manager.destroyAll();
    expect(manager.metrics().pools).toBe(0);
  });
});

describe('createClient（极简入口）', () => {
  test('懒建池：创建零成本，首次操作才建池', async () => {
    createFakeDriver(DIALECT);
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const client = createClient(cfg);
    expect(defaultRegistry.metrics().pools).toBe(0); // 未建池
    await client.ping();
    expect(defaultRegistry.metrics().pools).toBe(1);
    await client.destroy();
  });

  test('同一 config 的多个 client 共享 defaultRegistry 池', async () => {
    createFakeDriver(DIALECT);
    const cfg = fakeConfig(DIALECT, { database: 'd1' });
    const a = createClient(cfg);
    const b = createClient(cfg);
    await a.ping();
    await b.ping();
    const m = defaultRegistry.metrics();
    expect(m.pools).toBe(1);
    expect(m.clients).toBe(2);
    await a.destroy();
    await b.destroy();
  });
});
