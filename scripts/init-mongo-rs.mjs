#!/usr/bin/env node
/**
 * 初始化 Mongo 单节点副本集（mongo-rs，端口 27018）
 * 用法：node scripts/init-mongo-rs.mjs
 * 说明：MongoDB 事务需要副本集；单节点副本集即可支持多文档事务
 */
import { MongoClient } from 'mongodb';

const uri = process.env.SQLENGINE_TEST_MONGO_RS_URI ?? 'mongodb://127.0.0.1:27018';
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, directConnection: true });
try {
  await client.connect();
  const admin = client.db('admin');
  const status = await admin.command({ replSetGetStatus: 1 }).catch(() => null);
  if (status) {
    console.log('[init-mongo-rs] 副本集已就绪，members:', status.members?.length ?? '?');
  } else {
    // 初始化副本集
    await admin.command({
      replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: 'mongo-rs:27017' }] },
    });
    console.log('[init-mongo-rs] replSetInitiate 已执行，等待 primary...');
    // 等待 PRIMARY
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await admin.command({ replSetGetStatus: 1 }).catch(() => null);
      const primary = s?.members?.find((m) => m.stateStr === 'PRIMARY');
      if (primary) {
        console.log('[init-mongo-rs] PRIMARY 就绪:', primary.name);
        process.exit(0);
      }
    }
    console.error('[init-mongo-rs] 等待 PRIMARY 超时');
    process.exit(1);
  }
} catch (err) {
  console.error('[init-mongo-rs] 失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}
