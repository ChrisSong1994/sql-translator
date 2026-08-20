# @fett/sql-engine

以 SQL 为统一查询语言的数据库兼容层。支持 **MySQL 5.7 / 8.x / PostgreSQL / SQLite / MongoDB**（MongoDB 为 SQL→Query 翻译），双运行时 **Node ≥ 22.5 / Bun ≥ 1.1**，内置连接池、任务队列（多线程）、结构 JSON 检出。

> 状态：M1 已落地（框架 + core + Client API + ClientManager + 任务队列 + SQLite 垂直切片）；mysql/pg/mongo 驱动在 M2/M3 提供。

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
