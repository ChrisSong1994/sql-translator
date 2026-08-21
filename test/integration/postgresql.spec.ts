/**
 * PostgreSQL 集成测试（docker compose postgres:16，端口 54321）
 * 未设置 SQLTRANSLATOR_TEST_PG_HOST/PORT 时自动跳过
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import type { PostgresqlConfig } from '../../src/types/config.js';
import type { DbClient } from '../../src/client/index.js';

const host = process.env.SQLTRANSLATOR_TEST_PG_HOST;
const port = process.env.SQLTRANSLATOR_TEST_PG_PORT;
const cfg: PostgresqlConfig | null =
  host && port
    ? {
        type: 'postgresql',
        host,
        port: Number(port),
        user: process.env.SQLTRANSLATOR_TEST_PG_USER ?? 'test',
        password: process.env.SQLTRANSLATOR_TEST_PG_PASSWORD ?? 'test',
        database: process.env.SQLTRANSLATOR_TEST_PG_DATABASE ?? 'testdb',
      }
    : null;

const describePg = cfg ? describe : describe.skip;

describePg('PostgreSQL（docker 54321）', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createClient(cfg!);
    const t = await db.testConnection();
    if (!t.success) throw new Error(`连接失败: ${t.message}`);
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  test('testConnection 成功', async () => {
    expect((await db!.testConnection()).success).toBe(true);
  });

  test('query + 参数绑定（$1 占位符）+ 分页', async () => {
    const res = await db!.query('SELECT * FROM users WHERE age > $1', [22]);
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
    expect(res.total).toBe(2);

    const paged = await db!.run({ sql: 'SELECT * FROM users ORDER BY id', offset: 1, limit: 1 });
    expect(paged.rows[0]).toMatchObject({ name: 'bob' });
    expect((paged as any).total).toBe(3);
  });

  test('whereClause 包装（CTE）', async () => {
    const res = await db!.run({ sql: 'SELECT * FROM users', whereClause: 'age >= 25' });
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
  });

  test('聚合 / JOIN', async () => {
    const agg = await db!.query('SELECT COUNT(*) AS cnt, AVG(age) AS avg_age FROM users');
    expect(agg.rows[0]).toMatchObject({ cnt: '3' }); // pg bigint 返回字符串

    const joinRes = await db!.query(
      `SELECT u.name, COUNT(o.id) AS n FROM users u
       LEFT JOIN orders o ON u.id = o.user_id
       GROUP BY u.name ORDER BY u.name`,
    );
    expect(joinRes.rows).toEqual([
      { name: 'alice', n: '2' },
      { name: 'bob', n: '0' },
      { name: 'carol', n: '1' },
    ]);
  });

  test('DML：INSERT/UPDATE/DELETE + RETURNING + 护栏', async () => {
    // 独立临时表，避免污染种子数据
    await db!.execute('CREATE TABLE tmp_dml (id SERIAL PRIMARY KEY, name TEXT, age INTEGER)');
    try {
      const ins = await db!.execute(
        "INSERT INTO tmp_dml (name, age) VALUES ('dave', 40) RETURNING id",
      );
      expect(ins.returning?.[0]?.id).toBeDefined();

      const upd = await db!.execute('UPDATE tmp_dml SET age = age + 1 WHERE name = $1', ['dave']);
      expect(upd.affectedRows).toBe(1);

      const del = await db!.execute('DELETE FROM tmp_dml WHERE name = $1', ['dave']);
      expect(del.affectedRows).toBe(1);

      await expect(db!.execute('UPDATE tmp_dml SET age = 0')).rejects.toMatchObject({
        code: 'DML_BLOCKED',
      });
    } finally {
      await db!.execute('DROP TABLE IF EXISTS tmp_dml');
    }
  });

  test('dml.returning=true 回读被写行', async () => {
    const ret = createClient({ ...cfg!, dml: { returning: true } });
    await ret.execute('CREATE TABLE tmp_ret (id SERIAL PRIMARY KEY, v INTEGER)');
    try {
      await ret.execute('INSERT INTO tmp_ret (v) VALUES (1), (2)');
      const upd = await ret.execute('UPDATE tmp_ret SET v = v + 10 WHERE id = 1');
      expect(upd.affectedRows).toBe(1);
      expect(upd.returning).toEqual([{ id: 1, v: 11 }]);
      const ins = await ret.execute('INSERT INTO tmp_ret (v) VALUES (5)');
      expect(ins.returning).toHaveLength(1);
    } finally {
      await ret.execute('DROP TABLE IF EXISTS tmp_ret').catch(() => undefined);
      await ret.destroy();
    }
  });

  test('元信息：表/列/行数/DDL', async () => {
    const tables = await db!.getTables();
    expect(tables).toContain('users');

    const cols = await db!.getColumns('users');
    expect(cols.find((c) => c.field_name === 'id')?.is_primary).toBe(1);
    expect(cols.find((c) => c.field_name === 'name')?.field_desc).toBe('用户姓名');

    expect(await db!.getRowsCount('users')).toBe(3);
    expect(await db!.getRowsCount('users', 'age > 21')).toBe(2);

    const ddl = await db!.getTableDDL('users');
    expect(ddl).toContain('CREATE TABLE');
  });

  test('结构 JSON 检出：字段/索引/外键/注释/DDL', async () => {
    const schema = await db!.getTableSchema('users');
    expect(schema.kind).toBe('table');
    expect(schema.comment).toBe('用户表');
    expect(schema.columns.find((c) => c.name === 'id')).toMatchObject({
      primaryKey: true,
      type: 'integer',
    });
    expect(schema.columns.find((c) => c.name === 'name')?.comment).toBe('用户姓名');
    expect(schema.indexes!.some((i) => i.name === 'idx_users_age')).toBe(true);
    expect(schema.ddl).toContain('CREATE TABLE');

    const orderSchema = await db!.getTableSchema('orders');
    const fk = orderSchema.foreignKeys!.find((f) => f.columns.includes('user_id'))!;
    expect(fk).toMatchObject({ refTable: 'users', onDelete: 'CASCADE' });
  });

  test('全库结构导出（长任务）→ JSON', async () => {
    const task = db!.getAllTableSchemas();
    const schemas = await task.promise;
    expect(task.status).toBe('done');
    expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['users', 'orders']));
    const json = await db!.exportSchemaAsJson();
    expect(JSON.parse(json).some((s: any) => s.name === 'users')).toBe(true);
  });
});

test('PostgreSQL 集成测试需要环境变量（未启动时本文件整体跳过）', () => {
  expect(true).toBe(true);
});
