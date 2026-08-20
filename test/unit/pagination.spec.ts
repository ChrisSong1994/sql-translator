import { describe, expect, test } from 'vitest';
import {
  buildCountSql,
  buildPagedSql,
  extractLimitOffset,
  hasPaginationClause,
  wrapWithWhereClause,
} from '../../src/core/sql/pagination.js';

describe('extractLimitOffset', () => {
  test('LIMIT n', () => {
    expect(extractLimitOffset('SELECT * FROM t LIMIT 10')).toEqual({ limit: 10, offset: undefined });
  });

  test('LIMIT a OFFSET b', () => {
    expect(extractLimitOffset('SELECT * FROM t LIMIT 10 OFFSET 5')).toEqual({ limit: 10, offset: 5 });
  });

  test('LIMIT a, b（MySQL 逗号语法）', () => {
    expect(extractLimitOffset('SELECT * FROM t LIMIT 5, 10')).toEqual({ limit: 10, offset: 5 });
  });

  test('字符串内的 LIMIT 不误判', () => {
    expect(extractLimitOffset("SELECT 'limit 5' AS s FROM t")).toEqual({});
  });

  test('注释内的 LIMIT 不误判', () => {
    expect(extractLimitOffset('SELECT 1 -- limit 5\n')).toEqual({});
  });
});

describe('hasPaginationClause', () => {
  test('识别 LIMIT/OFFSET', () => {
    expect(hasPaginationClause('SELECT * FROM t LIMIT 10')).toBe(true);
    expect(hasPaginationClause('SELECT * FROM t OFFSET 5')).toBe(true);
    expect(hasPaginationClause('SELECT * FROM t')).toBe(false);
  });

  test('额外模式（FETCH FIRST / TOP）', () => {
    expect(hasPaginationClause('SELECT * FROM t FETCH FIRST 10 ROWS ONLY', [/\bfetch\s+first\b/i])).toBe(true);
    expect(hasPaginationClause('SELECT TOP 10 * FROM t', [/\btop\b/i])).toBe(true);
  });
});

describe('wrapWithWhereClause', () => {
  test('CTE 模式', () => {
    expect(wrapWithWhereClause('SELECT * FROM t', 'age > 18', { supportsCTE: true })).toBe(
      'WITH __t AS (SELECT * FROM t) SELECT * FROM __t WHERE age > 18',
    );
  });

  test('派生表模式（MySQL 5.7）', () => {
    expect(wrapWithWhereClause('SELECT * FROM t', 'age > 18', { supportsCTE: false })).toBe(
      'SELECT * FROM (SELECT * FROM t) AS __t WHERE age > 18',
    );
  });

  test('无 whereClause 原样返回', () => {
    expect(wrapWithWhereClause('SELECT 1', '')).toBe('SELECT 1');
  });
});

describe('buildPagedSql / buildCountSql', () => {
  test('分页与计数包装', () => {
    expect(buildPagedSql('SELECT * FROM t', 10, 20)).toBe('SELECT * FROM t LIMIT 10 OFFSET 20');
    expect(buildCountSql('SELECT * FROM t')).toBe('SELECT COUNT(1) AS total FROM (SELECT * FROM t) AS __t2');
  });

  test('负数保护', () => {
    expect(buildPagedSql('SELECT 1', -1, -5)).toBe('SELECT 1 LIMIT 0 OFFSET 0');
  });
});
