import { describe, expect, test } from 'vitest';
import { fingerprintConfig, normalizeConfig, configKey } from '../../src/core/config.js';

describe('fingerprintConfig', () => {
  test('相同配置 → 相同指纹；密码变化 → 指纹变化', () => {
    const a: any = { type: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p1', database: 'd' };
    const b: any = { type: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p1', database: 'd' };
    const c: any = { ...a, password: 'p2' };
    expect(fingerprintConfig(a)).toBe(fingerprintConfig(b));
    expect(fingerprintConfig(a)).not.toBe(fingerprintConfig(c));
  });

  test('user / username 别名归一化后同指纹', () => {
    const a: any = { type: 'postgresql', host: 'h', user: 'u', password: 'p', database: 'd' };
    const b: any = { type: 'postgresql', host: 'h', username: 'u', password: 'p', database: 'd' };
    expect(fingerprintConfig(a)).toBe(fingerprintConfig(b));
  });

  test('sqlite 按 path 区分；:memory: 与文件库不同', () => {
    const mem: any = { type: 'sqlite', database: ':memory:' };
    const file: any = { type: 'sqlite', database: '/tmp/x.db' };
    expect(fingerprintConfig(mem)).not.toBe(fingerprintConfig(file));
    expect(fingerprintConfig(mem)).toBe(fingerprintConfig({ ...mem }));
  });

  test('不同方言不碰撞', () => {
    const m: any = { type: 'mysql', host: 'h', database: 'd' };
    const p: any = { type: 'postgresql', host: 'h', database: 'd' };
    expect(fingerprintConfig(m)).not.toBe(fingerprintConfig(p));
  });
});

describe('normalizeConfig / configKey', () => {
  test('填充默认端口', () => {
    const cfg = normalizeConfig({ type: 'mysql', host: 'h', database: 'd' } as any) as any;
    expect(cfg.port).toBe(3306);
  });

  test('configKey = normalize + fingerprint', () => {
    const a: any = { type: 'mysql', host: 'h', database: 'd' };
    const b: any = { type: 'mysql', host: 'h', port: 3306, database: 'd' };
    expect(configKey(a)).toBe(configKey(b));
  });
});
