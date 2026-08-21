#!/usr/bin/env node
/**
 * 初始化测试数据库种子数据（MySQL 5.7/8.0、MongoDB）
 * 用法：node scripts/init-fixtures.mjs
 * 环境变量：
 *   SQLENGINE_TEST_MYSQL5_HOST/PORT、SQLENGINE_TEST_MYSQL8_HOST/PORT（默认 33061/33062）
 *   SQLENGINE_TEST_MONGO_URI（默认 mongodb://127.0.0.1:27017）
 *
 * 说明：
 * - MySQL 不用 docker-entrypoint 挂载（容器默认 latin1 导致中文注释双重编码），统一脚本 utf8mb4 初始化
 * - PostgreSQL 用 docker-entrypoint 挂载（PG 容器默认 UTF8，见 fixtures/postgresql/init.sql）
 * - MongoDB 无挂载式 init，脚本注入
 */
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const INIT_SQL = fileURLToPath(new URL('../test/fixtures/mysql/init.sql', import.meta.url));
const sql = await readFile(INIT_SQL, 'utf8');

const mysqlTargets = [
  {
    name: 'mysql5',
    port: Number(process.env.SQLENGINE_TEST_MYSQL5_PORT ?? 33061),
    host: process.env.SQLENGINE_TEST_MYSQL5_HOST ?? '127.0.0.1',
  },
  {
    name: 'mysql8',
    port: Number(process.env.SQLENGINE_TEST_MYSQL8_PORT ?? 33062),
    host: process.env.SQLENGINE_TEST_MYSQL8_HOST ?? '127.0.0.1',
  },
  {
    name: 'mariadb',
    port: Number(process.env.SQLENGINE_TEST_MARIADB_PORT ?? 33063),
    host: process.env.SQLENGINE_TEST_MARIADB_HOST ?? '127.0.0.1',
  },
];

for (const target of mysqlTargets) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: 'root',
      password: 'root',
      charset: 'utf8mb4',
      multipleStatements: true,
      connectTimeout: 5000,
    });
    await conn.query('DROP DATABASE IF EXISTS testdb');
    await conn.query(sql);
    console.log(`[init-fixtures] ${target.name} (${target.host}:${target.port}) 初始化完成`);
  } catch (err) {
    console.error(`[init-fixtures] ${target.name} 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end().catch(() => undefined);
  }
}

// ---- MongoDB 种子数据 ----
const mongoUri = process.env.SQLENGINE_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
let mongo;
try {
  mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  const db = mongo.db('testdb');
  await db.dropDatabase().catch(() => undefined);
  await db.collection('users').insertMany([
    { name: 'alice', age: 30, email: 'alice@x.com', balance: 100.5, is_active: true, birthday: new Date('1993-01-15'), address: { city: 'Beijing', zip: '100000' }, tags: ['vip', 'member'] },
    { name: 'bob', age: 20, email: 'bob@x.com', balance: 0, is_active: false, birthday: new Date('2003-06-01'), address: { city: 'Shanghai', zip: '200000' }, tags: ['member'] },
    { name: 'carol', age: 25, email: 'carol@x.com', balance: 50, is_active: true, birthday: new Date('1998-12-20'), address: { city: 'Shenzhen', zip: '518000' }, tags: ['vip'] },
  ]);
  await db.collection('orders').insertMany([
    { user_id: 1, amount: 10.5, status: 'paid' },
    { user_id: 1, amount: 5, status: 'pending' },
    { user_id: 3, amount: 99, status: 'paid' },
  ]);
  console.log(`[init-fixtures] mongodb (${mongoUri}) 初始化完成`);
} catch (err) {
  console.error(`[init-fixtures] mongodb 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (mongo) await mongo.close().catch(() => undefined);
}
