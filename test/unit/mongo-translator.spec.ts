import { describe, expect, test } from 'vitest';
import { translateSelect, translateWhereToMatch, mergeMatch } from '../../src/driver/mongodb/sql-translator.js';
import { translateDml, translateDmlFilter, inlineParams } from '../../src/driver/mongodb/dml-translator.js';
import { SqlEngineError } from '../../src/errors.js';

describe('sql-translator（noql）', () => {
  test('SELECT → query（collection + query + projection）', () => {
    const r = translateSelect('SELECT id, name FROM users WHERE age > 20 LIMIT 10');
    expect(r.type).toBe('query');
    expect(r.collection).toBe('users');
    expect(r.query).toEqual({ age: { $gt: 20 } });
    expect(r.projection).toEqual({ id: '$id', name: '$name' });
  });

  test('GROUP BY → aggregate pipeline', () => {
    const r = translateSelect('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    expect(r.type).toBe('aggregate');
    expect(r.collections).toEqual(['orders']);
    expect(Array.isArray(r.pipeline)).toBe(true);
  });

  test('WHERE 翻译：AND / LIKE / IN', () => {
    expect(translateWhereToMatch("age > 20 AND name LIKE 'a%'")).toEqual({
      $and: [{ age: { $gt: 20 } }, { name: { $regex: '^a', $options: 'i' } }],
    });
    expect(translateWhereToMatch('id IN (1, 2, 3)')).toEqual({ id: { $in: [1, 2, 3] } });
    expect(translateWhereToMatch('')).toEqual({});
  });

  test('mergeMatch：$and 合并不覆盖', () => {
    expect(mergeMatch({ age: { $gt: 20 } }, { name: 'a' })).toEqual({
      $and: [{ age: { $gt: 20 } }, { name: 'a' }],
    });
    expect(mergeMatch(undefined, { name: 'a' })).toEqual({ name: 'a' });
    expect(mergeMatch({ age: 1 }, undefined)).toEqual({ age: 1 });
  });
});

describe('dml-translator（node-sql-parser）', () => {
  test('inlineParams：? → 字面量（数字/字符串/布尔/null）', () => {
    expect(inlineParams('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', [1, 'x', true])).toBe(
      "INSERT INTO t (a, b, c) VALUES (1, 'x', TRUE)",
    );
    expect(inlineParams('SELECT 1 WHERE a = ?', [null])).toBe('SELECT 1 WHERE a = NULL');
    // 字符串转义
    expect(inlineParams("INSERT INTO t (a) VALUES (?)", ["it's"])).toBe(
      "INSERT INTO t (a) VALUES ('it''s')",
    );
    // 无参数原样
    expect(inlineParams('SELECT 1', [])).toBe('SELECT 1');
  });

  test('INSERT 单行 → documents', () => {
    const spec = translateDml("INSERT INTO users (name, age) VALUES ('dave', 40)", []);
    expect(spec.type).toBe('insert');
    expect(spec.collection).toBe('users');
    expect(spec.documents).toEqual([{ name: 'dave', age: 40 }]);
  });

  test('INSERT 多行 + 参数', () => {
    const spec = translateDml('INSERT INTO t (a, b) VALUES (?, ?), (3, ?)', [1, 'x', 'y']);
    expect(spec.documents).toEqual([
      { a: 1, b: 'x' },
      { a: 3, b: 'y' },
    ]);
  });

  test('UPDATE SET 普通值 → $set', () => {
    const spec = translateDml("UPDATE users SET age = 30, name = 'alice2' WHERE id = 1", []);
    expect(spec).toMatchObject({
      type: 'update',
      collection: 'users',
      updateDoc: { $set: { age: 30, name: 'alice2' } },
    });
  });

  test('UPDATE SET 自增 → $inc', () => {
    const spec = translateDml('UPDATE users SET age = age + 1 WHERE id = 1', []);
    expect(spec.updateDoc).toEqual({ $inc: { age: 1 } });
    const dec = translateDml('UPDATE users SET age = age - 1 WHERE id = 1', []);
    expect(dec.updateDoc).toEqual({ $inc: { age: -1 } });
  });

  test('UPDATE SET 不支持表达式 → DML_UNSUPPORTED_EXPRESSION', () => {
    expect(() => translateDml('UPDATE users SET age = UPPER(name) WHERE id = 1', [])).toThrow(
      SqlEngineError,
    );
  });

  test('DELETE → collection', () => {
    const spec = translateDml('DELETE FROM users WHERE age > 20', []);
    expect(spec).toEqual({ type: 'delete', collection: 'users' });
  });

  test('translateDmlFilter：WHERE → filter（与 SELECT 路径一致）', () => {
    expect(translateDmlFilter("UPDATE users SET a = 1 WHERE age > 20 AND name = 'x'")).toEqual({
      $and: [{ age: { $gt: 20 } }, { name: { $eq: 'x' } }],
    });
    expect(translateDmlFilter('DELETE FROM users')).toEqual({});
  });
});
