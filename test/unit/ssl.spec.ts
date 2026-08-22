/**
 * SSL 配置单元测试：三个驱动（mysql / pg / mongodb）的 SSL 配置构建
 * + 配置层 SSL 归一化 / 指纹。不依赖真实数据库。
 */
import { describe, expect, test } from 'vitest';
import { buildSslConfig } from '../../src/driver/mysql/pool.js';
import { buildPgSslConfig } from '../../src/driver/postgresql/pool.js';
import { buildMongoOptions } from '../../src/driver/mongodb/pool.js';
import { configKey, fingerprintConfig, normalizeConfig } from '../../src/core/config.js';
import type { MongodbConfig, MysqlConfig, PostgresqlConfig } from '../../src/types/config.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEfake\n-----END PRIVATE KEY-----';

const mysqlBase: MysqlConfig = { type: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' };
const pgBase: PostgresqlConfig = { type: 'postgresql', host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' };
const mongoBase: MongodbConfig = { type: 'mongodb', host: 'h', port: 27017, database: 'd' };

describe('buildSslConfig（MySQL / MariaDB）', () => {
  test('未启用 / 无 ssl 字段 → undefined', () => {
    expect(buildSslConfig({ ...mysqlBase, ssl: { enabled: false } })).toBeUndefined();
    expect(buildSslConfig(mysqlBase)).toBeUndefined();
  });

  test('enabled 仅开启 → 默认 rejectUnauthorized=false + 固定 minVersion TLSv1.2', () => {
    expect(buildSslConfig({ ...mysqlBase, ssl: { enabled: true } })).toEqual({
      ca: undefined,
      cert: undefined,
      key: undefined,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
  });

  test('ca/cert/key 透传；rejectUnauthorized=true 生效', () => {
    expect(buildSslConfig({ ...mysqlBase, ssl: { enabled: true, ca: CA, cert: CERT, key: KEY, rejectUnauthorized: true } })).toEqual({
      ca: CA,
      cert: CERT,
      key: KEY,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
  });
});

describe('buildPgSslConfig（PostgreSQL）', () => {
  test('未启用 / 无 ssl 字段 → undefined', () => {
    expect(buildPgSslConfig({ ...pgBase, ssl: { enabled: false } })).toBeUndefined();
    expect(buildPgSslConfig(pgBase)).toBeUndefined();
  });

  test('enabled 仅开启 → 默认 rejectUnauthorized=false', () => {
    expect(buildPgSslConfig({ ...pgBase, ssl: { enabled: true } })).toEqual({
      ca: undefined,
      cert: undefined,
      key: undefined,
      rejectUnauthorized: false,
    });
  });

  test('ca/cert/key 透传；rejectUnauthorized=true 生效', () => {
    expect(buildPgSslConfig({ ...pgBase, ssl: { enabled: true, ca: CA, cert: CERT, key: KEY, rejectUnauthorized: true } })).toEqual({
      ca: CA,
      cert: CERT,
      key: KEY,
      rejectUnauthorized: true,
    });
  });
});

describe('buildMongoOptions（MongoDB）', () => {
  test('未启用 / 无 ssl → 不出现 tls 字段', () => {
    expect(buildMongoOptions({ ...mongoBase, ssl: { enabled: false } })).not.toHaveProperty('tls');
    expect(buildMongoOptions(mongoBase)).not.toHaveProperty('tls');
  });

  test('enabled → tls=true，默认 rejectUnauthorized=false（顶层，非 tlsOptions）', () => {
    const opts = buildMongoOptions({ ...mongoBase, ssl: { enabled: true } });
    expect(opts.tls).toBe(true);
    expect(opts.rejectUnauthorized).toBe(false);
    expect(opts).not.toHaveProperty('tlsOptions');
  });

  test('ca/cert/key 转为 Buffer 传入顶层 options（driver 7.x 支持 Node TLS 选项）', () => {
    const opts = buildMongoOptions({ ...mongoBase, ssl: { enabled: true, ca: CA, cert: CERT, key: KEY } });
    expect(Buffer.isBuffer(opts.ca)).toBe(true);
    expect(Buffer.isBuffer(opts.cert)).toBe(true);
    expect(Buffer.isBuffer(opts.key)).toBe(true);
    expect(opts.ca!.toString()).toBe(CA);
    expect(opts.cert!.toString()).toBe(CERT);
    expect(opts.key!.toString()).toBe(KEY);
  });

  test('rejectUnauthorized=true 透传（顶层）', () => {
    const opts = buildMongoOptions({ ...mongoBase, ssl: { enabled: true, rejectUnauthorized: true } });
    expect(opts.rejectUnauthorized).toBe(true);
  });
});

describe('normalizeConfig 的 SSL 归一化', () => {
  test('ssl 对象缺 enabled → 补 enabled: true', () => {
    const cfg = normalizeConfig({ ...mysqlBase, ssl: { ca: CA } } as MysqlConfig) as any;
    expect(cfg.ssl).toEqual({ enabled: true, ca: CA });
  });

  test('ssl: { enabled: false } 保持关闭', () => {
    const cfg = normalizeConfig({ ...mysqlBase, ssl: { enabled: false } }) as any;
    expect(cfg.ssl.enabled).toBe(false);
  });

  test('无 ssl 字段 → 不新增', () => {
    const cfg = normalizeConfig(mysqlBase) as any;
    expect(cfg.ssl).toBeUndefined();
  });
});

describe('fingerprint / configKey 的 SSL 指纹', () => {
  test('ssl 开启与不开启 → 不同指纹（nossl vs ssl:default）', () => {
    const plain = configKey(mysqlBase);
    const ssl = configKey({ ...mysqlBase, ssl: { enabled: true } });
    expect(plain).not.toBe(ssl);
    expect(plain).toContain('nossl');
    expect(ssl).toContain('ssl:default');
  });

  test('mode 参与指纹：不同 mode → 不同指纹', () => {
    const a = configKey({ ...pgBase, ssl: { enabled: true, mode: 'require' } });
    const b = configKey({ ...pgBase, ssl: { enabled: true, mode: 'verify-ca' } });
    expect(a).not.toBe(b);
  });

  test('enabled 缺省补 true 后与显式 enabled: true 同指纹（经 configKey 归一化）', () => {
    const a = configKey({ ...mysqlBase, ssl: { mode: 'require' } });
    const b = configKey({ ...mysqlBase, ssl: { enabled: true, mode: 'require' } });
    expect(a).toBe(b);
  });

  test('ca/cert/key 参与指纹：任一证书变化 → 不同指纹（换证书拆池）', () => {
    const base = { ...mysqlBase, ssl: { enabled: true } };
    const a = configKey({ ...base, ssl: { ...base.ssl, ca: 'certA' } });
    const b = configKey({ ...base, ssl: { ...base.ssl, ca: 'certB' } });
    expect(a).not.toBe(b);

    const c = configKey({ ...base, ssl: { ...base.ssl, cert: 'certX' } });
    expect(a).not.toBe(c);

    const d = configKey({ ...base, ssl: { ...base.ssl, key: 'keyX' } });
    expect(a).not.toBe(d);
  });

  test('证书明文不直接进入指纹（sha256 摘要，防日志/缓存 key 泄露）', () => {
    const key = configKey({ ...mysqlBase, ssl: { enabled: true, ca: 'TOP-SECRET-CA' } });
    expect(key).not.toContain('TOP-SECRET-CA');
  });

  test('ssl 未启用时 ca 变化不影响指纹（nossl 段恒定）', () => {
    const a = configKey({ ...mysqlBase, ssl: { enabled: false, ca: 'a' } });
    const b = configKey({ ...mysqlBase, ssl: { enabled: false, ca: 'b' } });
    expect(a).toBe(b);
  });

  test('rejectUnauthorized 不参与指纹', () => {
    const a = configKey({ ...mongoBase, ssl: { enabled: true, rejectUnauthorized: false } });
    const b = configKey({ ...mongoBase, ssl: { enabled: true, rejectUnauthorized: true } });
    expect(a).toBe(b);
  });

  test('fingerprintConfig（未归一化）对空 ssl 对象视为 nossl，与 configKey 行为一致链路', () => {
    const raw = fingerprintConfig({ ...mysqlBase, ssl: {} as any });
    expect(raw).toContain('nossl');
    // configKey 归一化后补 enabled: true → ssl:default
    expect(configKey({ ...mysqlBase, ssl: {} as any })).toContain('ssl:default');
  });
});
