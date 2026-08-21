import { describe, expect, test } from 'vitest';
import { replaceTableNamesInSql, extractTableNamesFromSql, validateTableNameReplacement } from '../../src/core/sql/table-mapper.js';

describe('replaceTableNamesInSql', () => {
  const mapping = new Map([
    ['用户表', 'json_data_1_1'],
    ['数据源A.用户表', 'json_data_1_1'],
    ['orders', 'json_data_2_2'],
  ]);

  test('裸表名替换（FROM/JOIN）', () => {
    const sql = 'SELECT * FROM 用户表 u JOIN orders o ON u.id = o.uid';
    const replaced = replaceTableNamesInSql(sql, mapping);
    expect(replaced).toBe(
      'SELECT * FROM "json_data_1_1" u JOIN "json_data_2_2" o ON u.id = o.uid',
    );
  });

  test('引号表名与中文表名', () => {
    expect(replaceTableNamesInSql('SELECT * FROM `用户表`', mapping)).toBe(
      'SELECT * FROM "json_data_1_1"',
    );
    expect(replaceTableNamesInSql('SELECT * FROM "用户表"', mapping)).toBe(
      'SELECT * FROM "json_data_1_1"',
    );
  });

  test('schema 限定："数据源名"."表名" → 裸物理表名', () => {
    expect(replaceTableNamesInSql('SELECT * FROM "数据源A"."用户表"', mapping)).toBe(
      'SELECT * FROM "json_data_1_1"',
    );
    expect(replaceTableNamesInSql('SELECT * FROM 数据源A.用户表', mapping)).toBe(
      'SELECT * FROM "json_data_1_1"',
    );
  });

  test('复合 key 优先于裸名（同表名不同数据源）', () => {
    const m2 = new Map([
      ['t', 'phys_t'],
      ['ds2.t', 'phys_t_ds2'],
    ]);
    expect(replaceTableNamesInSql('SELECT * FROM ds2.t', m2)).toBe('SELECT * FROM "phys_t_ds2"');
    expect(replaceTableNamesInSql('SELECT * FROM t', m2)).toBe('SELECT * FROM "phys_t"');
  });

  test('不替换字符串字面量', () => {
    const sql = "SELECT * FROM t WHERE name = 'FROM 用户表'";
    // 字符串内容不匹配 FROM 关键字模式，应保留
    const replaced = replaceTableNamesInSql(sql, new Map([['t', 'phys_t']]));
    expect(replaced).toBe('SELECT * FROM "phys_t" WHERE name = \'FROM 用户表\'');
  });
});

describe('extractTableNamesFromSql / validateTableNameReplacement', () => {
  test('提取表名', () => {
    const names = extractTableNamesFromSql(
      'SELECT * FROM "数据源A"."用户表" a JOIN orders b ON a.id = b.uid',
    );
    expect(names.has('数据源A.用户表')).toBe(true);
    expect(names.has('orders')).toBe(true);
  });

  test('校验：映射缺失告警', () => {
    const mapping = new Map([['orders', 'phys_orders']]);
    const replaced = replaceTableNamesInSql('SELECT * FROM users JOIN orders o ON users.id = o.uid', mapping);
    const v = validateTableNameReplacement('SELECT * FROM users JOIN orders o ON users.id = o.uid', replaced, mapping);
    expect(v.valid).toBe(false);
    expect(v.warnings.some((w) => w.includes('users'))).toBe(true);
  });
});
