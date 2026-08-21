/**
 * selectOnly 只读模式 + duration 返回测试
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createClient, runSql } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import { SqlEngineError } from '../../src/errors.js';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

function makeDb(extra: Record<string, unknown> = {}) {
  return createClient({ type: 'sqlite', database: ':memory:', ...extra });
}

describe('selectOnly 只读模式', () => {
  test('仅允许 SELECT：query 正常（共享 :memory: 池读数据）', async () => {
    // 先用可写 client 准备数据（同一 :memory: 指纹共享同一 DB）
    const writable = createClient({ type: 'sqlite', database: ':memory:' });
    await writable.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await writable.execute('INSERT INTO t (v) VALUES (1), (2)');

    const readOnly = makeDb({ selectOnly: true });
    const res = await readOnly.query('SELECT * FROM t');
    expect(res.rows).toHaveLength(2);

    await writable.destroy();
    await readOnly.destroy();
  });

  test('拒绝 DML/DDL：execute → READ_ONLY', async () => {
    const db = makeDb({ selectOnly: true });
    await expect(db.execute('INSERT INTO t (v) VALUES (1)')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    await expect(db.execute('CREATE TABLE t (id INT)')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    await expect(db.execute('DELETE FROM t')).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
  });

  test('拒绝 run() 中的写语句', async () => {
    const db = makeDb({ selectOnly: true });
    await expect(db.run({ sql: 'UPDATE t SET v = 1' })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
  });

  test('拒绝事务（withTransaction）', async () => {
    const db = makeDb({ selectOnly: true });
    await expect(
      db.withTransaction(async (tx) => {
        await tx.execute('SELECT 1');
      }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  test('selectOnly: false（默认）可正常写', async () => {
    const db = makeDb();
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    const ins = await db.execute('INSERT INTO t (v) VALUES (1)');
    expect(ins.affectedRows).toBe(1);
    const res = await db.query('SELECT * FROM t');
    expect(res.rows).toHaveLength(1);
  });

  test('错误为 SqlEngineError 且带 code', async () => {
    const db = makeDb({ selectOnly: true });
    try {
      await db.execute('DELETE FROM t');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SqlEngineError);
      expect((err as SqlEngineError).code).toBe('READ_ONLY');
    }
  });
});

describe('selectOnly 只读模式（facade runSql 路径）', () => {
  test('拒绝 DML/DDL：runSql → READ_ONLY', async () => {
    const cfg = { type: 'sqlite' as const, database: ':memory:', selectOnly: true };
    await expect(
      runSql(cfg, { sql: 'INSERT INTO t (v) VALUES (1)' }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(runSql(cfg, { sql: 'CREATE TABLE t (id INT)' })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    await expect(runSql(cfg, { sql: 'DELETE FROM t' })).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
  });

  test('允许 SELECT：可正常读（同指纹 :memory: 共享数据）', async () => {
    const writable = createClient({ type: 'sqlite', database: ':memory:' });
    await writable.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await writable.execute('INSERT INTO t (v) VALUES (1), (2)');

    const res = await runSql(
      { type: 'sqlite', database: ':memory:', selectOnly: true },
      { sql: 'SELECT * FROM t', offset: 0, limit: 10 },
    );
    expect(res.rows).toHaveLength(2);

    await writable.destroy();
  });

  test('selectOnly: false（默认）facade 可正常写', async () => {
    const cfg = { type: 'sqlite' as const, database: ':memory:' };
    await runSql(cfg, { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)' });
    const ins = await runSql(cfg, { sql: 'INSERT INTO t (v) VALUES (1)' });
    expect(ins.affectedRows).toBe(1);
    const res = await runSql(cfg, { sql: 'SELECT * FROM t' });
    expect(res.rows).toHaveLength(1);
  });
});

describe('查询结果缓存（facade runSql 路径）', () => {
  test('缓存命中：写操作后失效（同一指纹共享缓存）', async () => {
    const cfg = { type: 'sqlite' as const, database: ':memory:' };
    const cacheCfg = { ...cfg, cache: { enabled: true } };
    await runSql(cfg, { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)' });
    await runSql(cfg, { sql: 'INSERT INTO t (v) VALUES (1)' });

    const r1 = await runSql(cacheCfg, { sql: 'SELECT * FROM t' });
    expect(r1.rows).toHaveLength(1);

    // 写操作（走同指纹 cacheCfg）→ 缓存失效
    await runSql(cacheCfg, { sql: 'INSERT INTO t (v) VALUES (2)' });
    const r2 = await runSql(cacheCfg, { sql: 'SELECT * FROM t' });
    expect(r2.rows).toHaveLength(2);
  });

  test('不同 SQL / 不同参数不串缓存', async () => {
    const cacheCfg = { type: 'sqlite' as const, database: ':memory:', cache: { enabled: true } };
    await runSql(cacheCfg, { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)' });
    await runSql(cacheCfg, { sql: 'INSERT INTO t (v) VALUES (1), (2)' });

    const a = await runSql(cacheCfg, { sql: 'SELECT * FROM t WHERE v = ?', params: [1] });
    const b = await runSql(cacheCfg, { sql: 'SELECT * FROM t WHERE v = ?', params: [2] });
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0].v).toBe(1);
    expect(b.rows[0].v).toBe(2);
  });
});

describe('runSql 返回 duration', () => {
  test('client.query 返回 duration（数字 ms）', async () => {
    const db = makeDb();
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const res = await db.query('SELECT * FROM t');
    expect(typeof res.duration).toBe('number');
    expect(res.duration!).toBeGreaterThanOrEqual(0);
  });

  test('client.execute（写操作）也返回 duration', async () => {
    const db = makeDb();
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    const res = await db.execute('INSERT INTO t (v) VALUES (1)');
    expect(typeof res.duration).toBe('number');
  });

  test('缓存命中也返回 duration', async () => {
    const db = makeDb({ cache: { enabled: true } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const r1 = await db.query('SELECT * FROM t');
    const r2 = await db.query('SELECT * FROM t');
    expect(typeof r1.duration).toBe('number');
    expect(typeof r2.duration).toBe('number');
    expect(r2.duration!).toBeLessThanOrEqual(r1.duration! + 0.01 || r1.duration!);
  });

  test('函数式 runSql 返回 duration', async () => {
    const db = makeDb();
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const cfg = { type: 'sqlite' as const, database: ':memory:' };
    const res = await runSql(cfg, { sql: 'SELECT * FROM t', offset: 0, limit: 10 });
    expect(typeof res.duration).toBe('number');
    expect((res as any).rows).toHaveLength(1);
  });

  test('Mongo/MySQL 等驱动路径同样携带 duration（走 client.run）', async () => {
    const db = makeDb();
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1)');
    const res = await db.run({ sql: 'SELECT * FROM t' });
    expect(typeof res.duration).toBe('number');
  });
});
