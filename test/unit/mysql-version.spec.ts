import { describe, expect, test } from 'vitest';
import {
  MYSQL5_CAPS,
  MYSQL8_CAPS,
  parseMysqlVersion,
} from '../../src/driver/mysql/version.js';

describe('parseMysqlVersion', () => {
  test('5.7 → 无 CTE / 有 JSON', () => {
    const caps = parseMysqlVersion('5.7.44-log');
    expect(caps.major).toBe(5);
    expect(caps.supportsCTE).toBe(false);
    expect(caps.supportsWindowFunctions).toBe(false);
    expect(caps.supportsJson).toBe(true);
  });

  test('5.7.7 → 无 JSON（5.7.8+ 才有）', () => {
    expect(parseMysqlVersion('5.7.7').supportsJson).toBe(false);
    expect(parseMysqlVersion('5.7.8').supportsJson).toBe(true);
  });

  test('8.0 → CTE / 窗口函数', () => {
    const caps = parseMysqlVersion('8.0.36');
    expect(caps.major).toBe(8);
    expect(caps.supportsCTE).toBe(true);
    expect(caps.supportsWindowFunctions).toBe(true);
  });

  test('未知格式 → 全 false', () => {
    const caps = parseMysqlVersion('invalid');
    expect(caps.major).toBe(0);
    expect(caps.supportsCTE).toBe(false);
  });
});

describe('强制版本矩阵', () => {
  test('MYSQL5_CAPS / MYSQL8_CAPS', () => {
    expect(MYSQL5_CAPS.supportsCTE).toBe(false);
    expect(MYSQL8_CAPS.supportsCTE).toBe(true);
  });
});
