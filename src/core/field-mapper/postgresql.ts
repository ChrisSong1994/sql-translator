/**
 * PostgreSQL 字段映射（迁移自 WizBuild postgresql-analyzer.ts）
 */
export interface PostgresColumn {
  Field: string;
  Type: string;
  Null?: 'YES' | 'NO';
  Key?: string;
  Default?: any;
  Comment?: string;
}

/** PostgreSQL 类型 → 统一展示类型 */
export function postgresToDisplayType(pgType: string): string {
  const t = String(pgType).toLowerCase();
  // 字符类型
  if (
    t.startsWith('character varying') ||
    t.startsWith('varchar') ||
    t.startsWith('char') ||
    t.startsWith('character') ||
    t === 'text'
  )
    return 'string';
  // 整数类型（含 pg_type.typname 内部名称）
  if (
    t === 'smallint' ||
    t === 'integer' ||
    t === 'int' ||
    t === 'bigint' ||
    t === 'smallserial' ||
    t === 'serial' ||
    t === 'bigserial' ||
    t === 'int2' ||
    t === 'int4' ||
    t === 'int8' ||
    t === 'serial2' ||
    t === 'serial4' ||
    t === 'serial8'
  )
    return 'number';
  // 浮点/定点类型
  if (
    t.startsWith('decimal') ||
    t.startsWith('numeric') ||
    t === 'real' ||
    t === 'double precision' ||
    t.startsWith('float') ||
    t === 'float4' ||
    t === 'float8'
  )
    return 'number';
  // 布尔类型
  if (t === 'boolean' || t === 'bool') return 'boolean';
  // 日期时间类型
  if (
    t === 'date' ||
    t.startsWith('timestamp') ||
    t.startsWith('time') ||
    t === 'interval' ||
    t === 'timestamptz' ||
    t === 'timetz'
  )
    return 'date';
  // JSON 类型
  if (t === 'json' || t === 'jsonb') return 'json';
  // 二进制类型
  if (t === 'bytea') return 'binary';
  // UUID、数组、复合类型等
  if (t === 'uuid') return 'string';
  if (t.startsWith('array')) return 'string';
  // 枚举类型（typname 通常自定义名）
  if (t.endsWith('_enum') || t === 'user-defined') return 'string';
  return 'string';
}

/** pg_type.typname（内部名称）→ information_schema.data_type 格式 */
const PG_INTERNAL_TYPE_MAP: Record<string, string> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  serial2: 'smallserial',
  serial4: 'serial',
  serial8: 'bigserial',
  float4: 'real',
  float8: 'double precision',
  bool: 'boolean',
  varchar: 'character varying',
  bpchar: 'character',
  text: 'text',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  date: 'date',
  numeric: 'numeric',
  json: 'json',
  jsonb: 'jsonb',
  bytea: 'bytea',
  uuid: 'uuid',
  interval: 'interval',
};

/** 将 pg_type.typname 映射为 information_schema 风格的 data_type */
export function normalizePostgresFieldType(typname: string): string {
  const lower = typname.toLowerCase();
  if (PG_INTERNAL_TYPE_MAP[lower]) return PG_INTERNAL_TYPE_MAP[lower]!;
  if (lower.startsWith('varchar')) return 'character varying';
  if (lower.startsWith('bpchar')) return 'character';
  if (lower.startsWith('numeric')) return 'numeric';
  if (lower.startsWith('_')) return 'ARRAY';
  return typname;
}

/** information_schema.columns 行 → Field[] */
export function mapPostgresColumnsToFields(columns: PostgresColumn[]) {
  return (columns || []).map((col) => {
    const fieldName = col.Field;
    const fieldType = normalizePostgresFieldType(col.Type);
    const displayType = postgresToDisplayType(fieldType);
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
