/**
 * MongoDB 副本集事务集成测试（docker mongo-rs:27018，单节点副本集）
 * 验证 withTransaction 真实多文档事务（成功提交 / 异常回滚）
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';

const rawUri = process.env.SQLENGINE_TEST_MONGO_RS_URI;
// directConnection 绕过 topology discovery（宿主无法解析容器名 mongo-rs:27017）
const uri = rawUri
  ? rawUri + (rawUri.includes('directConnection') ? '' : (rawUri.includes('?') ? '&' : '?') + 'directConnection=true')
  : 'mongodb://127.0.0.1:27018/?directConnection=true';
const cfg = { type: 'mongodb' as const, uri, database: 'testdb_rs' };

// 未设置 SQLENGINE_TEST_MONGO_RS_URI 时跳过（CI/本地未起 mongo-rs）
const describeRs = process.env.SQLENGINE_TEST_MONGO_RS_URI ? describe : describe.skip;

describeRs('MongoDB 副本集事务（mongo-rs 27018）', () => {
  let available = false;

  beforeAll(async () => {
    const db = createClient(cfg);
    const t = await db.testConnection();
    available = t.success;
    if (!available) {
      console.warn(`[mongo-rs] 未就绪（${t.message}），跳过`);
    }
    await db.destroy();
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  test('副本集可用性检查（replSetGetStatus）', async () => {
    if (!available) return;
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const status = await client.db('admin').command({ replSetGetStatus: 1 });
    expect(status.myState).toBe(1); // 1 = PRIMARY
    await client.close();
  });

  test('事务成功提交：多文档原子生效', async () => {
    if (!available) return;
    const db = createClient(cfg);
    await db.execute('DELETE FROM tx_users WHERE _id != null');
    await db.execute('DELETE FROM tx_accounts WHERE _id != null');

    await db.withTransaction(async (tx) => {
      await tx.execute("INSERT INTO tx_users (name) VALUES ('alice')");
      await tx.execute("INSERT INTO tx_accounts (user_id, balance) VALUES (1, 100)");
    });

    const users = await db.query('SELECT * FROM tx_users');
    const accounts = await db.query('SELECT * FROM tx_accounts');
    expect(users.rows).toHaveLength(1);
    expect(accounts.rows).toHaveLength(1);
    await db.destroy();
  });

  test('事务异常回滚：fn 抛错 → 全部撤销', async () => {
    if (!available) return;
    const db = createClient(cfg);
    await db.execute('DELETE FROM tx_users WHERE _id != null');
    await db.execute('DELETE FROM tx_accounts WHERE _id != null');

    await expect(
      db.withTransaction(async (tx) => {
        await tx.execute("INSERT INTO tx_users (name) VALUES ('bob')");
        await tx.execute("INSERT INTO tx_accounts (user_id, balance) VALUES (2, 200)");
        throw new Error('rollback tx');
      }),
    ).rejects.toThrow('rollback tx');

    const users = await db.query('SELECT * FROM tx_users');
    const accounts = await db.query('SELECT * FROM tx_accounts');
    expect(users.rows).toHaveLength(0);
    expect(accounts.rows).toHaveLength(0);
    await db.destroy();
  });
});
