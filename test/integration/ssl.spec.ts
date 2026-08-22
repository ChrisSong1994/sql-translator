/**
 * SSL 集成测试（docker：mysql8-ssl 33064 / postgres-ssl 54322 / mongodb-ssl 27019）
 * 前置：bash scripts/gen-ssl-certs.sh && docker compose up -d --wait && pnpm db:init
 *
 * 三个服务端均强制 TLS（MySQL --require-secure-transport=ON / PG 仅 hostssl hba / Mongo requireTLS），
 * 因此既验证正例（SSL 连接成功、确认握手走 TLS），也验证反例（不带 ssl 配置 → 连接被拒）。
 * 未设置对应环境变量时自动跳过。
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { createClient } from '../../src/index.js';
import { defaultRegistry } from '../../src/client/registry.js';
import type { DbClient } from '../../src/client/index.js';

function readCa(): string | undefined {
  const p = process.env.SQLTRANSLATOR_TEST_SSL_CA ?? 'test/fixtures/ssl/ca.pem';
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
const CA = readCa();

function env(name: string): string | undefined {
  return process.env[name];
}

// ---------------- MySQL 8 SSL ----------------
const myHost = env('SQLTRANSLATOR_TEST_MYSQL8_SSL_HOST');
const myPort = env('SQLTRANSLATOR_TEST_MYSQL8_SSL_PORT');
const mysqlSslCfg =
  myHost && myPort && CA
    ? {
        type: 'mysql' as const,
        host: myHost,
        port: Number(myPort),
        user: 'ssl_user',
        password: 'sslpass',
        database: 'testdb',
        version: '8' as const,
        ssl: { enabled: true, ca: CA, rejectUnauthorized: false },
      }
    : null;

const describeMysql = mysqlSslCfg ? describe : describe.skip;
describeMysql('MySQL 8 SSL（docker 33064，服务端强制 TLS）', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createClient(mysqlSslCfg!);
    const t = await db.testConnection();
    if (!t.success) throw new Error(`SSL 连接失败: ${t.message}`);
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  test('SSL 连接成功 + 查询种子数据', async () => {
    expect((await db!.testConnection()).success).toBe(true);
    const res = await db!.query('SELECT * FROM users ORDER BY id');
    expect(res.rows).toHaveLength(3);
  });

  test('连接确实走了 TLS（Ssl_cipher 非空，mysql2 直连绕过语句白名单）', async () => {
    const conn = await mysql.createConnection({
      host: myHost!,
      port: Number(myPort),
      user: 'ssl_user',
      password: 'sslpass',
      database: 'testdb',
      ssl: { ca: CA, rejectUnauthorized: false },
    });
    const [rows] = await conn.query("SHOW STATUS LIKE 'Ssl_cipher'");
    const row = (rows as any[]).find((r) => r.Variable_name === 'Ssl_cipher');
    expect(String(row?.Value ?? '')).not.toBe('');
    await conn.end();
  });

  test('反例：不带 ssl 配置 → 连接被拒（REQUIRE SSL + require-secure-transport）', async () => {
    const plain = createClient({
      type: 'mysql',
      host: myHost!,
      port: Number(myPort),
      user: 'ssl_user',
      password: 'sslpass',
      database: 'testdb',
      version: '8',
    });
    const t = await plain.testConnection();
    expect(t.success).toBe(false);
    await defaultRegistry.destroyAll();
  });
});

// ---------------- PostgreSQL SSL ----------------
const pgHost = env('SQLTRANSLATOR_TEST_PG_SSL_HOST');
const pgPort = env('SQLTRANSLATOR_TEST_PG_SSL_PORT');
const pgSslCfg =
  pgHost && pgPort && CA
    ? {
        type: 'postgresql' as const,
        host: pgHost,
        port: Number(pgPort),
        user: 'test',
        password: 'test',
        database: 'testdb',
        ssl: { enabled: true, ca: CA, rejectUnauthorized: false },
      }
    : null;

const describePg = pgSslCfg ? describe : describe.skip;
describePg('PostgreSQL SSL（docker 54322，pg_hba 仅 hostssl）', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createClient(pgSslCfg!);
    const t = await db.testConnection();
    if (!t.success) throw new Error(`SSL 连接失败: ${t.message}`);
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  test('SSL 连接成功 + 查询种子数据', async () => {
    expect((await db!.testConnection()).success).toBe(true);
    const res = await db!.query('SELECT * FROM users ORDER BY id');
    expect(res.rows).toHaveLength(3);
  });

  test('连接确实走了 TLS（pg_stat_ssl.ssl = true）', async () => {
    const res = await db!.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    expect(res.rows[0]?.ssl).toBe(true);
  });

  test('反例：不带 ssl 配置 → 连接被拒（pg_hba 无非 TLS 规则）', async () => {
    const plain = createClient({
      type: 'postgresql',
      host: pgHost!,
      port: Number(pgPort),
      user: 'test',
      password: 'test',
      database: 'testdb',
    });
    const t = await plain.testConnection();
    expect(t.success).toBe(false);
    await defaultRegistry.destroyAll();
  });
});

// ---------------- MongoDB SSL ----------------
const mongoSslUri = env('SQLTRANSLATOR_TEST_MONGO_SSL_URI');
const mongoCfg =
  CA && (mongoSslUri ?? (myHost || pgHost ? 'mongodb://127.0.0.1:27019' : undefined))
    ? {
        type: 'mongodb' as const,
        uri: mongoSslUri ?? 'mongodb://127.0.0.1:27019',
        database: 'testdb',
        ssl: { enabled: true, ca: CA },
      }
    : null;

const describeMongo = mongoCfg ? describe : describe.skip;
describeMongo('MongoDB TLS（docker 27019，requireTLS）', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createClient(mongoCfg!);
    const t = await db.testConnection();
    if (!t.success) throw new Error(`TLS 连接失败: ${t.message}`);
  });

  afterAll(async () => {
    await defaultRegistry.destroyAll();
  });

  test('TLS 连接成功 + SQL 查询', async () => {
    expect((await db!.testConnection()).success).toBe(true);
    const res = await db!.query('SELECT * FROM users WHERE age > 22');
    expect(res.rows.map((r: any) => r.name).sort()).toEqual(['alice', 'carol']);
  });

  test('反例：不带 ssl 配置 → 连接被拒（requireTLS）', async () => {
    const plain = createClient({ type: 'mongodb', uri: mongoCfg!.uri, database: 'testdb' });
    const t = await plain.testConnection();
    expect(t.success).toBe(false);
    await defaultRegistry.destroyAll();
  });
});

// 占位：当无环境变量时 vitest 仍需至少一个用例才能通过
test('SSL 集成测试需要环境变量 + CA 证书（未满足时本文件整体跳过）', () => {
  expect(true).toBe(true);
});
