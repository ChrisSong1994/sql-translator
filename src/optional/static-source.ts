/**
 * 静态数据源扩展（从 WizBuild 提炼）：JSON 数组 → SQLite 表 + SQL 表名映射执行
 * 独立模块（Tree-shake 友好），主包不强制加载
 *
 * 典型场景：Excel/CSV/JSON 数据源导入 SQLite 物理表，
 * 用户 SQL 中的逻辑表名经映射替换为物理表名后执行。
 */
import { SqlEngineError } from '../errors.js';
import { getDriver } from '../driver/registry.js';
import type { SqlitePoolHandle } from '../driver/sqlite/index.js';
import { getSqliteBackend, releaseSqliteBackend } from '../driver/sqlite/store.js';
import { replaceTableNamesInSql, validateTableNameReplacement } from '../core/sql/table-mapper.js';
import { wrapWithWhereClause } from '../core/sql/pagination.js';
import type { ConnectionConfig, SqliteConfig } from '../types/config.js';
import type { ExecResult, RunSqlRequest } from '../types/result.js';
import type { PoolHandle } from '../driver/interface.js';

// ==================== 表结构推断 ====================

/** 字段类型 → SQLite 类型 */
function fieldTypeToSqliteType(fieldType: string): string {
  const typeMap: Record<string, string> = {
    string: 'TEXT',
    number: 'REAL',
    integer: 'INTEGER',
    float: 'REAL',
    boolean: 'INTEGER',
    date: 'TEXT',
    array: 'TEXT',
    object: 'TEXT',
  };
  return typeMap[fieldType] || 'TEXT';
}

/** 值类型推断 */
function inferValueType(value: any): string {
  if (value === null || value === undefined) return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

/** 根据字段配置或数据推断表结构 */
function inferTableSchema(
  rows: Record<string, any>[],
  fields?: Array<{ field_name: string; field_type: string }>,
): { columns: string; columnNames: string[] } {
  if (fields && fields.length > 0) {
    const columns = fields
      .map((f) => `"${f.field_name}" ${fieldTypeToSqliteType(f.field_type)}`)
      .join(', ');
    return { columns, columnNames: fields.map((f) => f.field_name) };
  }
  if (rows.length === 0) {
    throw new SqlEngineError('QUERY_FAILED', '无法推断数据结构，数据为空');
  }
  const firstRow = rows[0]!;
  const columnNames = Object.keys(firstRow);
  const columns = columnNames
    .map((name) => {
      const value = firstRow[name];
      return `"${name}" ${fieldTypeToSqliteType(inferValueType(value))}`;
    })
    .join(', ');
  return { columns, columnNames };
}

// ==================== 数据导入 ====================

/** 建表并导入数据（表已存在则先删后建） */
export async function importDataToSqlite(
  pool: PoolHandle,
  tableName: string,
  rows: Record<string, any>[],
  fields?: Array<{ field_name: string; field_type: string }>,
): Promise<void> {
  const handle = pool as SqlitePoolHandle;
  const backend = await handle.getBackend();
  const { columns, columnNames } = inferTableSchema(rows, fields);

  backend.exec(`DROP TABLE IF EXISTS "${tableName}"`);
  backend.exec(`CREATE TABLE "${tableName}" (${columns})`);

  const placeholders = columnNames.map(() => '?').join(', ');
  const quotedColumns = columnNames.map((n) => `"${n}"`).join(', ');
  const insertSql = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES (${placeholders})`;
  const stmt = backend.prepare(insertSql);

  backend.exec('BEGIN TRANSACTION');
  try {
    for (const row of rows) {
      const values = columnNames.map((name) => {
        const value = row[name];
        if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
          return JSON.stringify(value);
        }
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value ?? null;
      });
      stmt.run(...values);
    }
    backend.exec('COMMIT');
  } catch (err) {
    backend.exec('ROLLBACK');
    throw err;
  }
}

/** 删除静态表 */
export async function dropStaticTable(pool: PoolHandle, tableName: string): Promise<void> {
  const handle = pool as SqlitePoolHandle;
  const backend = await handle.getBackend();
  backend.exec(`DROP TABLE IF EXISTS "${tableName}"`);
}

// ==================== SQL 执行（表名映射） ====================

export interface StaticTableInfo {
  /** 逻辑表名（用户 SQL 中的名称） */
  name: string;
  /** 数据源名（用于 "数据源名.表名" schema 限定匹配） */
  datasourceName?: string;
  /** SQLite 物理表名 */
  sqliteTableName: string;
}

/**
 * 执行静态数据源 SQL：逻辑表名 → 物理表名替换后交给 SQLite 驱动
 * @param pool sqlite 连接池
 * @param request SQL 请求（offset/limit/whereClause 与常规一致）
 * @param tablesInfo 表映射信息
 */
export async function runStaticSql(
  pool: PoolHandle,
  request: RunSqlRequest,
  tablesInfo: StaticTableInfo[],
): Promise<ExecResult> {
  const handle = pool as SqlitePoolHandle;
  const tableNameMapping = new Map<string, string>();
  for (const table of tablesInfo) {
    if (table.datasourceName) {
      tableNameMapping.set(`${table.datasourceName}.${table.name}`, table.sqliteTableName);
    }
    tableNameMapping.set(table.name, table.sqliteTableName);
  }

  // 表名替换
  const replacedSql = replaceTableNamesInSql(request.sql, tableNameMapping);
  const validation = validateTableNameReplacement(request.sql, replacedSql, tableNameMapping);
  if (!validation.valid) {
    console.warn('[static-source] SQL 表名替换校验异常:', validation.warnings);
  }

  const sqliteDriver = getDriver('sqlite');
  return sqliteDriver.runSql(pool, {
    ...request,
    sql: replacedSql,
  });
}

// ==================== 便捷：SQLite 池获取 ====================

/** 创建独立 sqlite 池（静态数据源专用，独立于全局注册表） */
export async function createStaticSqlitePool(
  config: SqliteConfig,
  options?: { runtime?: ConnectionConfig['runtime'] },
): Promise<PoolHandle> {
  const driver = getDriver('sqlite');
  const cfg: SqliteConfig = { ...config, ...(options?.runtime ? { runtime: options.runtime } : {}) };
  return driver.createPool(cfg);
}

/** 释放独立池（仅用于 createStaticSqlitePool 创建的池） */
export async function destroyStaticSqlitePool(pool: PoolHandle): Promise<void> {
  await pool.destroy();
}

export { getSqliteBackend, releaseSqliteBackend };
export type { SqlitePoolHandle };
