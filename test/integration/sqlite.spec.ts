/**
 * SQLite 集成测试（node:sqlite 真库执行，:memory: 无需 docker）
 * 覆盖：查询/分页/DML 与护栏/元信息/结构 JSON 检出/全库导出
 *
 * 隔离策略：每个用例通过 makeDb() 新建 client（afterEach 销毁注册表 →
 * 下一个用例得到全新的 :memory: 库），避免用例间表/数据互相污染。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import { SqlEngineError } from '../../src/errors.js';
import type { DbClient } from '../../src/client/index.js';

/** 新建内存库 client（每个用例独立） */
function makeDb(config: Record<string, unknown> = {}): DbClient {
  return createClient({ type: 'sqlite', database: ':memory:', ...config });
}

/** 建 users 表并插入 3 行种子数据 */
async function seedUsers(db: DbClient): Promise<void> {
  await db.execute(
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER, active INTEGER)',
  );
  await db.execute(
    "INSERT INTO users (name, age, active) VALUES ('alice', 30, 1), ('bob', 20, 0), ('carol', 25, 1)",
  );
}

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

describe('连接测试', () => {
  test(':memory: testConnection 成功', async () => {
    const db = makeDb();
    const r = await db.testConnection();
    expect(r.success).toBe(true);
    await db.destroy();
  });

  test('无效路径 → 失败信息', async () => {
    const bad = createClient({ type: 'sqlite', database: '/nonexistent-dir-xyz/a.db' });
    const r = await bad.testConnection();
    expect(r.success).toBe(false);
    expect(r.message).toContain('failed');
    await bad.destroy();
  });
});

describe('查询执行', () => {
  test('query + 参数绑定', async () => {
    const db = makeDb();
    await seedUsers(db);
    const res = await db.query('SELECT * FROM users WHERE age > ?', [22]);
    expect(res.rows).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.rows[0]).toMatchObject({ name: 'alice' });
    const fields = res.fields!;
    expect(fields.find((f) => f.field_name === 'age')?.field_type).toBe('integer');
  });

  test('分页：run({offset, limit})', async () => {
    const db = makeDb();
    await seedUsers(db);
    const res = await db.run({ sql: 'SELECT * FROM users ORDER BY id', offset: 1, limit: 1 });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ name: 'bob' });
    expect((res as any).total).toBe(3);
  });

  test('用户 SQL 自带 LIMIT → 不二次包装，total = rows.length', async () => {
    const db = makeDb();
    await seedUsers(db);
    const res = await db.query('SELECT * FROM users LIMIT 2');
    expect(res.rows).toHaveLength(2);
    expect(res.total).toBe(2);
  });

  test('whereClause 包装（WITH __t AS ...）', async () => {
    const db = makeDb();
    await seedUsers(db);
    const res = await db.run({
      sql: 'SELECT * FROM users',
      whereClause: 'age >= 25',
    });
    expect(res.rows.map((r) => r.name).sort()).toEqual(['alice', 'carol']);
  });

  test('聚合/排序/JOIN', async () => {
    const db = makeDb();
    await seedUsers(db);
    const agg = await db.query('SELECT COUNT(*) AS cnt, AVG(age) AS avg_age FROM users');
    expect(agg.rows[0]).toMatchObject({ cnt: 3 });

    await db.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL)');
    await db.execute('INSERT INTO orders (user_id, amount) VALUES (1, 10.5), (1, 5), (3, 99)');
    const joinRes = await db.query(
      'SELECT u.name, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.name ORDER BY u.name',
    );
    expect(joinRes.rows).toEqual([
      { name: 'alice', n: 2 },
      { name: 'bob', n: 0 },
      { name: 'carol', n: 1 },
    ]);
  });

  test('query() 拒绝 DML，execute() 拒绝 SELECT', async () => {
    const db = makeDb();
    await expect(db.query('INSERT INTO t (a) VALUES (1)')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    });
    await expect(db.execute('SELECT 1')).rejects.toMatchObject({ code: 'QUERY_FAILED' });
  });
});

