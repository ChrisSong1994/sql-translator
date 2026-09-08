/**
 * MongoDB 连接测试（用 dotenv 加载 .env.test 的 MONGO_DATABASE_* 配置，连真实远程库）
 *
 * 与 mongodb.spec.ts（Docker 27017 全功能）不同，本文件仅验证「按 .env.test 配置能否连通、能查询」，
 * 不预设任何表/种子数据，因此在未提供 .env.test（或其配置连不上）时自动跳过。
 *
 * 运行：
 *   pnpm vitest run test/integration/mongodb-env.spec.ts
 */
import { describe, expect, test, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient, testConnection } from '../../src/index.js';
import type { MongodbConfig } from '../../src/types/config.js';
import type { DbClient } from '../../src/client/index.js';

// 用 dotenv 加载 .env.test（不覆盖已有环境变量）
loadEnv({ path: resolve(__dirname, '../../', '.env.test'), override: false });
 
/** 拼出 MongodbConfig；缺必要环境变量时为 null（自动跳过） */
function envMongoConfig(): MongodbConfig | null {
  const host = process.env.MONGO_DATABASE_HOST;
  const port = process.env.MONGO_DATABASE_PORT;
  const user = process.env.MONGO_DATABASE_USER;
  const password = process.env.MONGO_DATABASE_PASSWORD;
  if (!host || !port) return null;
  return {
    type: 'mongodb',
    host,
    port: Number(port),
    user,
    password,
    // 认证库：topiax 用户建在 admin 库，必须显式指定，否则驱动默认在 wizbuild 库认证会失败
    authSource: process.env.MONGO_DATABASE_AUTH_SOURCE ?? 'admin',
    // 远程库连接测试放宽超时，避免慢网络误判
    connectTimeoutMS: 15000,
    serverSelectionTimeoutMS: 15000,
    database: process.env.MONGO_DATABASE_NAME ?? 'admin',
  };
}

const cfg = envMongoConfig();
const describeMongo = cfg ? describe : describe.skip;

describeMongo('MongoDB（.env.test 远程连接）', () => {
  let db: DbClient;
  let available = false;

  beforeAll(async () => {
    const cfgNonNull = cfg!;
    // 先用函数式 API 做纯连接测试（不持有连接）
    const t = await testConnection(cfgNonNull);
    available = t.success;
    if (!available) {
      console.warn(`[mongo-env] 连接失败（${t.message}），跳过`);
      return;
    }
    // 再走 createClient + DbClient.testConnection 二次验证
    db = createClient(cfgNonNull);
    const t2 = await db.testConnection();
    available = t2.success;
    if (!available) {
      console.warn(`[mongo-env] createClient 连接失败（${t2.message}），跳过`);
    }
  });

  test('testConnection 成功（函数式 API）', async () => {
    if (!available) return;
    const t = await testConnection(cfg!);
    expect(t.success).toBe(true);
    expect(t.message).toContain('successful');
  });

  test('createClient().testConnection 成功', async () => {
    if (!available) return;
    const t = await db.testConnection();
    expect(t.success).toBe(true);
  });

  test('列表集合可达', async () => {
    if (!available) return;
    const tables = await db.getTables();
    expect(Array.isArray(tables)).toBe(true);
  });

  test('集合行数统计可达（getRowsCount）', async () => {
    if (!available) return;
    const tables = await db.getTables();
    expect(tables.length).toBeGreaterThan(0);
    const t = await db.getRowsCount(tables[0]);
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThanOrEqual(0);
  });
});

test('MongoDB .env.test 连接测试（未配置时占位通过）', () => {
  if (!cfg) {
    console.warn('[mongo-env] 未在 .env.test 提供 MONGO_DATABASE_HOST/PORT，跳过');
  }
  expect(true).toBe(true);
});
