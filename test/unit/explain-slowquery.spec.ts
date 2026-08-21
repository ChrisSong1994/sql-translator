/**
 * EXPLAIN 执行计划 + 慢查询日志测试
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createClient, explain as explainFn, runSql } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

async function seedSqlite(db: any) {
  // 幂等建表（:memory: 指纹相同会共享 DB，防止跨用例冲突）
  await db.execute('DROP TABLE IF EXISTS users');
  await db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
  await db.execute("INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 20)");
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_age ON users (age)');
}

describe('EXPLAIN 执行计划（SQLite）', () => {
  test('返回执行计划（QUERY PLAN 行 + 索引使用）', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await seedSqlite(db);
    const result = await db.explain('SELECT * FROM users WHERE age > 20');
    expect(result.dialect).toBe('sqlite');
    expect(Array.isArray(result.plan)).toBe(true);
    expect(result.plan.length).toBeGreaterThan(0);
    // detail 含表名
    const detail = JSON.stringify(result.plan);
    expect(detail).toContain('users');
    // 走索引
    const idxRes = await db.explain('SELECT * FROM users WHERE age > 20');
    expect(JSON.stringify(idxRes.plan)).toContain('idx_users_age');
    expect(typeof result.duration).toBe('number');
  });

  test('explain 支持参数绑定', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await seedSqlite(db);
    const result = await db.explain('SELECT * FROM users WHERE age > ?', [20]);
    expect(result.plan.length).toBeGreaterThan(0);
  });

  test('函数式 explain 也返回计划', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    await seedSqlite(db);
    void db;
    const result = await explainFn({ type: 'sqlite', database: ':memory:' }, 'SELECT * FROM users');
    expect(result.dialect).toBe('sqlite');
    expect(result.plan.length).toBeGreaterThan(0);
  });
});

describe('EXPLAIN（docker 数据库）', () => {
  const pgCfg =
    process.env.SQLTRANSLATOR_TEST_PG_HOST && process.env.SQLTRANSLATOR_TEST_PG_PORT ? true : false;
  const describePg = pgCfg ? describe : describe.skip;
  describePg('PostgreSQL', () => {
    test('EXPLAIN 返回 QUERY PLAN 文本', async () => {
      const db = createClient({
        type: 'postgresql',
        host: process.env.SQLTRANSLATOR_TEST_PG_HOST!,
        port: Number(process.env.SQLTRANSLATOR_TEST_PG_PORT),
        user: process.env.SQLTRANSLATOR_TEST_PG_USER ?? 'test',
        password: process.env.SQLTRANSLATOR_TEST_PG_PASSWORD ?? 'test',
        database: 'testdb',
      });
      const result = await db.explain('SELECT * FROM users WHERE age > 20');
      expect(result.dialect).toBe('postgresql');
      expect(result.plan.join('\n')).toContain('Seq Scan');
      await db.destroy();
    });
  });

  const mysqlCfg =
    process.env.SQLTRANSLATOR_TEST_MYSQL8_HOST && process.env.SQLTRANSLATOR_TEST_MYSQL8_PORT ? true : false;
  const describeMy = mysqlCfg ? describe : describe.skip;
  describeMy('MySQL 8', () => {
    test('EXPLAIN 返回计划行', async () => {
      const db = createClient({
        type: 'mysql',
        host: process.env.SQLTRANSLATOR_TEST_MYSQL8_HOST!,
        port: Number(process.env.SQLTRANSLATOR_TEST_MYSQL8_PORT),
        user: 'root',
        password: 'root',
        database: 'testdb',
      });
      const result = await db.explain('SELECT * FROM users WHERE age > 20');
      expect(result.dialect).toBe('mysql');
      expect(Array.isArray(result.plan)).toBe(true);
      expect(result.plan[0]).toHaveProperty('type');
      await db.destroy();
    });
  });

  const mongoCfg = process.env.SQLTRANSLATOR_TEST_MONGO_URI ? true : false;
  const describeMo = mongoCfg ? describe : describe.skip;
  describeMo('MongoDB', () => {
    test('explain 返回执行统计', async () => {
      const db = createClient({
        type: 'mongodb',
        uri: process.env.SQLTRANSLATOR_TEST_MONGO_URI!,
        database: 'testdb',
      });
      const result = await db.explain("SELECT * FROM users WHERE age > 20");
      expect(result.dialect).toBe('mongodb');
      expect(result.plan[0]).toHaveProperty('executionStats');
      await db.destroy();
    });
  });
});

describe('慢查询日志', () => {
  test('超过 slowQueryMs 阈值触发日志（含 SQL/耗时）', async () => {
    const entries: any[] = [];
    const db = createClient({
      type: 'sqlite',
      database: ':memory:',
      logging: { slowQueryMs: 0, logFn: (e) => entries.push(e) },
    });
    await seedSqlite(db);
    await db.query('SELECT * FROM users'); // 首次可能 < 1ms，执行多次确保
    await db.query('SELECT * FROM users WHERE age > ?', [18]);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0]!;
    expect(entry.type).toBe('slow-query');
    expect(entry.dialect).toBe('sqlite');
    expect(typeof entry.sql).toBe('string');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.at).toBeDefined();
  });

  test('低于阈值不触发；未配置 slowQueryMs 不触发', async () => {
    const entries: any[] = [];
    const db = createClient({
      type: 'sqlite',
      database: ':memory:',
      logging: { slowQueryMs: 100000, logFn: (e) => entries.push(e) },
    });
    await seedSqlite(db);
    await db.query('SELECT * FROM users');
    expect(entries).toHaveLength(0);

    const db2 = createClient({ type: 'sqlite', database: ':memory:' });
    await seedSqlite(db2);
    await db2.query('SELECT * FROM users');
    expect(entries).toHaveLength(0);
  });

  test('写操作也记录慢查询（runSql 统一路径）', async () => {
    const entries: any[] = [];
    const db = createClient({
      type: 'sqlite',
      database: ':memory:',
      logging: { slowQueryMs: 0, logFn: (e) => entries.push(e) },
    });
    await seedSqlite(db);
    await db.execute('UPDATE users SET age = 31 WHERE id = 1');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.sql.includes('UPDATE'))).toBe(true);
  });

  test('默认 logFn 为 console.warn（不抛错）', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = createClient({
      type: 'sqlite',
      database: ':memory:',
      logging: { slowQueryMs: 0 },
    });
    await seedSqlite(db);
    await db.query('SELECT * FROM users');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('函数式 runSql 同样触发慢查询日志', async () => {
    const entries: any[] = [];
    const cfg = {
      type: 'sqlite' as const,
      database: ':memory:',
      logging: { slowQueryMs: 0, logFn: (e: any) => entries.push(e) },
    };
    const { createStaticSqlitePool, importDataToSqlite } = await import('../../src/index.js');
    const pool = await createStaticSqlitePool({ type: 'sqlite', database: ':memory:' });
    await importDataToSqlite(pool, 't', [{ id: 1, v: 'a' }]);
    await pool.destroy();
    // 用普通 config 准备数据
    const prep = createClient({ type: 'sqlite', database: ':memory:' });
    await prep.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await prep.execute("INSERT INTO t (v) VALUES ('a')");
    await runSql(cfg, { sql: 'SELECT * FROM t' });
    expect(entries.length).toBeGreaterThan(0);
    await prep.destroy();
  });
});
