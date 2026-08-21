# @fett/sql-translator

以 SQL 为统一查询语言的数据库兼容层。支持 **MySQL 5.7 / 8.x / PostgreSQL / SQLite / MongoDB**（MongoDB 为 SQL→Query 翻译），双运行时 **Node ≥ 22.5 / Bun ≥ 1.1**，内置连接池、任务队列（多线程）、结构 JSON 检出。

> 状态：**全部完成**（双运行时 Node ≥ 22.5 / Bun ≥ 1.1 全部 202 用例通过）：SQLite / MySQL 5.7/8 / **MariaDB** / PostgreSQL / MongoDB（含**副本集事务**）驱动 + 连接池 + 任务队列（多线程）+ 事务 + **查询结果缓存** + **selectOnly 只读模式** + **耗时返回** + 结构 JSON 检出 + 静态数据源 + CI。

## 快速开始

```ts
import { createClient } from '@fett/sql-translator';

// 唯一入参：连接配置
const db = createClient({ type: 'sqlite', database: ':memory:' });

await db.testConnection();          // { success, message }
await db.execute(
  'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)',
);
await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['alice', 30]);

const result = await db.query('SELECT * FROM users WHERE age > ?', [18]);
// { rows: [...], fields: [...], total: 1, offset: 0, limit: 100, duration: 3.42 }
// duration：执行耗时（ms），client.run / query / execute / 函数式 runSql 均返回

const schema = await db.getTableSchema('users');  // 结构 JSON
const json = await db.exportSchemaAsJson();       // 全库结构 → JSON 字符串

await db.destroy();  // 释放引用（共享池引用归零后回收）
```

## MySQL（5.7 / 8.x 双版本）

```ts
const db = createClient({
  type: 'mysql',
  host: '127.0.0.1', port: 3306,
  user: 'root', password: '...', database: 'test',
  version: 'auto',          // '5' | '8' | 'auto'（auto = SELECT VERSION() 探测）
  dml: { requireWhereForUpdateDelete: true },
});

await db.query('SELECT * FROM users WHERE age > ?', [18]);   // 自动分页包装
await db.execute('UPDATE users SET age = ? WHERE id = ?', [31, 1]);
const schema = await db.getTableSchema('users');             // 结构 JSON
```

- 分页包装按版本能力矩阵自动选择：MySQL 8 用 CTE，5.7 用派生表
- 无 WHERE 的 UPDATE/DELETE 默认拦截（DML_BLOCKED）

## MongoDB（SQL → Query / DML 翻译）

```ts
const db = createClient({ type: 'mongodb', uri: 'mongodb://127.0.0.1:27017', database: 'test' });

// SQL → find / aggregate（@synatic/noql）
const res = await db.query('SELECT * FROM users WHERE age > ?', [18]);
await db.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');

// SQL → insert/update/delete（node-sql-parser + noql WHERE 翻译）
await db.execute("INSERT INTO users (name, age) VALUES ('dave', 40)");
await db.execute("UPDATE users SET age = age + 1 WHERE name = 'dave'");
await db.execute("DELETE FROM users WHERE name = 'dave'");

// 结构检出：采样（嵌套对象/数组/ObjectId），长任务可取消
const schema = await db.getTableSchema('users');
```

- WHERE 条件翻译与 SELECT 路径一致（=, >, <, LIKE, IN, BETWEEN, AND/OR, IS NULL）
- SET 支持 `$set` 与算术自增 `$inc`；无 WHERE 的 UPDATE/DELETE 默认拦截
- 结构检出为长任务（分批采样 + 进度 + 取消 + TTL 缓存）

## 本地测试数据库（docker compose）

```bash
pnpm db:up      # 启动 mysql5(33061) / mysql8(33062) / postgres(54321) / mongodb(27017)
pnpm db:init    # 初始化种子数据（MySQL 走 utf8mb4 脚本，Mongo 注入）

# 跑全部集成测试（含 4 种数据库）
SQLENGINE_TEST_MYSQL5_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL5_PORT=33061 \
SQLENGINE_TEST_MYSQL5_USER=root SQLENGINE_TEST_MYSQL5_PASSWORD=root \
SQLENGINE_TEST_MYSQL8_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL8_PORT=33062 \
SQLENGINE_TEST_MYSQL8_USER=root SQLENGINE_TEST_MYSQL8_PASSWORD=root \
SQLENGINE_TEST_PG_HOST=127.0.0.1 SQLENGINE_TEST_PG_PORT=54321 \
SQLENGINE_TEST_MONGO_URI=mongodb://127.0.0.1:27017 \
pnpm test
```

