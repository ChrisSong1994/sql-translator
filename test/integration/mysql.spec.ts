/**
 * MySQL 集成测试（mysql5 / mysql8，docker compose 起库后运行）
 * 未设置 SQLENGINE_TEST_MYSQL* 环境变量时自动跳过（describe.skipIf）
 *
 * 启动：docker compose up -d --wait
 * 运行：SQLENGINE_TEST_MYSQL5_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL5_PORT=33061 \
 *       SQLENGINE_TEST_MYSQL8_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL8_PORT=33062 pnpm vitest run test/integration/mysql.spec.ts
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import type { MysqlConfig } from '../../src/types/config.js';
import type { DbClient } from '../../src/client/index.js';

function envMysqlConfig(prefix: string, version: '5' | '8' | 'auto'): MysqlConfig | null {
  const host = process.env[`SQLENGINE_TEST_${prefix}_HOST`];
  const port = process.env[`SQLENGINE_TEST_${prefix}_PORT`];
  if (!host || !port) return null;
  return {
    type: 'mysql',
    host,
    port: Number(port),
    user: process.env[`SQLENGINE_TEST_${prefix}_USER`] ?? 'root',
    password: process.env[`SQLENGINE_TEST_${prefix}_PASSWORD`] ?? 'root',
    database: process.env[`SQLENGINE_TEST_${prefix}_DATABASE`] ?? 'testdb',
    version,
  };
}

const MYSQL5 = envMysqlConfig('MYSQL5', '5');
const MYSQL8 = envMysqlConfig('MYSQL8', '8');

function buildSuite(name: string, cfg: MysqlConfig | null) {
  const describeMaybe = cfg ? describe : describe.skip;
  describeMaybe(name, () => {
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
      const r = await db!.testConnection();
      expect(r.success).toBe(true);
    });

    test('query 基础 + 参数绑定 + 分页', async () => {
      const res = await db!.query('SELECT * FROM users WHERE age > ?', [22]);
      expect(res.rows).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);

      const paged = await db!.run({ sql: 'SELECT * FROM users ORDER BY id', offset: 1, limit: 1 });
      expect(paged.rows).toHaveLength(1);
      expect(paged.rows[0]).toMatchObject({ name: 'bob' });
      expect((paged as any).total).toBe(3);
    });

    test('whereClause 包装（5.7 派生表 / 8 CTE）', async () => {
      const res = await db!.run({ sql: 'SELECT * FROM users', whereClause: 'age >= 25' });
      expect(res.rows.map((r) => r.name).sort()).toEqual(['alice', 'carol']);
    });

    test('聚合 / JOIN / 排序', async () => {
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

    test('用户 SQL 自带 LIMIT → 直接透传', async () => {
      const res = await db!.query('SELECT * FROM users LIMIT 2');
      expect(res.rows).toHaveLength(2);
    });

    test('DML：INSERT/UPDATE/DELETE + 护栏', async () => {
      const ins = await db!.execute('INSERT INTO users (name, age, email) VALUES (?, ?, ?)', [
        'dave',
        40,
        'dave@x.com',
      ]);
      expect(ins.affectedRows).toBe(1);
      expect(ins.insertId).toBeGreaterThan(0);

      const upd = await db!.execute('UPDATE users SET age = age + 1 WHERE name = ?', ['dave']);
      expect(upd.affectedRows).toBe(1);

      const del = await db!.execute('DELETE FROM users WHERE name = ?', ['dave']);
      expect(del.affectedRows).toBe(1);

      // 护栏：无 WHERE 的 UPDATE 拦截
      await expect(db!.execute('UPDATE users SET age = 0')).rejects.toMatchObject({
        code: 'DML_BLOCKED',
      });
    });

    test('DDL 透传：CREATE + DROP', async () => {
      await db!.execute('CREATE TABLE tmp_x (id INT PRIMARY KEY, v VARCHAR(20))');
      await db!.execute('INSERT INTO tmp_x VALUES (1, ?)', ['a']);
      const res = await db!.query('SELECT * FROM tmp_x');
      expect(res.rows).toEqual([{ id: 1, v: 'a' }]);
      await db!.execute('DROP TABLE tmp_x');
    });

    test('元信息：表列表 / 列 / 行数 / DDL', async () => {
      const tables = await db!.getTables();
      expect(tables).toContain('users');
      expect(tables).toContain('orders');

      const cols = await db!.getColumns('users');
      expect(cols.find((c) => c.field_name === 'name')?.field_desc).toBe('用户姓名');
      expect(cols.find((c) => c.field_name === 'id')?.is_primary).toBe(1);

      expect(await db!.getRowsCount('users')).toBe(3);
      expect(await db!.getRowsCount('users', 'age > 21')).toBe(2);

      const ddl = await db!.getTableDDL('users');
      expect(ddl).toContain('CREATE TABLE');
      expect(ddl).toContain('utf8mb4');
    });

    test('结构 JSON 检出：字段/索引/外键/引擎/DDL', async () => {
      const schema = await db!.getTableSchema('users');
      expect(schema.kind).toBe('table');
      expect(schema.comment).toBe('用户表');
      expect(schema.engine).toBe('InnoDB');
      expect(schema.charset).toContain('utf8mb4');
      const idCol = schema.columns.find((c) => c.name === 'id')!;
      // 5.7 返回 int(10) unsigned（带显示宽度），8.0 返回 int unsigned
      expect(idCol.type).toMatch(/^int/);
      expect(idCol.type).toContain('unsigned');
      expect(idCol.primaryKey).toBe(true);
      expect(idCol.autoIncrement).toBe(true);
      expect(schema.columns.find((c) => c.name === 'name')?.comment).toBe('用户姓名');
      expect(schema.indexes!.some((i) => i.name === 'idx_users_age')).toBe(true);
      expect(schema.indexes!.some((i) => i.name === 'uk_users_email' && i.unique)).toBe(true);
      expect(schema.ddl).toContain('CREATE TABLE');

      const orderSchema = await db!.getTableSchema('orders');
      const fk = orderSchema.foreignKeys!.find((f) => f.name === 'fk_orders_user')!;
      expect(fk).toMatchObject({
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
      });
    });

    test('全库结构导出（长任务）→ JSON', async () => {
      const task = db!.getAllTableSchemas();
      const schemas = await task.promise;
      expect(task.status).toBe('done');
      expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['users', 'orders']));

      const json = await db!.exportSchemaAsJson();
      const parsed = JSON.parse(json);
      expect(parsed.some((s: any) => s.name === 'users')).toBe(true);
    });
  });
}

buildSuite('MySQL 5.7（docker 33061）', MYSQL5);
buildSuite('MySQL 8.0（docker 33062）', MYSQL8);

test('MySQL 集成测试需要环境变量（未启动时本文件整体跳过）', () => {
  // 占位测试：当无环境变量时 vitest 仍需至少一个用例才能通过
  expect(true).toBe(true);
});
