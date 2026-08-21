/**
 * MySQL/MariaDB 字段映射
 * 统一展示：协议类型 ID / SHOW FULL COLUMNS 类型 → Field[]
 */

export interface MysqlColumn {
  Field: string;
  Type: string;
  Null?: 'YES' | 'NO';
  Key?: string; // 'PRI' | 'MUL' | 'UNI' | ''
  Default?: any;
  Extra?: string;
  Comment?: string;
}

/** mysql2 wire protocol 字段类型 ID → 类型名 */
export const MYSQL_PROTOCOL_TYPES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINY',
  2: 'SHORT',
  3: 'LONG',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'LONGLONG',
  9: 'INT24',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'NEWDATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'NEWDECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINY_BLOB',
  250: 'MEDIUM_BLOB',
  251: 'LONG_BLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING',
  255: 'GEOMETRY',
};

/** 协议类型名 → SHOW FULL COLUMNS 风格类型名 */
const MYSQL_PROTOCOL_TYPE_MAP: Record<string, string> = {
  DECIMAL: 'decimal',
  TINY: 'tinyint',
  SHORT: 'smallint',
  LONG: 'int',
  FLOAT: 'float',
  DOUBLE: 'double',
  LONGLONG: 'bigint',
  INT24: 'mediumint',
  DATE: 'date',
  TIME: 'time',
  DATETIME: 'datetime',
  TIMESTAMP: 'timestamp',
  YEAR: 'year',
  NEWDATE: 'date',
  VARCHAR: 'varchar',
  BIT: 'bit',
  JSON: 'json',
  NEWDECIMAL: 'decimal',
  ENUM: 'enum',
  SET: 'set',
  TINY_BLOB: 'tinyblob',
  MEDIUM_BLOB: 'mediumblob',
  LONG_BLOB: 'longblob',
  BLOB: 'blob',
  VAR_STRING: 'varchar',
  STRING: 'char',
  GEOMETRY: 'geometry',
  NULL: 'null',
};

/** 将 MySQL/MariaDB 协议类型名映射为 SHOW FULL COLUMNS 风格的类型名 */
export function normalizeMysqlFieldType(type: string): string {
  return MYSQL_PROTOCOL_TYPE_MAP[type] || type;
}

/** MySQL 类型 → 统一展示类型 */
export function mysqlToDisplayType(mysqlType: string): string {
  const t = String(mysqlType).toLowerCase();
  if (t.startsWith('varchar') || t.startsWith('char')) return 'string';
  if (t.includes('text') || t.startsWith('enum') || t.startsWith('set')) return 'string';
  if (
    t.startsWith('int') ||
    t.startsWith('integer') ||
    t.startsWith('tinyint') ||
    t.startsWith('smallint') ||
    t.startsWith('mediumint') ||
    t.startsWith('bigint') ||
    t.startsWith('decimal') ||
    t.startsWith('numeric') ||
    t.startsWith('float') ||
    t.startsWith('double') ||
    t.startsWith('bit')
  )
    return t.startsWith('tinyint(1)') ? 'boolean' : 'number';
  if (
    t.startsWith('date') ||
    t.startsWith('datetime') ||
    t.startsWith('timestamp') ||
    t.startsWith('time') ||
    t.startsWith('year')
  )
    return 'date';
  if (t.startsWith('json')) return 'json';
  if (t.includes('blob') || t.startsWith('binary') || t.startsWith('varbinary')) return 'binary';
  return 'string';
}

/** 将 SHOW FULL COLUMNS 行 → Field[] */
export function mapMysqlColumnsToFields(columns: MysqlColumn[]) {
  return (columns || []).map((col) => {
    const fieldName = col.Field;
    const fieldType = normalizeMysqlFieldType(col.Type);
    const displayType = mysqlToDisplayType(fieldType);
    const isPrimary = String(col.Key || '').toUpperCase() === 'PRI' ? (1 as const) : (0 as const);
    const desc = col.Comment ?? '';
    return {
      field_name: fieldName,
      custom_name: fieldName,
      field_desc: desc,
      field_type: fieldType,
      display_type: displayType,
      is_primary: isPrimary,
    };
  });
}

/** 将 mysql2 wire protocol 元数据（fields[]）→ Field[] */
export function mapMysqlProtocolFields(
  rawFields: Array<{ name: string; type: number; default?: unknown }>,
) {
  const columns: MysqlColumn[] = (rawFields || []).map((field) => ({
    Field: field.name,
    Type: MYSQL_PROTOCOL_TYPES[field.type] ?? 'text',
    Default: field.default,
  }));
  return mapMysqlColumnsToFields(columns);
}
