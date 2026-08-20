import { describe, expect, test } from 'vitest';
import {
  countInsertValueRows,
  detectStatementType,
  extractDmlWhere,
  extractTableNamesFromSql,
  hasDmlWhere,
} from '../../src/core/sql/statement.js';

describe('detectStatementType', () => {
  test('SELECT / CTE', () => {
    expect(detectStatementType('select * from t')).toBe('SELECT');
    expect(detectStatementType('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
  });

  test('DML', () => {
    expect(detectStatementType('INSERT INTO t (a) VALUES (1)')).toBe('INSERT');
    expect(detectStatementType('UPDATE t SET a = 1')).toBe('UPDATE');
    expect(detectStatementType('DELETE FROM t')).toBe('DELETE');
  });

  test('DDL / 其他 / 未知', () => {
    expect(detectStatementType('CREATE TABLE t (a INT)')).toBe('DDL');
    expect(detectStatementType('  -- 注释\nSELECT 1')).toBe('SELECT');
    expect(detectStatementType('')).toBe('UNKNOWN');
    expect(detectStatementType('任意文本')).toBe('UNKNOWN');
  });
});

describe('hasDmlWhere / extractDmlWhere', () => {
  test('UPDATE 带 WHERE', () => {
    expect(hasDmlWhere('UPDATE t SET a = 1 WHERE id = 5')).toBe(true);
    expect(extractDmlWhere('UPDATE t SET a = 1 WHERE id = 5')).toMatch(/^WHERE id = 5/i);
  });

  test('无 WHERE 的 UPDATE/DELETE', () => {
    expect(hasDmlWhere('UPDATE t SET a = 1')).toBe(false);
    expect(hasDmlWhere('DELETE FROM t')).toBe(false);
  });

  test('字符串中的 WHERE 不误判', () => {
    expect(hasDmlWhere("UPDATE t SET name = 'where x' WHERE id = 1")).toBe(true);
    expect(hasDmlWhere("UPDATE t SET name = 'where x'")).toBe(false);
  });
});

describe('extractTableNamesFromSql', () => {
  test('FROM / JOIN', () => {
    const names = extractTableNamesFromSql(
      'SELECT * FROM users u JOIN orders o ON u.id = o.user_id',
    );
    expect(names.has('users')).toBe(true);
    expect(names.has('orders')).toBe(true);
  });

  test('schema-qualified 与引号', () => {
    const names = extractTableNamesFromSql('SELECT * FROM "my_schema"."my_table"');
    expect(names.has('my_schema.my_table')).toBe(true);

    const names2 = extractTableNamesFromSql('SELECT * FROM `订单表`');
    expect(names2.has('订单表')).toBe(true);
  });

  test('INSERT INTO / UPDATE / DELETE FROM 目标表', () => {
    expect(extractTableNamesFromSql('INSERT INTO logs (a) VALUES (1)').has('logs')).toBe(true);
    expect(extractTableNamesFromSql('UPDATE users SET a = 1').has('users')).toBe(true);
    expect(extractTableNamesFromSql('DELETE FROM users WHERE id = 1').has('users')).toBe(true);
  });
});

describe('countInsertValueRows', () => {
  test('单行/多行 VALUES', () => {
    expect(countInsertValueRows('INSERT INTO t (a, b) VALUES (1, 2)')).toBe(1);
    expect(countInsertValueRows('INSERT INTO t (a) VALUES (1), (2), (3)')).toBe(3);
  });

  test('INSERT ... SELECT 返回 0（无法解析行数）', () => {
    expect(countInsertValueRows('INSERT INTO t (a) SELECT id FROM s')).toBe(0);
  });
});