> 国内网络镜像慢时：`MYSQL5_IMAGE=docker.m.daocloud.io/library/mysql:5.7 MYSQL8_IMAGE=docker.m.daocloud.io/library/mysql:8.0 MONGO_IMAGE=docker.m.daocloud.io/library/mongo:7 pnpm db:up`
> 说明：bson@7.3.2 已打补丁（Bun 下 node:v8 兼容），见 `patches/` + package.json `pnpm.patchedDependencies`

## 多数据源平台

```ts
import { createClientManager } from '@fett/sql-translator';

const manager = createClientManager({ maxClients: 200, lru: { maxIdlePools: 50 } });

async function handleSql(dsConfig, sql, params) {
  const db = manager.getClient(dsConfig);   // 命中共享池，零成本
  return db.query(sql, params);
}

await manager.invalidate(dsId);   // 数据源配置更新：销毁旧池
await manager.release(dsId);      // 数据源删除：释放引用
await manager.destroyAll();       // 应用退出
```

## 函数式 API

```ts
import { runSql, getTableSchema, exportSchemaAsJson } from '@fett/sql-translator';

const result = await runSql(dsConfig, { sql, offset: 0, limit: 10 });
const schema = await exportSchemaAsJson(dsConfig);
```

## 任务队列（多线程）

```ts
const db = createClient(config);

// 进程内异步并发（I/O 密集）
await db.tasks.enqueue(() => fetch('...'));

// CPU 密集任务 offload 到 worker 线程（需可序列化规格）
await db.tasks.enqueue({ module: '/abs/path/to/fn.mjs', fn: 'heavyCompute', args: [1e7] }, { worker: true });

// 长任务：进度 + 取消
const task = db.getAllTableSchemas({ onProgress: (p) => console.log(p) });
await task.promise;
```

## 事务

```ts
await db.withTransaction(async (tx) => {
  await tx.execute('UPDATE accounts SET balance = balance - 100 WHERE id = 1');
  await tx.execute('UPDATE accounts SET balance = balance + 100 WHERE id = 2');
  // fn 抛错自动回滚；也可手动 tx.commit() / tx.rollback()
});
```
SQLite/PG/MySQL/MariaDB 真事务；MongoDB 走 session（**需副本集**——docker compose 提供单节点副本集 `mongo-rs`(27018)，`node scripts/init-mongo-rs.mjs` 初始化）。

## 查询结果缓存

```ts
const db = createClient({ type: 'sqlite', database: ':memory:', cache: { enabled: true, ttlMs: 60000, maxEntries: 1000 } });
// 幂等 SELECT 结果缓存（TTL + LRU）；DML/DDL 后自动失效
```
仅缓存 SELECT；写操作后本 client 缓存整库失效。

## selectOnly 只读模式

```ts
const db = createClient({ type: 'sqlite', database: ':memory:', selectOnly: true });
await db.query('SELECT * FROM t');          // ✅
await db.execute('UPDATE t SET v = 1');     // ❌ READ_ONLY
await db.withTransaction(async (tx) => {}); // ❌ READ_ONLY
```
只读模式下仅允许 SELECT，DML/DDL/事务一律拒绝（错误码 `READ_ONLY`）。

## MariaDB

```ts
const db = createClient({ type: 'mariadb', host, port: 3306, user, password, database, version: 'auto' });
// MySQL 协议兼容；能力矩阵独立（10.2+ CTE → 分页走 CTE 包装；慢查询兜底用 max_statement_time）
```

## 静态数据源（JSON/CSV/Excel → SQLite）

```ts
import { createStaticSqlitePool, importDataToSqlite, runStaticSql } from '@fett/sql-engine';

const pool = await createStaticSqlitePool({ type: 'sqlite', database: ':memory:' });
await importDataToSqlite(pool, 'json_data_1_1', [{ id: 1, name: 'alice' }]);

// 用户 SQL 用逻辑表名，自动映射为 SQLite 物理表名
const res = await runStaticSql(
  pool,
  { sql: 'SELECT * FROM 用户表 WHERE price > ?', params: [5] },
  [{ name: '用户表', datasourceName: '数据源A', sqliteTableName: 'json_data_1_1' }],
);
```

## CI

GitHub Actions（.github/workflows/test.yml）：Node + Bun 双运行时，docker 起 4 种数据库跑全量集成测试。

## 文档

架构设计见 [.docs/architecture.md](.docs/architecture.md)。
