/**
 * MariaDB 集成测试（docker mariadb:11，端口 33063）
 * 验证：MySQL 协议兼容 + MariaDB 能力矩阵（10.2+ CTE，分页走 CTE 包装）
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import type { MariadbConfig } from '../../src/types/config.js';
import type { DbClient } from '../../src/client/index.js';

const host = process.env.SQLENGINE_TEST_MARIADB_HOST;
const port = process.env.SQLENGINE_TEST_MARIADB_PORT;
const cfg: MariadbConfig | null =
  host && port
    ? {
        type: 'mariadb',
        host,
        port: Number(port),
        user: process.env.SQLENGINE_TEST_MARIADB_USER ?? 'root',
        password: process.env.SQLENGINE_TEST_MARIADB_PASSWORD ?? 'root',
        database: process.env.SQLENGINE_TEST_MARIADB_DATABASE ?? 'testdb',
        version: 'auto',
      }
    : null;

const describeMaria = cfg ? describe : describe.skip;

describeMaria('MariaDB 11（docker 33063，MySQL 协议兼容）', () => {
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

  test('query + 参数绑定 + 分页', async () => {
    const res = await db!.query('SELECT * FROM users WHERE age > ?', [22]);
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
    expect(res.total).toBe(2);

    const paged = await db!.run({ sql: 'SELECT * FROM users ORDER BY id', offset: 1, limit: 1 });
    expect(paged.rows[0]).toMatchObject({ name: 'bob' });
    expect((paged as any).total).toBe(3);
  });

  test('whereClause 包装走 CTE（MariaDB 10.2+ 能力矩阵）', async () => {
    const res = await db!.run({ sql: 'SELECT * FROM users', whereClause: 'age >= 25' });
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
  });

  test('聚合 / JOIN', async () => {
    const agg = await db!.query('SELECT COUNT(*) AS cnt, AVG(age) AS avg_age FROM users');
    expect(agg.rows[0]).toMatchObject({ cnt: 3 });

    const joinRes = await db!.query(
      `SELECT u.name, COUNT(o.id) AS n FROM users u
       LEFT JOIN orders o ON u.id = o.user_id
       GROUP BY u.name ORDER BY u.name`,
    );
    expect(joinRes.rows).toEqual([
      { name: 'alice', n: 2 },
      { name: 'bob', n: 0 },
      { name: 'carol', n: 1 },
    ]);
  });

  test('DML + 护栏', async () => {
    await db!.execute('CREATE TABLE tmp_md (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20))');
    try {
      const ins = await db!.execute('INSERT INTO tmp_md (v) VALUES (?)', ['x']);
      expect(ins.affectedRows).toBe(1);
      expect(ins.insertId).toBeGreaterThan(0);
      const upd = await db!.execute('UPDATE tmp_md SET v = ? WHERE id = 1', ['y']);
      expect(upd.affectedRows).toBe(1);
      await expect(db!.execute('UPDATE tmp_md SET v = \'z\'')).rejects.toMatchObject({
        code: 'DML_BLOCKED',
      });
    } finally {
      await db!.execute('DROP TABLE tmp_md');
    }
  });

  test('元信息 + 结构 JSON 检出', async () => {
    const tables = await db!.getTables();
    expect(tables).toContain('users');

    const cols = await db!.getColumns('users');
    expect(cols.find((c) => c.field_name === 'name')?.field_desc).toBe('用户姓名');

    const schema = await db!.getTableSchema('users');
    expect(schema.kind).toBe('table');
    expect(schema.comment).toBe('用户表');
    expect(schema.columns.find((c) => c.name === 'id')?.primaryKey).toBe(true);
    expect(schema.indexes!.some((i) => i.name === 'idx_users_age')).toBe(true);
    expect(schema.ddl).toContain('CREATE TABLE');

    const orderSchema = await db!.getTableSchema('orders');
    const fk = orderSchema.foreignKeys!.find((f) => f.name === 'fk_orders_user')!;
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

test('MariaDB 集成测试需要环境变量（未启动时本文件整体跳过）', () => {
  expect(true).toBe(true);
});
