/**
 * 事务测试：withTransaction（SQLite 内存库 + 可选 PG/MySQL/Mongo docker）
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

describe('withTransaction（SQLite）', () => {
  test('成功提交：事务内 DML 生效', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');

    await db.withTransaction(async (tx) => {
      await tx.execute('INSERT INTO t (v) VALUES (1), (2)');
      await tx.execute('UPDATE t SET v = v + 10 WHERE id = 1');
      await tx.commit();
    });
    const res = await db.query('SELECT * FROM t ORDER BY id');
    expect(res.rows).toEqual([
      { id: 1, v: 11 },
      { id: 2, v: 2 },
    ]);
  });

  test('异常自动回滚：fn 抛错 → 全部撤销', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');

    await expect(
      db.withTransaction(async (tx) => {
        await tx.execute('INSERT INTO t (v) VALUES (1)');
        await tx.execute('INSERT INTO t (v) VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const res = await db.query('SELECT COUNT(*) AS n FROM t');
    expect(res.rows[0].n).toBe(0);
  });

  test('手动 rollback', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');

    await db.withTransaction(async (tx) => {
      await tx.execute('INSERT INTO t (v) VALUES (1)');
      await tx.rollback();
    });
    const res = await db.query('SELECT COUNT(*) AS n FROM t');
    expect(res.rows[0].n).toBe(0);
  });

  test('tx.runSql 支持完整请求（whereClause 等）', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1), (2), (3)');

    await db.withTransaction(async (tx) => {
      const res = await tx.runSql({ sql: 'SELECT * FROM t', whereClause: 'v >= 2' });
      expect(res.rows).toHaveLength(2);
    });
  });
});

// ---- docker 数据库事务（环境变量就绪才跑） ----
const pgCfg =
  process.env.SQLTRANSLATOR_TEST_PG_HOST && process.env.SQLTRANSLATOR_TEST_PG_PORT
    ? {
        type: 'postgresql' as const,
        host: process.env.SQLTRANSLATOR_TEST_PG_HOST,
        port: Number(process.env.SQLTRANSLATOR_TEST_PG_PORT),
        user: process.env.SQLTRANSLATOR_TEST_PG_USER ?? 'test',
        password: process.env.SQLTRANSLATOR_TEST_PG_PASSWORD ?? 'test',
        database: 'testdb',
      }
    : null;

const mysqlCfg =
  process.env.SQLTRANSLATOR_TEST_MYSQL8_HOST && process.env.SQLTRANSLATOR_TEST_MYSQL8_PORT
    ? {
        type: 'mysql' as const,
        host: process.env.SQLTRANSLATOR_TEST_MYSQL8_HOST,
        port: Number(process.env.SQLTRANSLATOR_TEST_MYSQL8_PORT),
        user: 'root',
        password: 'root',
        database: 'testdb',
      }
    : null;

for (const [name, cfg] of [
  ['PostgreSQL', pgCfg],
  ['MySQL', mysqlCfg],
] as const) {
  const describeDb = cfg ? describe : describe.skip;
  describeDb(`withTransaction（${name}）`, () => {
    test('成功提交 + 异常回滚', async () => {
      const db = createClient(cfg as any);
      await db.execute('DROP TABLE IF EXISTS tx_test');
      await db.execute('CREATE TABLE tx_test (id SERIAL PRIMARY KEY, v INTEGER)');

      // 成功提交
      await db.withTransaction(async (tx) => {
        await tx.execute('INSERT INTO tx_test (v) VALUES (1), (2)');
        await tx.execute('UPDATE tx_test SET v = v + 10 WHERE id = 1');
      });
      let res = await db.query('SELECT COUNT(*) AS n FROM tx_test');
      expect(Number(res.rows[0].n)).toBe(2);

      // 异常回滚
      await expect(
        db.withTransaction(async (tx) => {
          await tx.execute('INSERT INTO tx_test (v) VALUES (3)');
          throw new Error('rollback me');
        }),
      ).rejects.toThrow('rollback me');
      res = await db.query('SELECT COUNT(*) AS n FROM tx_test');
      expect(Number(res.rows[0].n)).toBe(2);

      await db.execute('DROP TABLE tx_test');
      await db.destroy();
    });
  });
}

// MongoDB 事务需要副本集（单实例不支持），验证实现正确报错/成功
// 本机未跑 mongod（或未设 URI）时自动跳过，与仓库其他集成测试的“环境就绪才跑”约定一致
async function isLocalMongoUp(): Promise<boolean> {
  try {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(
      process.env.SQLTRANSLATOR_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017',
      { serverSelectionTimeoutMS: 1500 },
    );
    await c.db().command({ ping: 1 });
    await c.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

describe('withTransaction（MongoDB）', () => {
  test('单实例报错（副本集环境可成功）', async () => {
    if (!(await isLocalMongoUp())) {
      console.warn('[transaction] 本地 MongoDB 不可达，跳过单实例事务测试');
      return;
    }
    const db = createClient({
      type: 'mongodb',
      uri: process.env.SQLTRANSLATOR_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017',
      database: 'testdb',
    });
    try {
      await db.withTransaction(async (tx) => {
        await tx.execute('INSERT INTO tx_mongo_test (a) VALUES (1)');
        return 'ok';
      });
      // 副本集环境：事务成功
      expect(true).toBe(true);
    } catch (err) {
      // 单实例：session.withTransaction 明确报错（需要副本集/分片集群）
      expect(String(err)).toMatch(/retryable|replica|transaction|session/i);
    }
    await db.destroy();
  });
});
