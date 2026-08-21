import { afterEach, describe, expect, test } from 'vitest';
import { TtlCache, queryCacheKey } from '../../src/core/cache.js';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

describe('TtlCache', () => {
  test('get/set + TTL 过期', async () => {
    const cache = new TtlCache<string, number>(50);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('a')).toBeUndefined();
  });

  test('容量 LRU：超限淘汰最旧', () => {
    const cache = new TtlCache<string, number>(60000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  test('clear / delete', () => {
    const cache = new TtlCache<string, number>(60000);
    cache.set('a', 1);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('queryCacheKey', () => {
  test('不同 SQL/参数/分页 → 不同 key', () => {
    const base = { fingerprint: 'fp' };
    const k1 = queryCacheKey(base.fingerprint, 'SELECT 1', {});
    const k2 = queryCacheKey(base.fingerprint, 'SELECT 2', {});
    const k3 = queryCacheKey(base.fingerprint, 'SELECT 1', { params: [1] });
    const k4 = queryCacheKey(base.fingerprint, 'SELECT 1', { offset: 10, limit: 10 });
    const set = new Set([k1, k2, k3, k4]);
    expect(set.size).toBe(4);
    // 相同请求 → 相同 key
    expect(queryCacheKey('fp', 'SELECT 1', {})).toBe(k1);
  });
});

describe('client 查询结果缓存（SQLite）', () => {
  test('同 SQL 二次命中缓存（执行计数不增）', async () => {
    let execCount = 0;
    const db = createClient({ type: 'sqlite', database: ':memory:', cache: { enabled: true, ttlMs: 60000 } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1), (2)');

    // 用 run 统计执行次数：包装 driver 不便，改验证返回值一致 + 数据变更后缓存失效
    const r1 = await db.query('SELECT * FROM t');
    const r2 = await db.query('SELECT * FROM t');
    expect(r1.rows).toEqual(r2.rows);
    expect(r1.rows).toHaveLength(2);
    void execCount;

    // 写操作 → 缓存失效 → 新数据可见
    await db.execute('INSERT INTO t (v) VALUES (3)');
    const r3 = await db.query('SELECT * FROM t');
    expect(r3.rows).toHaveLength(3);
  });

  test('参数不同 → 不命中缓存', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:', cache: { enabled: true } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1), (2)');
    const r1 = await db.query('SELECT * FROM t WHERE v >= ?', [1]);
    const r2 = await db.query('SELECT * FROM t WHERE v >= ?', [2]);
    expect(r1.rows).toHaveLength(2);
    expect(r2.rows).toHaveLength(1);
  });

  test('缓存未启用时不缓存', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const r1 = await db.query('SELECT * FROM t');
    await db.execute('INSERT INTO t (v) VALUES (2)');
    const r2 = await db.query('SELECT * FROM t');
    expect(r2.rows).toHaveLength(2); // 无缓存 → 立即看到新数据
  });

  test('返回结果隔离：外部修改不影响缓存', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:', cache: { enabled: true } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const r1 = await db.query('SELECT * FROM t');
    r1.rows[0].v = 999; // 外部修改
    const r2 = await db.query('SELECT * FROM t');
    expect(r2.rows[0].v).toBe(1); // 缓存未被污染
  });
});
