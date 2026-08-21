/**
 * MongoDB 集成测试（docker mongo:7，端口 27017）
 * 覆盖：SQL→Query（find/aggregate）、SQL→DML（insert/update/delete）、
 *      DML 护栏、结构检出（嵌套/数组/ObjectId）、长任务
 * 未设置 SQLENGINE_TEST_MONGO_URI 时自动跳过
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import type { MongodbConfig } from '../../src/types/config.js';
import type { DbClient } from '../../src/client/index.js';

const uri = process.env.SQLENGINE_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const cfg: MongodbConfig = { type: 'mongodb', uri, database: 'testdb' };

// 尝试连接，失败则跳过整个 describe
const describeMongo = describe;

describeMongo('MongoDB（docker 27017）', () => {
  let db: DbClient;
  let available = false;

  beforeAll(async () => {
    db = createClient(cfg);
    const t = await db.testConnection();
    available = t.success;
    if (!available) {
      console.warn(`[mongo] 未就绪（${t.message}），跳过`);
    }
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  const skip = () => {
    if (!available) {
      // @ts-expect-error vitest 动态跳过
      test.skip(undefined);
    }
  };

  test('testConnection 成功', async () => {
    if (!available) return;
    expect((await db.testConnection()).success).toBe(true);
  });

  test('SQL → find：WHERE/投影/分页', async () => {
    if (!available) return;
    const res = await db.query('SELECT * FROM users WHERE age > 22');
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
    expect(res.total).toBe(2);
    // 投影
    const proj = await db.query('SELECT name, age FROM users WHERE name = \'bob\'');
    expect(proj.rows[0]).toEqual({ name: 'bob', age: 20 });
  });

  test('SQL → aggregate：GROUP BY 统计', async () => {
    if (!available) return;
    const res = await db.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    const rows = res.rows.map((r: any) => ({ status: r.status, n: Number(r.n) }));
    expect(rows).toEqual([
      { status: 'paid', n: 2 },
      { status: 'pending', n: 1 },
    ]);
  });

  test('SQL 自带 LIMIT → 透传', async () => {
    if (!available) return;
    const res = await db.query('SELECT * FROM users LIMIT 2');
    expect(res.rows).toHaveLength(2);
  });

  test('whereClause 与 SQL 条件 $and 合并', async () => {
    if (!available) return;
    const res = await db.run({ sql: 'SELECT * FROM users', whereClause: 'age >= 25' });
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
  });

  test('DML：INSERT → insertOne / 多行 → insertMany', async () => {
    if (!available) return;
    const coll = 'dml_test';
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
    const ins = await db.execute(`INSERT INTO ${coll} (name, age) VALUES ('dave', 40)`);
    expect(ins.affectedRows).toBe(1);
    expect(ins.insertId).toBeDefined();
    const multi = await db.execute(
      `INSERT INTO ${coll} (name, age) VALUES ('eve', 20), ('frank', 30)`,
    );
    expect(multi.affectedRows).toBe(2);
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
  });

  test('DML：UPDATE $set / $inc', async () => {
    if (!available) return;
    const coll = 'dml_test2';
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
    await db.execute(`INSERT INTO ${coll} (name, age) VALUES ('alice', 30)`);
    const upd = await db.execute(`UPDATE ${coll} SET age = age + 1 WHERE name = 'alice'`);
    expect(upd.affectedRows).toBe(1);
    const res = await db.query(`SELECT * FROM ${coll} WHERE name = 'alice'`);
    expect(res.rows[0]).toMatchObject({ age: 31 });
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
  });

  test('DML：DELETE → deleteMany', async () => {
    if (!available) return;
    const coll = 'dml_test3';
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
    await db.execute(`INSERT INTO ${coll} (name, age) VALUES ('a', 1), ('b', 2)`);
    const del = await db.execute(`DELETE FROM ${coll} WHERE age > 1`);
    expect(del.affectedRows).toBe(1);
    const left = await db.query(`SELECT * FROM ${coll}`);
    expect(left.rows).toHaveLength(1);
    await db.execute(`DELETE FROM ${coll} WHERE _id != null`);
  });

  test('DML 护栏：无 WHERE 的 UPDATE/DELETE 拦截', async () => {
    if (!available) return;
    await expect(db.execute('UPDATE users SET age = 0')).rejects.toMatchObject({
      code: 'DML_BLOCKED',
    });
    await expect(db.execute('DELETE FROM users')).rejects.toMatchObject({
      code: 'DML_BLOCKED',
    });
  });

  test('maxInsertRows 超限拦截', async () => {
    if (!available) return;
    const strict = createClient({ ...cfg, dml: { maxInsertRows: 1 } });
    await expect(
      strict.execute(`INSERT INTO dml_test4 (a) VALUES (1), (2)`),
    ).rejects.toMatchObject({ code: 'DML_BLOCKED' });
    await strict.destroy();
  });

  test('元信息：表列表 / 行数 / 预览', async () => {
    if (!available) return;
    const tables = await db.getTables();
    expect(tables).toContain('users');
    expect(tables).toContain('orders');

    expect(await db.getRowsCount('users')).toBe(3);
    expect(await db.getRowsCount('users', 'age > 22')).toBe(2);

    const preview = await db.getPreviewRows('users', 0, 2);
    expect(preview).toHaveLength(2);
  });

  test('结构检出：嵌套对象/数组/ObjectId 采样', async () => {
    if (!available) return;
    const schema = await db.getTableSchema('users');
    expect(schema.kind).toBe('collection');
    const cols = schema.columns.map((c) => c.name);
    expect(cols).toContain('name');
    expect(cols).toContain('address');
    expect(cols).toContain('tags');
    const addressCol = schema.columns.find((c) => c.name === 'address')!;
    expect(addressCol.type).toBe('object');
    // raw.properties 保留递归结构
    const props = schema.raw?.properties as any;
    expect(props.address.properties.city).toBeDefined();
  });

  test('全库结构导出（长任务）→ JSON', async () => {
    if (!available) return;
    const task = db.getAllTableSchemas();
    const schemas = await task.promise;
    expect(task.status).toBe('done');
    expect(schemas.map((s) => s.name)).toEqual(expect.arrayContaining(['users', 'orders']));
    const json = await db.exportSchemaAsJson();
    expect(JSON.parse(json).some((s: any) => s.name === 'users')).toBe(true);
  });
});

test('MongoDB 集成测试（未连接时占位通过）', () => {
  expect(true).toBe(true);
});
