import { describe, expect, test } from 'vitest';
import { normalizeSql, stripSqlForSearch } from '../../src/core/sql/normalize.js';

describe('normalizeSql', () => {
  test('去除末尾分号和空白', () => {
    expect(normalizeSql('  SELECT 1;  ')).toBe('SELECT 1');
    expect(normalizeSql('SELECT 1;;')).toBe('SELECT 1');
    expect(normalizeSql('SELECT 1; ;')).toBe('SELECT 1');
    expect(normalizeSql('')).toBe('');
  });
});

describe('stripSqlForSearch', () => {
  test('剥离字符串常量', () => {
    const s = stripSqlForSearch("SELECT * FROM t WHERE name = 'limit' AND age > 10");
    expect(s).not.toContain('limit');
    expect(s).toContain('WHERE');
    expect(s).toContain('age > 10');
  });

  test('剥离注释', () => {
    const s = stripSqlForSearch('SELECT 1 -- limit comment\n FROM t /* update x */');
    expect(s).not.toContain('limit comment');
    expect(s).not.toContain('update x');
    expect(s).toContain('FROM t');
  });

  test('保留关键字', () => {
    const s = stripSqlForSearch("SELECT 'LIMIT' AS kw, 1 AS x");
    // 字符串里的 LIMIT 被剥离，关键字 LIMIT 不在（此处 SQL 没有真 LIMIT）
    expect(s).toContain('kw');
    expect(s).toContain('x');
  });
});
