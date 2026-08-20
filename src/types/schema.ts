/**
 * 表结构 JSON 导出类型（DDL 的结构化等价物）
 */

export interface TableSchema {
  name: string;
  /** PG schema / MySQL database / SQLite 主库 */
  schema?: string;
  kind: 'table' | 'view' | 'collection';
  comment?: string;
  columns: ColumnSchema[];
  indexes?: IndexSchema[];
  foreignKeys?: ForeignKeySchema[];
  /** MySQL: InnoDB 等 */
  engine?: string;
  /** MySQL */
  charset?: string;
  /** 原始 DDL 字符串（与 JSON 双形态） */
  ddl?: string;
  /** 方言原生信息兜底 */
  raw?: Record<string, unknown>;
}

export interface ColumnSchema {
  name: string;
  /** 原生类型（含长度/精度，如 varchar(255)、numeric(10,2)） */
  type: string;
  nullable: boolean;
  default?: any;
  comment?: string;
  primaryKey: boolean;
  autoIncrement?: boolean;
  /** 列序号（从 1 开始） */
  ordinal: number;
}

export interface IndexSchema {
  name: string;
  unique: boolean;
  /** 按索引内列序 */
  columns: string[];
  /** btree / hash / fulltext / gin 等 */
  type?: string;
}

export interface ForeignKeySchema {
  name?: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** CASCADE / SET NULL / RESTRICT ... */
  onDelete?: string;
  onUpdate?: string;
}