describe('DML 写操作', () => {
  test('INSERT 单行 → affectedRows + insertId', async () => {
    const db = makeDb();
    await seedUsers(db);
    const r = await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['dave', 40]);
    expect(r.affectedRows).toBe(1);
    expect(r.insertId).toBe(4);
  });

  test('UPDATE/DELETE → affectedRows', async () => {
    const db = makeDb();
    await seedUsers(db);
    const u = await db.execute('UPDATE users SET age = age + 1 WHERE name = ?', ['bob']);
    expect(u.affectedRows).toBe(1);
    const d = await db.execute('DELETE FROM users WHERE name = ?', ['carol']);
    expect(d.affectedRows).toBe(1);
  });

  test('安全护栏：无 WHERE 的 UPDATE/DELETE 默认拦截', async () => {
    const db = makeDb();
    await seedUsers(db);
    await expect(db.execute('UPDATE users SET age = 0')).rejects.toMatchObject({
      code: 'DML_BLOCKED',
    });
    await expect(db.execute('DELETE FROM users')).rejects.toMatchObject({ code: 'DML_BLOCKED' });
  });

  test('dml.requireWhereForUpdateDelete=false 放行', async () => {
    const db = makeDb({ dml: { requireWhereForUpdateDelete: false } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1), (2)');
    const r = await db.execute('UPDATE t SET v = 9');
    expect(r.affectedRows).toBe(2);
  });

  test('dml.returning=true 回读被写行', async () => {
    const db = makeDb({ dml: { returning: true } });
    // AUTOINCREMENT：删除后不复用 rowid，insertId 语义可预测
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)');
    await db.execute('INSERT INTO t (v) VALUES (1), (2)');
    const upd = await db.execute('UPDATE t SET v = v + 10 WHERE id = 1');
    expect(upd.affectedRows).toBe(1);
    expect(upd.returning).toEqual([{ id: 1, v: 11 }]);
    const del = await db.execute('DELETE FROM t WHERE id = 2');
    expect(del.returning).toEqual([{ id: 2, v: 2 }]);
    const ins = await db.execute('INSERT INTO t (v) VALUES (5)');
    expect(ins.insertId).toBe(3);
    expect(ins.returning).toEqual([{ id: 3, v: 5 }]);
  });

  test('maxInsertRows 超限拦截', async () => {
    const db = makeDb({ dml: { maxInsertRows: 2 } });
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await expect(db.execute('INSERT INTO t (v) VALUES (1), (2), (3)')).rejects.toMatchObject({
      code: 'DML_BLOCKED',
    });
  });
});

describe('元信息检出', () => {
  test('getTableList / getColumns / getRowsCount / getPreviewRows / getTableDDL', async () => {
    const db = makeDb();
    await seedUsers(db);

    const tables = await db.getTables();
    expect(tables).toContain('users');

    const cols = await db.getColumns('users');
    expect(cols.find((c) => c.field_name === 'id')?.is_primary).toBe(1);

    expect(await db.getRowsCount('users')).toBe(3);
    expect(await db.getRowsCount('users', 'age > 21')).toBe(2);

    const preview = await db.getPreviewRows('users', 1, 1);
    expect(preview).toHaveLength(1);

    const ddl = await db.getTableDDL('users');
    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain('users');
  });

  test('getTableSchema 结构 JSON（字段/主键/自增/索引/DDL）', async () => {
    const db = makeDb();
    await seedUsers(db);
    await db.execute('CREATE INDEX idx_users_age ON users (age)');

    const schema = await db.getTableSchema('users');
    expect(schema.kind).toBe('table');
    expect(schema.columns.find((c) => c.name === 'id')).toMatchObject({
      primaryKey: true,
      autoIncrement: true,
      type: 'INTEGER',
    });
    expect(schema.ddl).toContain('AUTOINCREMENT');
    // 显式索引被检出（INTEGER PRIMARY KEY 不产生 sqlite_master 索引，单独断言）
    expect(schema.indexes!.some((i) => i.name === 'idx_users_age' && i.columns.includes('age'))).toBe(
      true,
    );
  });

  test('不存在的表 → TABLE_NOT_FOUND', async () => {
    const db = makeDb();
    await expect(db.getTableSchema('no_such_table')).rejects.toMatchObject({
      code: 'TABLE_NOT_FOUND',
    });
  });
});

describe('全库结构导出（长任务）', () => {
  test('getAllTableSchemas 进度 → done，exportSchemaAsJson 输出合法 JSON', async () => {
    const db = makeDb();
    await seedUsers(db);
    await db.execute('CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)');

    const task = db.getAllTableSchemas();
    const stages: string[] = [];
    task.onProgress((p) => stages.push(p.stage));
    const schemas = await task.promise;
    expect(task.status).toBe('done');
    expect(stages).toContain('done');
    expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['users', 'tags']));

    const json = await db.exportSchemaAsJson();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((s: any) => s.name === 'users')).toBe(true);
  });
});

describe('错误路径', () => {
  test('非法 SQL → QUERY_FAILED（SqlEngineError）', async () => {
    const db = makeDb();
    await expect(db.query('SELECT * FROM')).rejects.toBeInstanceOf(SqlEngineError);
    await expect(db.query('SELECT * FROM')).rejects.toMatchObject({ code: 'QUERY_FAILED' });
  });

  test('未注册方言 client → 创建不抛错，首次操作 UNSUPPORTED_DIALECT', async () => {
    const c = createClient({ type: 'oracle', host: 'h', database: 'd' } as any);
    await expect(c.query('SELECT 1')).rejects.toMatchObject({ code: 'UNSUPPORTED_DIALECT' });
  });

  test('destroy 后不可用', async () => {
    const db = makeDb();
    await db.destroy();
    await expect(db.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe('文件库持久化', () => {
  test('两个 client 共享文件库（注册表同池）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sql-engine-'));
    const dbPath = join(dir, 'persist.db');
    try {
      const a = createClient({ type: 'sqlite', database: dbPath });
      await a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await a.execute('INSERT INTO t (v) VALUES (?)', ['hello']);
      await a.destroy();

      const b = createClient({ type: 'sqlite', database: dbPath });
      const rows = await b.query('SELECT * FROM t');
      expect(rows.rows).toEqual([{ id: 1, v: 'hello' }]);
      await b.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
