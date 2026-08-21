# @fett/sql-engine

以 SQL 为统一查询语言的数据库兼容层。支持 **MySQL 5.7 / 8.x / PostgreSQL / SQLite / MongoDB**（MongoDB 为 SQL→Query 翻译），双运行时 **Node ≥ 22.5 / Bun ≥ 1.1**，内置连接池、任务队列（多线程）、结构 JSON 检出。

> 状态：**M1 框架 + M2 MySQL 已完成**（双运行时 Node ≥ 22.5 / Bun ≥ 1.1 全部测试通过）；M3（PostgreSQL/MongoDB）进行中。

## 快速开始

```ts
import { createClient } from '@fett/sql-engine';

// 唯一入参：连接配置
const db = createClient({ type: 'sqlite', database: ':memory:' });

await db.testConnection();          // { success, message }
await db.execute(
  'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER)',
);
await db.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['alice', 30]);

const result = await db.query('SELECT * FROM users WHERE age > ?', [18]);
// { rows: [...], fields: [...], total: 1, offset: 0, limit: 100 }

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

## 本地测试数据库（docker compose）

```bash
pnpm db:up      # 启动 mysql5(33061) / mysql8(33062)
pnpm db:init    # 初始化种子数据（utf8mb4 连接，避免中文注释乱码）

# 跑 MySQL 集成测试（含 5.7/8 双版本）
SQLENGINE_TEST_MYSQL5_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL5_PORT=33061 \
SQLENGINE_TEST_MYSQL5_USER=root SQLENGINE_TEST_MYSQL5_PASSWORD=root \
SQLENGINE_TEST_MYSQL8_HOST=127.0.0.1 SQLENGINE_TEST_MYSQL8_PORT=33062 \
SQLENGINE_TEST_MYSQL8_USER=root SQLENGINE_TEST_MYSQL8_PASSWORD=root \
pnpm test:mysql
```

> 国内网络下镜像拉取慢时可用镜像前缀：`MYSQL5_IMAGE=docker.m.daocloud.io/library/mysql:5.7 MYSQL8_IMAGE=docker.m.daocloud.io/library/mysql:8.0 pnpm db:up`

## 多数据源平台

```ts
import { createClientManager } from '@fett/sql-engine';

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
import { runSql, getTableSchema, exportSchemaAsJson } from '@fett/sql-engine';

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

## 文档

架构设计见 [.docs/architecture.md](.docs/architecture.md)。
