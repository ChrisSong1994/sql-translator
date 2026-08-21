#!/usr/bin/env node
/**
 * 初始化测试数据库种子数据（MySQL 5.7 / 8.0）
 * 用法：node scripts/init-fixtures.mjs
 * 环境变量：SQLENGINE_TEST_MYSQL5_HOST/PORT、SQLENGINE_TEST_MYSQL8_HOST/PORT（默认 33061/33062，root/root）
 *
 * 说明：不用 docker-entrypoint 挂载 init.sql（容器默认 latin1 字符集会导致中文注释双重编码），
 * 统一由本脚本以 utf8mb4 连接执行，行为可预期。
 */
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const INIT_SQL = fileURLToPath(new URL('../test/fixtures/mysql/init.sql', import.meta.url));

const targets = [
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
];

const sql = await readFile(INIT_SQL, 'utf8');

for (const target of targets) {
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
