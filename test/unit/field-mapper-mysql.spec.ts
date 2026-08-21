import { describe, expect, test } from 'vitest';
import {
  mapMysqlColumnsToFields,
  mapMysqlProtocolFields,
  mysqlToDisplayType,
  normalizeMysqlFieldType,
} from '../../src/core/field-mapper/mysql.js';

describe('mysqlToDisplayType', () => {
  test('数字/字符/日期/JSON 分类', () => {
    expect(mysqlToDisplayType('bigint')).toBe('number');
    expect(mysqlToDisplayType('decimal(10,2)')).toBe('number');
    expect(mysqlToDisplayType('tinyint(1)')).toBe('boolean');
    expect(mysqlToDisplayType('varchar(255)')).toBe('string');
    expect(mysqlToDisplayType('text')).toBe('string');
    expect(mysqlToDisplayType('datetime')).toBe('date');
    expect(mysqlToDisplayType('json')).toBe('json');
    expect(mysqlToDisplayType('blob')).toBe('binary');
  });
});

describe('normalizeMysqlFieldType', () => {
  test('协议类型名 → SHOW FULL COLUMNS 风格', () => {
    expect(normalizeMysqlFieldType('LONGLONG')).toBe('bigint');
    expect(normalizeMysqlFieldType('VAR_STRING')).toBe('varchar');
    expect(normalizeMysqlFieldType('NEWDECIMAL')).toBe('decimal');
    expect(normalizeMysqlFieldType('bigint(20)')).toBe('bigint(20)'); // 已是原生类型
  });
});

describe('mapMysqlColumnsToFields', () => {
  test('SHOW FULL COLUMNS 行 → Field[]', () => {
    const fields = mapMysqlColumnsToFields([
      {
        Field: 'id',
        Type: 'int unsigned',
        Null: 'NO',
        Key: 'PRI',
        Extra: 'auto_increment',
        Comment: '主键',
      },
      { Field: 'name', Type: 'varchar(100)', Null: 'YES', Key: '', Comment: '姓名' },
    ]);
    expect(fields[0]).toMatchObject({
      field_name: 'id',
      field_type: 'int unsigned',
      display_type: 'number',
      is_primary: 1,
      field_desc: '主键',
    });
    expect(fields[1]).toMatchObject({ field_name: 'name', display_type: 'string', is_primary: 0 });
  });
});

describe('mapMysqlProtocolFields', () => {
  test('wire protocol 字段元数据 → Field[]', () => {
    const fields = mapMysqlProtocolFields([
      { name: 'id', type: 8 }, // LONGLONG → bigint
      { name: 'name', type: 253 }, // VAR_STRING → varchar
      { name: 'created_at', type: 7 }, // TIMESTAMP
    ]);
    expect(fields[0]).toMatchObject({ field_name: 'id', field_type: 'bigint', display_type: 'number' });
    expect(fields[1]).toMatchObject({ field_name: 'name', display_type: 'string' });
    expect(fields[2]).toMatchObject({ field_name: 'created_at', display_type: 'date' });
  });
});
