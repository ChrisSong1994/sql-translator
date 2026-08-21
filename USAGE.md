# @fett/sql-engine 使用文档

以 SQL 为统一查询语言的数据库兼容层。支持 **SQLite / MySQL 5.7 / MySQL 8 / MariaDB / PostgreSQL / MongoDB**（SQL→Query/DML 翻译），双运行时 **Node ≥ 22.5 / Bun ≥ 1.1**。

---

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [连接配置](#连接配置)
- [SQL 执行](#sql-执行)
- [selectOnly 只读模式](#selectonly-只读模式)
- [连接池与多数据源管理](#连接池与多数据源管理)
- [函数式 API](#函数式-api)
- [事务](#事务)
- [查询结果缓存](#查询结果缓存)
- [耗时返回 duration](#耗时返回-duration)
- [元信息与结构 JSON 检出](#元信息与结构-json-检出)
- [长任务（进度/取消）](#长任务进度取消)
- [任务队列（多线程）](#任务队列多线程)
- [静态数据源（JSON/CSV/Excel → SQLite）](#静态数据源jsoncsvexcel--sqlite)
- [MongoDB 特有能力](#mongodb-特有能力)
- [错误处理](#错误处理)
- [Node / Bun 双运行时](#node--bun-双运行时)
- [本地测试数据库（docker compose）](#本地测试数据库docker-compose)

---

## 安装

```bash
pnpm add @fett/sql-engine
# 或 npm install @fett/sql-engine
```

驱动依赖为 peerDependencies（可选，按需安装使用的方言）：

```bash
# 按需安装
pnpm add mysql2          # MySQL / MariaDB
pnpm add pg              # PostgreSQL
pnpm add mongodb @synatic/noql node-sql-parser   # MongoDB（SQL 翻译）
# SQLite 无需安装（Node ≥ 22.5 内置 node:sqlite；Bun 内置 bun:sqlite）
# knex 由本包内部使用（连接池），若报 peer 缺失请安装
pnpm add knex
```

**运行时要求**：Node ≥ 22.5（`node:sqlite`）或 Bun ≥ 1.1（`bun:sqlite`）。

---

## 快速开始

```ts
import { createClient } from '@fett/sql-engine';

// 唯一入参：连接配置
const db = createClient({ type: 'sqlite', database: ':memory:' });

// 连接测试（一次性连接，不入池）
const t = await db.testConnection();
// { success: true, message: 'SQLite connection test successful' }

// 写操作（DML / DDL）
await db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)');
await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['alice', 30]);

// 查询
const result = await db.query('SELECT * FROM users WHERE age > ?', [18]);
// {
//   rows: [{ id: 1, name: 'alice', age: 30 }],
//   fields: [{ field_name: 'id', field_type: 'integer', display_type: 'number', ... }],
//   total: 1, offset: 0, limit: 100,
//   duration: 2.35   // 执行耗时 ms
// }

// 结构 JSON 检出
const schema = await db.getTableSchema('users');

// 释放引用（共享池引用归零后回收）
await db.destroy();
```

---

## 连接配置

所有方言配置以 `type` 区分，公共字段：

```ts
interface BaseConfig {
  type: 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'mongodb';
  /** 运行时：'auto'（默认，自动探测）| 'node' | 'bun' */
  runtime?: 'auto' | 'node' | 'bun';
  /** DML 安全策略 */
  dml?: DmlOptions;
  /** 连接池选项 */
  pool?: PoolOptions;
  /** 任务队列选项 */
  queue?: TaskQueueOptions;
  /** 结构检出默认选项（MongoDB 采样等） */
  introspect?: SchemaOptions;
  /** 查询结果缓存 */
  cache?: QueryCacheOptions;
  /** 只读模式：仅 SELECT */
  selectOnly?: boolean;
}
```

### SQLite

```ts
createClient({
  type: 'sqlite',
  database: ':memory:',          // 内存库（测试/无状态）
  // database: '/path/to/data.db' // 文件库（持久化）
});
```

### MySQL（5.7 / 8.x）

```ts
createClient({
  type: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '...',
  database: 'test',
  version: 'auto',        // '5' | '8' | 'auto'（auto = SELECT VERSION() 探测）
  // 分页包装自动选择：MySQL 8 用 CTE，5.7 用派生表
});
```

### MariaDB（10.2+）

```ts
createClient({
  type: 'mariadb',
  host: '127.0.0.1', port: 3306, user: 'root', password: '...', database: 'test',
  version: 'auto',        // '10' | '11' | 'auto'（10.2+ 支持 CTE，分页走 CTE）
});
```

### PostgreSQL

```ts
createClient({
  type: 'postgresql',
  host: '127.0.0.1', port: 5432, user: 'postgres', password: '...', database: 'test',
  schema: 'public',       // 默认 public
});
```

### MongoDB

```ts
createClient({
  type: 'mongodb',
  uri: 'mongodb://127.0.0.1:27017',   // 优先；未提供则由 host/port/database 拼装
  database: 'test',
  // host/port/user/password/authSource 也可单独提供
  // retryWrites: false,   // 单实例默认 false（事务需副本集）
});
```

### DML 安全策略（dml）

```ts
createClient({
  type: 'mysql', /* ... */,
  dml: {
    requireWhereForUpdateDelete: true,  // 禁止无 WHERE 的 UPDATE/DELETE（默认 true）
    maxInsertRows: 10000,               // 单次 INSERT 行数上限（0 = 不限制）
    returning: false,                   // 回读被写行（PG/SQLite RETURNING；MySQL 仅 INSERT 回读）
  },
});
```

### SSL

```ts
createClient({
  type: 'postgresql', /* ... */,
  ssl: { enabled: true, ca: '...', cert: '...', key: '...', rejectUnauthorized: false },
});
```

---

## SQL 执行

| 方法 | 用途 | 返回 |
|---|---|---|
| `db.query(sql, params?)` | SELECT 查询 | `QueryResult`（断言 SELECT，写操作会报错） |
| `db.execute(sql, params?)` | 写操作（INSERT/UPDATE/DELETE/DDL） | `WriteResult` |
| `db.run({ sql, params, offset, limit, whereClause, dml })` | 完整执行入口（自动识别语句类型） | `QueryResult \| WriteResult` |
| `db.ping()` | 池内探活（失败自动重建池） | `void` |
| `db.testConnection()` | 一次性连接测试（不入池） | `{ success, message }` |

### 参数绑定

占位符按方言：MySQL/SQLite 用 `?`，PostgreSQL 用 `$1/$2...`（本包自动转换）。

```ts
await db.query('SELECT * FROM users WHERE age > ? AND name = ?', [18, 'alice']); // mysql/sqlite
await db.query('SELECT * FROM users WHERE age > $1 AND name = $2', [18, 'alice']); // pg
```

### 分页

用户 SQL **自带 LIMIT/OFFSET 时直接透传**（total = rows.length 近似）；否则按请求级 offset/limit 自动包装（count + 分页）：

```ts
const result = await db.run({
  sql: 'SELECT * FROM users',
  offset: 20,    // 页码偏移
  limit: 10,     // 每页数量
  whereClause: 'age > 18',   // 额外过滤：包装为 WITH __t AS (...) SELECT * FROM __t WHERE ...
});
```

### 返回类型

```ts
interface QueryResult {
  rows: any[];
  fields?: Field[];
  total?: number;      // 总数（用户 SQL 自带 LIMIT 时为近似值）
  offset?: number;
  limit?: number;
  duration?: number;   // 执行耗时 ms
}

interface WriteResult {
  affectedRows: number;
  insertId?: number | string;   // 自增主键 / Mongo _id
  returning?: any[];            // PG/SQLite RETURNING 回读行
  duration?: number;
}
```

---

## selectOnly 只读模式

```ts
const db = createClient({ type: 'sqlite', database: ':memory:', selectOnly: true });

await db.query('SELECT * FROM t');           // ✅ 正常
await db.execute('UPDATE t SET v = 1');      // ❌ 抛 SqlEngineError(READ_ONLY)
await db.execute('DELETE FROM t');           // ❌ READ_ONLY
await db.execute('CREATE TABLE t (id INT)'); // ❌ READ_ONLY
await db.withTransaction(async (tx) => {});  // ❌ READ_ONLY
```

只读模式下仅允许 SELECT；DML / DDL / 事务一律拒绝（错误码 `READ_ONLY`）。

---

## 连接池与多数据源管理

### 核心原则

- **连接池按 config 指纹全局共享**（进程内模块级注册表），同一个 config 多次 `createClient` 共享同一池
- `createClient` 是**零成本轻量操作**：不建连接，首次真实调用才懒建池
- **不要每请求 createClient + destroy**（等于每请求建连/断连）；用 `ClientManager` 缓存

### 单数据源（简单服务）

```ts
// 模块级创建一次，全局复用
export const db = createClient({ type: 'postgresql', /* ... */ });
```

### 多数据源平台（WizBuild 类场景）

```ts
import { createClientManager } from '@fett/sql-engine';

const manager = createClientManager({
  defaultPool: { max: 20, min: 0, idleTimeoutMs: 30000 },  // 每数据源池参数
  maxClients: 200,      // 全局 client 数上限（防泄漏）
  lru: { maxIdlePools: 50 },  // 空闲池 LRU 淘汰
});

// 请求处理：命中共享池，零成本
async function handleSql(dsConfig, sql, params) {
  const db = manager.getClient(dsConfig);   // 首次懒建池，之后微秒级命中
  return db.query(sql, params);
}

// 数据源生命周期
await manager.register('ds-1', dsConfig);   // 注册业务 ID + 预热建池
manager.getClientById('ds-1');              // 按 ID 取 client
await manager.invalidate('ds-1');           // 配置更新：销毁旧池
await manager.release('ds-1');              // 数据源删除：释放引用
await manager.destroyAll();                 // 应用退出（SIGTERM hook）

// 运维指标
manager.metrics();
// { clients, pools, active, idle, waiting, createdTotal, destroyedTotal }
```

### 连接池参数（pool）

```ts
pool: {
  max: 20,               // 池上限
  min: 0,                // 常驻连接
  acquireTimeoutMs: 20000,  // 获取连接超时
  createTimeoutMs: 15000,   // 建连超时
  idleTimeoutMs: 30000,     // 空闲回收
  connectTimeoutMs: 10000,  // 连接超时
  keepAlive: true,
}
```

每条连接建立后自动设置慢查询兜底：MySQL `max_execution_time=30s`、PG `statement_timeout=30s`、MariaDB `max_statement_time=30s`。

---

## 函数式 API

与 WizBuild 现有 `runSql(configuration, {...})` 调用方式同构，内部走同一全局池注册表：

```ts
import { runSql, testConnection, getTableList, getTableSchema, exportSchemaAsJson } from '@fett/sql-engine';

const result = await runSql(dsConfig, { sql, offset: 0, limit: 10 });
const schema = await exportSchemaAsJson(dsConfig);
```

完整函数式 API：`testConnection` / `runSql` / `getTableList` / `getTableDDL` / `getColumns` / `getRowsCount` / `getPreviewRows` / `getTableSchema` / `getAllTableSchemas` / `exportSchemaAsJson`。

---

## 事务

```ts
await db.withTransaction(async (tx) => {
  await tx.execute('UPDATE accounts SET balance = balance - 100 WHERE id = 1');
  await tx.execute('UPDATE accounts SET balance = balance + 100 WHERE id = 2');
  // fn 抛错 → 自动回滚；正常返回 → 自动提交
  // 也可手动控制：await tx.commit() / await tx.rollback()
});
```

- `tx` 提供 `runSql` / `query` / `execute` / `commit` / `rollback`
- **SQLite / PostgreSQL / MySQL / MariaDB**：真事务（单连接独占）
- **MongoDB**：`session.withTransaction`，**需要副本集**（单实例不支持）。本地测试可用 docker 单节点副本集（见[本地测试数据库](#本地测试数据库docker-compose)）
- `selectOnly: true` 时事务被拒绝

---

## 查询结果缓存

```ts
const db = createClient({
  type: 'sqlite', database: ':memory:',
  cache: { enabled: true, ttlMs: 60000, maxEntries: 1000 },
});
```

- **仅缓存幂等 SELECT**；DML/DDL 写操作后自动整库失效
- 缓存 key = 连接指纹 + SQL + 参数 + 分页 + whereClause（参数不同不命中）
- TTL 过期 + LRU 容量淘汰
- 返回 `structuredClone` 隔离，外部修改不污染缓存

---

## 耗时返回 duration

所有执行路径统一返回执行耗时（ms，2 位小数）：

```ts
const result = await db.query('SELECT * FROM users');
result.duration;                       // 3.42
await db.execute('INSERT INTO ...');   // WriteResult.duration 同样存在
runSql(cfg, { sql });                  // 函数式 API 也携带 duration
```

缓存命中也返回 duration（缓存读取耗时）。

---

## 元信息与结构 JSON 检出

```ts
await db.getTables();                    // string[] 表列表
await db.getColumns('users');            // Field[] 字段（类型/注释/主键）
await db.getRowsCount('users', 'age > 18');  // 行数
await db.getPreviewRows('users', 0, 10);     // 预览数据（分页）
await db.getTableDDL('users');               // DDL 字符串（mysql SHOW CREATE / pg 构造 / sqlite sqlite_master）

// 结构 JSON 检出（DDL 的结构化等价物）
const schema = await db.getTableSchema('users');
// {
//   name: 'users', schema: 'testdb', kind: 'table', comment: '用户表',
//   columns: [{ name, type, nullable, default, comment, primaryKey, autoIncrement, ordinal }],
//   indexes: [{ name, unique, columns, type }],
//   foreignKeys: [{ name, columns, refTable, refColumns, onDelete, onUpdate }],
//   engine: 'InnoDB', charset: 'utf8mb4', ddl: 'CREATE TABLE ...'
// }

// 全库导出
const json = await db.exportSchemaAsJson();   // 全库结构 → JSON 字符串
```

MongoDB 的结构检出通过**文档采样**推断（嵌套对象/数组/ObjectId 识别），返回 `kind: 'collection'`，嵌套结构在 `raw.properties` 中递归保留。

---

## 长任务（进度/取消）

耗时操作（MongoDB 采样、全库批量导出）返回 `IntrospectTask`：

```ts
const task = db.getAllTableSchemas({
  sampleSize: 100,       // Mongo 采样条数（0 = 快速模式仅集合名/索引）
  maxDepth: 3,           // 嵌套深度上限
  onProgress: (p) => render(p),  // 进度回调
});

task.onProgress((p) => console.log(p));
// { stage: 'sampling' | 'introspecting', processed, total, message }

const schemas = await task.promise;   // 等待完成
await task.cancel();                  // 取消 → promise reject TASK_CANCELLED
task.status;  // 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
```

---

## 任务队列（多线程）

```ts
const db = createClient({ type: 'sqlite', database: ':memory:' });

// 进程内异步并发（I/O 密集任务默认方式）
await db.tasks.enqueue(() => fetch('https://api.example.com'));

// CPU 密集任务 offload 到 worker 线程（Node worker_threads / Bun Worker）
// 任务必须可序列化：模块 + 导出函数 + 参数
await db.tasks.enqueue(
  { module: '/abs/path/to/compute.mjs', fn: 'heavyCompute', args: [1_000_000] },
  { worker: true },
);

// 并发/优先级/超时/取消
await db.tasks.enqueue(fn, { priority: 10, timeoutMs: 5000, signal: abortController.signal });
await db.tasks.waitIdle();
await db.tasks.close();
```

**注意**：worker 任务函数不能是闭包（无法跨线程序列化），必须是可 import 模块的导出函数；worker 内任务自建连接（连接不跨线程共享）。

---

## 静态数据源（JSON/CSV/Excel → SQLite）

从 JSON 数组建 SQLite 表，并支持用户 SQL 用**逻辑表名**（自动映射为物理表名）：

```ts
import { createStaticSqlitePool, importDataToSqlite, runStaticSql } from '@fett/sql-engine';

const pool = await createStaticSqlitePool({ type: 'sqlite', database: ':memory:' });

// 导入（表已存在则先删后建；数组/对象字段自动 JSON 序列化）
await importDataToSqlite(pool, 'json_data_1_1', [
  { id: 1, name: 'alice', price: 10.5, tags: ['a'], meta: { level: 1 } },
  { id: 2, name: 'bob', price: 5, tags: [], meta: { level: 2 } },
]);

// 用户 SQL 用逻辑表名，自动替换为 SQLite 物理表名
const res = await runStaticSql(
  pool,
  { sql: 'SELECT * FROM 用户表 WHERE price > ?', params: [5], offset: 0, limit: 100 },
  [
    { name: '用户表', datasourceName: '数据源A', sqliteTableName: 'json_data_1_1' },
    // 支持 "数据源A"."用户表" 的 schema 限定引用
  ],
);

await dropStaticTable(pool, 'json_data_1_1');
await pool.destroy();   // 或用 destroyStaticSqlitePool(pool)
```

---

## MongoDB 特有能力

MongoDB 以 SQL 为查询语言，全部走 `db.query` / `db.execute`：

```ts
const db = createClient({ type: 'mongodb', uri: 'mongodb://127.0.0.1:27017', database: 'test' });

// SQL → find / aggregate（@synatic/noql）
await db.query("SELECT * FROM users WHERE age > 20 AND name LIKE 'a%'");
await db.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');

// SQL → insert/update/delete（node-sql-parser + noql WHERE 翻译）
await db.execute("INSERT INTO users (name, age) VALUES ('dave', 40)");
await db.execute("UPDATE users SET age = age + 1 WHERE name = 'dave'");  // SET 自增 → $inc
await db.execute("DELETE FROM users WHERE name = 'dave'");

// 结构检出（采样长任务，支持进度/取消）
const schema = await db.getTableSchema('users');
```

**能力边界**：
- 仅单集合操作（JOIN 类 SQL 不支持）
- WHERE 支持 `=, >, <, LIKE, IN, BETWEEN, AND/OR, IS NULL`
- UPDATE SET 支持普通赋值（`$set`）与算术自增（`$inc`）；函数表达式报 `DML_UNSUPPORTED_EXPRESSION`
- 无 WHERE 的 UPDATE/DELETE 默认拦截（`DML_BLOCKED`）

---

## EXPLAIN 执行计划

```ts
const plan = await db.explain('SELECT * FROM users WHERE age > 20');
// {
//   dialect: 'sqlite',
//   sql: 'SELECT * FROM users WHERE age > 20',
//   plan: [ { id: 2, parent: 0, notused: 0, detail: 'SEARCH users USING INDEX idx_users_age (age>?)' } ],
//   duration: 0.5,
// }
```
- **SQLite**：`EXPLAIN QUERY PLAN`（含索引使用）
- **MySQL / MariaDB**：`EXPLAIN`（type/key/rows 等计划行）
- **PostgreSQL**：`EXPLAIN`（QUERY PLAN 文本）
- **MongoDB**：noql 翻译后 `find/aggregate.explain('executionStats')`（含执行统计）
- 函数式 API：`explain(config, sql, params)`

## 慢查询日志

```ts
const db = createClient({
  type: 'mysql', /* ... */,
  logging: {
    slowQueryMs: 1000,                    // 超过 1s 的查询记录日志（0 = 记录所有）
    logFn: (entry) => myLogger(entry),    // 自定义（默认 console.warn）
  },
});
// 触发时 entry:
// { type: 'slow-query', dialect, sql, params, durationMs, fingerprint, at }
```
- 所有执行路径（client.run / query / execute / 函数式 runSql）统一检测
- 未配置 `slowQueryMs` 时不记录（零开销）

## API 类型文档

```bash
pnpm docs:api      # 生成到 docs/api/（typedoc）
pnpm docs:dev      # 监听模式
```
生成 HTML 类型文档（classes / interfaces / functions / types / variables 分类），入口 `docs/api/index.html`。

### 部署到 GitHub Pages

`pnpm docs:api` 的产物（含 `.nojekyll`）由 `.github/workflows/pages.yml` 自动部署：

- **触发**：push 到 `main`、推送 `v*` tag（发布）、手动 `workflow_dispatch`
- **流程**：`pnpm install` → `pnpm build` → `pnpm docs:api` → `upload-pages-artifact` → `deploy-pages`
- **前置配置**（一次）：仓库 Settings → **Pages** → Source 选择 **"GitHub Actions"**
- **访问地址**：`https://<user>.github.io/<repo>/`
- 部署失败排查：Actions → docs-deploy workflow 日志；确认 Settings → Pages 已选 GitHub Actions 源

## 错误处理

所有错误统一为 `SqlEngineError`（`err.code` 分类，保留原始 message）：

| 错误码 | 触发场景 |
|---|---|
| `UNSUPPORTED_DIALECT` | 方言驱动未注册/未知 |
| `CONNECTION_FAILED` | 连接失败 / client 已销毁 |
| `QUERY_FAILED` | SQL 语法错误 / 执行失败 |
| `TABLE_NOT_FOUND` | 表/集合不存在 |
| `DML_BLOCKED` | 无 WHERE 的 UPDATE/DELETE、INSERT 超行数上限 |
| `DML_UNSUPPORTED_EXPRESSION` | Mongo SET 表达式不支持 |
| `READ_ONLY` | selectOnly 模式下写操作 |
| `TASK_CANCELLED` | 长任务取消 |
| `CLIENT_LIMIT_EXCEEDED` | 全局 client 数超上限 |
| `TASK_QUEUE_CLOSED` | 队列已关闭后 enqueue |
| `WORKER_UNAVAILABLE` | worker 不可用/闭包任务 |

```ts
import { SqlEngineError, isSqlEngineError } from '@fett/sql-engine';
try {
  await db.execute('DELETE FROM users');   // 无 WHERE
} catch (err) {
  if (isSqlEngineError(err) && err.code === 'DML_BLOCKED') {
    console.log('危险操作被拦截');
  }
}
```

---

## Node / Bun 双运行时

同一份代码在 Node 与 Bun 下行为一致（`runtime.ts` 自动探测）：

```ts
createClient({ type: 'sqlite', database: ':memory:' });  // Node → node:sqlite；Bun → bun:sqlite
createClient({ type: 'sqlite', database: ':memory:', runtime: 'node' });  // 强制指定（测试用）
```

- worker 多线程：Node `worker_threads` / Bun `Worker` 自动适配
- 运行 bun：`bun test`（已内置 `test:bun` 脚本，`--timeout 30000`）

---

## 本地测试数据库（docker compose）

```bash
# 启动全部测试数据库（mysql5:33061 / mysql8:33062 / mariadb:33063 / postgres:54321 / mongodb:27017 / mongo-rs:27018）
pnpm db:up

# 初始化种子数据（MySQL/MariaDB 走 utf8mb4 脚本防中文乱码；Mongo 注入）
pnpm db:init

# 初始化 Mongo 单节点副本集（事务测试用）
node scripts/init-mongo-rs.mjs

# 跑全部测试（需设置环境变量）
SQLENGINE_TEST_MYSQL5_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL5_PORT=33061 \
SQLENGINE_TEST_MYSQL5_USER=root SQLENGINE_TEST_MYSQL5_PASSWORD=root \
SQLENGINE_TEST_MYSQL8_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL8_PORT=33062 \
SQLENGINE_TEST_MYSQL8_USER=root SQLENGINE_TEST_MYSQL8_PASSWORD=root \
SQLENGINE_TEST_MARIADB_HOST=127.0.0.1 SQLENGINE_TEST_MARIADB_PORT=33063 \
SQLENGINE_TEST_MARIADB_USER=root SQLENGINE_TEST_MARIADB_PASSWORD=root \
SQLENGINE_TEST_PG_HOST=127.0.0.1 SQLENGINE_TEST_PG_PORT=54321 \
SQLENGINE_TEST_MONGO_URI=mongodb://127.0.0.1:27017 \
SQLENGINE_TEST_MONGO_RS_URI=mongodb://127.0.0.1:27018 \
pnpm test
```

> 国内网络镜像慢时用镜像前缀：`MYSQL5_IMAGE=docker.m.daocloud.io/library/mysql:5.7 ... pnpm db:up`

---

## 类型参考

核心导出（`import * as sqlEngine from '@fett/sql-engine'`）：

```
createClient, createClientManager, DbClient, ClientManager, SqlEngine,
runSql, testConnection, getTableList, getTableDDL, getColumns, getRowsCount,
getPreviewRows, getTableSchema, getAllTableSchemas, exportSchemaAsJson,
createStaticSqlitePool, importDataToSqlite, dropStaticTable, runStaticSql,
createTask, wrapTask, TaskQueueImpl, TtlCache, queryCacheKey, roundDuration,
SqlEngineError, isSqlEngineError, registerDriver, getDriver,
types（ConnectionConfig / QueryResult / WriteResult / Field / TableSchema /
      IntrospectTask / TransactionHandle / TestResult / ExecResult ...）
```

架构设计见 [.docs/architecture.md](.docs/architecture.md)。
