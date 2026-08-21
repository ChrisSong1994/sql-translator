/**
 * 静态数据源扩展测试：JSON 数组 → SQLite 表 + SQL 表名映射执行
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createClient, importDataToSqlite, runStaticSql, dropStaticTable } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';

afterEach(async () => {
  await defaultRegistry.destroyAll();
});

const ROWS = [
  { id: 1, name: 'alice', price: 10.5, tags: ['a', 'b'], meta: { level: 1 } },
  { id: 2, name: 'bob', price: 5, tags: ['a'], meta: { level: 2 } },
  { id: 3, name: 'carol', price: 99, tags: [], meta: { level: 3 } },
];

describe('importDataToSqlite + runStaticSql', () => {
  test('导入后通过逻辑表名查询（表名映射替换）', async () => {
    const db = createClient({ type: 'sqlite', database: ':memory:' });
    // 通过独立池导入（或直接用 client 的池——这里用 getDriver 池等价）
    await importDataToSqlite(await getSqlitePool(), 'json_data_1_1', ROWS);
    const pool = await getSqlitePool();

    // 逻辑表名 → 物理表名映射执行
    const res = await runStaticSql(
      pool,
      { sql: 'SELECT * FROM 用户表 WHERE price > ?', params: [5], offset: 0, limit: 100 },
      [{ name: '用户表', datasourceName: '数据源A', sqliteTableName: 'json_data_1_1' }],
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
    // 数组/对象被 JSON 序列化存储
    expect(JSON.parse(res.rows[0].tags)).toEqual(['a', 'b']);

    // schema 限定查询
    const res2 = await runStaticSql(
      pool,
      { sql: 'SELECT * FROM "数据源A"."用户表" WHERE id = ?', params: [1], offset: 0, limit: 10 },
      [{ name: '用户表', datasourceName: '数据源A', sqliteTableName: 'json_data_1_1' }],
    );
    expect(res2.rows).toHaveLength(1);
    expect(res2.rows[0]).toMatchObject({ name: 'alice' });
  });

  test('聚合查询 + whereClause 包装', async () => {
    const pool = await getSqlitePool();
    await importDataToSqlite(pool, 't_orders', ROWS);
    // 聚合：WHERE 写在 SQL 内
    const res = await runStaticSql(
      pool,
      { sql: 'SELECT COUNT(*) AS n, SUM(price) AS total FROM t_orders WHERE price > 10' },
      [{ name: 't_orders', sqliteTableName: 't_orders' }],
    );
    expect(res.rows[0]).toMatchObject({ n: 2 });
    // whereClause：作用于查询结果再过滤（非聚合）
    const res2 = await runStaticSql(
      pool,
      { sql: 'SELECT * FROM t_orders', whereClause: 'price > 10' },
      [{ name: 't_orders', sqliteTableName: 't_orders' }],
    );
    expect(res2.rows).toHaveLength(2);
  });

  test('dropStaticTable 清理', async () => {
    const pool = await getSqlitePool();
    await importDataToSqlite(pool, 'tmp_t', ROWS);
    await dropStaticTable(pool, 'tmp_t');
    const res = await runStaticSql(
      pool,
      { sql: 'SELECT COUNT(*) AS n FROM tmp_t' },
      [{ name: 'tmp_t', sqliteTableName: 'tmp_t' }],
    ).catch((e) => e);
    expect(String(res)).toMatch(/no such table/i);
  });
});

let poolPromise: Promise<any> | null = null;
function getSqlitePool() {
  if (!poolPromise) {
    poolPromise = import('../../src/index.js').then((m) =>
      m.createStaticSqlitePool({ type: 'sqlite', database: ':memory:' }),
    );
  }
  return poolPromise;
}
