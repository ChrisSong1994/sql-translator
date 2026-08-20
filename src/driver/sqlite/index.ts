/**
 * SQLite 驱动（Node ≥ 22.5 node:sqlite / Bun bun:sqlite）
 * 提供完整垂直切片：连接池 / 连接测试 / SELECT+DML / 元信息 / 结构 JSON 检出
 */
import { resolveRuntime } from '../../runtime.js';
import { SqlEngineError, wrapError } from '../../errors.js';
import { fingerprintConfig, normalizeConfig } from '../../core/config.js';
import { normalizeSql } from '../../core/sql/normalize.js';
import {
  hasPaginationClause,
  buildPagedSql,
  buildCountSql,
  wrapWithWhereClause,
} from '../../core/sql/pagination.js';
import {
  detectStatementType,
  isDmlStatement,
  hasDmlWhere,
  countInsertValueRows,
  type DmlStatementType,
  type StatementType,
} from '../../core/sql/statement.js';
import type { PoolHandle, SqlDriver } from '../interface.js';
import type { SqliteConfig } from '../../types/config.js';
import type {
  ExecResult,
  Field,
  RunSqlRequest,
  TestResult,
  WriteResult,
} from '../../types/result.js';
import type { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../types/schema.js';
import type { IntrospectTask } from '../../types/task.js';
import { createTask } from '../../types/task.js';
import { getSqliteBackend, releaseSqliteBackend } from './store.js';
import type { SqliteBackend } from './backend.js';

// ==================== 连接池句柄 ====================

class SqlitePoolHandle implements PoolHandle {
  readonly fingerprint: string;
  readonly config: SqliteConfig;
  private backend: SqliteBackend | null = null;
  private destroyedFlag = false;

  constructor(config: SqliteConfig) {
    this.config = normalizeConfig(config) as SqliteConfig;
    this.fingerprint = fingerprintConfig(this.config);
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** @internal 获取后端（惰性创建，异步因为 bun:sqlite 需动态导入） */
  private backendPromise: Promise<SqliteBackend> | null = null;

  async getBackend(): Promise<SqliteBackend> {
    this.backendPromise ??= getSqliteBackend(
      this.config.database,
      resolveRuntime(this.config.runtime),
    );
    this.backend = await this.backendPromise;
    return this.backend;
  }

  get stats() {
    return {
      active: this.backend ? 1 : 0,
      idle: this.backend ? 1 : 0,
      waiting: 0,
      createdTotal: 1,
      destroyedTotal: this.destroyed ? 1 : 0,
    };
  }

  async ping(): Promise<void> {
    (await this.getBackend()).exec('SELECT 1');
  }

  async destroy(): Promise<void> {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    if (this.backend) {
      const runtime = resolveRuntime(this.config.runtime);
      if (this.config.database === ':memory:') {
        try {
          this.backend.close();
        } catch {
          // ignore
        }
      } else {
        releaseSqliteBackend(this.config.database, runtime);
      }
      this.backend = null;
      this.backendPromise = null;
    }
  }
}

// ==================== 类型映射 ====================

/** SQLite 类型 → 统一字段类型 */
function sqliteTypeToFieldType(sqliteType: string): string {
  const upperType = (sqliteType || 'TEXT').toUpperCase();
  if (upperType.includes('INT')) return 'integer';
  if (upperType.includes('REAL') || upperType.includes('FLOAT') || upperType.includes('DOUBLE'))
    return 'float';
  if (
    upperType.includes('TEXT') ||
    upperType.includes('CHAR') ||
    upperType.includes('VARCHAR') ||
    upperType.includes('CLOB')
  )
    return 'string';
  if (upperType.includes('BLOB')) return 'string';
  if (upperType.includes('DATE') || upperType.includes('TIME')) return 'date';
  return 'string';
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

/** 展示类型推断 */
function inferDisplayType(fieldName: string, fieldType: string): string {
  const nameLower = (fieldName || '').toLowerCase();
  if (nameLower.includes('image') || nameLower.includes('img') || nameLower.includes('avatar'))
    return 'image';
  if (nameLower.includes('url') || nameLower.includes('link')) return 'link';
  if (nameLower.includes('date') || nameLower.includes('time') || nameLower.includes('_at'))
    return 'date';
  if (nameLower.includes('status') || nameLower.includes('type') || nameLower.includes('tag'))
    return 'tag';
  if (fieldType === 'integer' || fieldType === 'float') return 'number';
  if (fieldType === 'boolean') return 'boolean';
  return 'text';
}

/** 从结果行推断字段 */
function inferFieldsFromRows(rows: any[]): Field[] {
  if (!rows.length) return [];
  const first = rows[0] ?? {};
  return Object.keys(first).map((key) => {
    const value = first[key];
    const fieldType = inferValueType(value);
    return {
      field_name: key,
      custom_name: key,
      field_desc: '',
      field_type: fieldType,
      display_type: fieldType === 'string' ? inferDisplayType(key, fieldType) : fieldType,
    };
  });
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ==================== 驱动实现 ====================

export class SqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite';

  async createPool(config: SqliteConfig): Promise<PoolHandle> {
    if (config.type !== 'sqlite') {
      throw new SqlEngineError('UNSUPPORTED_DIALECT', `sqlite 驱动收到 ${config.type} 配置`);
    }
    return new SqlitePoolHandle(config);
  }

  async testConnection(config: SqliteConfig): Promise<TestResult> {
    try {
      const normalized = normalizeConfig(config) as SqliteConfig;
      const runtime = resolveRuntime(normalized.runtime);
      const backend = await getSqliteBackend(normalized.database, runtime);
      backend.exec('SELECT 1');
      if (normalized.database === ':memory:') backend.close();
      else releaseSqliteBackend(normalized.database, runtime);
      return { success: true, message: 'SQLite connection test successful' };
    } catch (err) {
      const e = err as Error;
      return { success: false, message: `SQLite connection test failed: ${e.message}` };
    }
  }

  async runSql(pool: PoolHandle, request: RunSqlRequest): Promise<ExecResult> {
    try {
      const handle = pool as SqlitePoolHandle;
      const backend = await handle.getBackend();
      const sql = normalizeSql(request.sql);
      const type = detectStatementType(sql);

      if (isDmlStatement(type)) {
        return this.runDml(handle, backend, sql, request.params, type);
      }
      if (type === 'SELECT') {
        return this.runSelect(backend, sql, request);
      }
      if (type === 'DDL' || type === 'TRANSACTION') {
        // DDL / 事务控制语句透传执行（返回受影响行数）
        const r = backend.prepare(sql).run(...(request.params ?? []));
        return { affectedRows: r.changes };
      }
      throw new SqlEngineError('QUERY_FAILED', `暂不支持执行 ${type} 语句`);
    } catch (err) {
      if (err instanceof SqlEngineError) throw err;
      throw wrapError('QUERY_FAILED', err);
    }
  }

  // ---- SELECT ----
  private runSelect(
    backend: SqliteBackend,
    sql: string,
    request: RunSqlRequest,
  ): { rows: any[]; fields: Field[]; total: number; offset: number; limit: number } {
    const offset = Math.max(Number(request.offset ?? 0), 0);
    const limit = Math.max(Number(request.limit ?? 100), 0);
    const params = request.params ?? [];

    let base = sql;
    if (request.whereClause) {
      base = wrapWithWhereClause(sql, request.whereClause, { supportsCTE: true });
    }

    // 用户 SQL 自带分页：直接执行，total 用 rows.length 近似
    if (hasPaginationClause(base, [/\bfetch\s+first\b/i])) {
      const rows = backend.prepare(base).all(...params) as any[];
      return { rows, fields: inferFieldsFromRows(rows), total: rows.length, offset, limit };
    }

    const countRow = backend.prepare(buildCountSql(base)).get(...params) as { total?: number };
    const total = Number(countRow?.total ?? 0);
    const rows = backend.prepare(buildPagedSql(base, limit, offset)).all(...params) as any[];
    return { rows, fields: inferFieldsFromRows(rows), total, offset, limit };
  }

  // ---- DML ----
  private runDml(
    handle: SqlitePoolHandle,
    backend: SqliteBackend,
    sql: string,
    params: unknown[] | undefined,
    type: DmlStatementType,
  ): WriteResult {
    const dml = handle.config.dml ?? {};
    const args = params ?? [];

    // 安全护栏：无 WHERE 的 UPDATE/DELETE
    if (
      (type === 'UPDATE' || type === 'DELETE') &&
      dml.requireWhereForUpdateDelete !== false &&
      !hasDmlWhere(sql)
    ) {
      throw new SqlEngineError(
        'DML_BLOCKED',
        `禁止无 WHERE 的 ${type}（config.dml.requireWhereForUpdateDelete 可关闭）`,
      );
    }
    // 批量插入上限
    if (type === 'INSERT' && dml.maxInsertRows) {
      const rows = countInsertValueRows(sql);
      if (rows > dml.maxInsertRows) {
        throw new SqlEngineError(
          'DML_BLOCKED',
          `INSERT 行数 ${rows} 超过上限 ${dml.maxInsertRows}`,
        );
      }
    }

    const result: WriteResult = { affectedRows: 0 };

    if (type === 'INSERT') {
      if (dml.returning) {
        const rows = backend.prepare(`${sql} RETURNING *`).all(...args) as any[];
        result.affectedRows = rows.length;
        result.returning = rows;
        // 自增主键：INSERT RETURNING 后单独查
        const idRow = backend.prepare('SELECT last_insert_rowid() AS id').get() as { id?: number };
        result.insertId = Number(idRow?.id ?? 0);
      } else {
        const r = backend.prepare(sql).run(...args);
        result.affectedRows = r.changes;
        result.insertId = r.lastInsertRowid;
      }
      return result;
    }

    // UPDATE / DELETE
    if (dml.returning) {
      const rows = backend.prepare(`${sql} RETURNING *`).all(...args) as any[];
      result.affectedRows = rows.length;
      result.returning = rows;
    } else {
      const r = backend.prepare(sql).run(...args);
      result.affectedRows = r.changes;
    }
    return result;
  }

  // ---- 元信息 ----
  async getTableList(pool: PoolHandle): Promise<string[]> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    const rows = backend
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => String(r.name));
  }

  async getTableDDL(pool: PoolHandle, table: string): Promise<string> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    const row = backend
      .prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')`)
      .get(table) as { sql?: string } | undefined;
    return row?.sql ?? '';
  }

  async getPreviewRows(
    pool: PoolHandle,
    table: string,
    offset: number,
    limit: number,
    whereClause?: string,
  ): Promise<any[]> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    let sql = `SELECT * FROM ${quoteIdent(table)}`;
    if (whereClause) sql += ` WHERE ${whereClause}`;
    sql += ` LIMIT ${Math.max(limit, 0)} OFFSET ${Math.max(offset, 0)}`;
    return backend.prepare(sql).all() as any[];
  }

  async getColumns(pool: PoolHandle, table: string): Promise<Field[]> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    const rows = backend.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    return rows.map((r) => {
      const fieldType = sqliteTypeToFieldType(r.type);
      return {
        field_name: r.name,
        custom_name: r.name,
        field_desc: '',
        field_type: fieldType,
        display_type: inferDisplayType(r.name, fieldType),
        is_primary: r.pk ? 1 : 0,
      };
    });
  }

  async getRowsCount(pool: PoolHandle, table: string, whereClause?: string): Promise<number> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    let sql = `SELECT COUNT(*) AS total FROM ${quoteIdent(table)}`;
    if (whereClause) sql += ` WHERE ${whereClause}`;
    const row = backend.prepare(sql).get() as { total?: number };
    return Number(row?.total ?? 0);
  }

  async getTableSchema(pool: PoolHandle, table: string): Promise<TableSchema> {
    const backend = await (pool as SqlitePoolHandle).getBackend();
    const q = quoteIdent(table);

    const info = backend.prepare(`PRAGMA table_info(${q})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: any;
      pk: number;
    }>;
    if (!info.length) {
      throw new SqlEngineError('TABLE_NOT_FOUND', `表 ${table} 不存在`);
    }

    const ddlRow = backend.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as
      | { sql?: string }
      | undefined;
    const ddl = ddlRow?.sql ?? '';

    const indexes: IndexSchema[] = [];
    const idxList = backend.prepare(`PRAGMA index_list(${q})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    for (const idx of idxList) {
      const cols = backend
        .prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`)
        .all() as Array<{ name: string }>;
      indexes.push({
        name: idx.name,
        unique: !!idx.unique,
        columns: cols.map((c) => String(c.name)),
        type: idx.origin === 'pk' ? 'primary' : idx.origin === 'u' ? 'unique' : undefined,
      });
    }

    const foreignKeys: ForeignKeySchema[] = (
      backend.prepare(`PRAGMA foreign_key_list(${q})`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
      }>
    )
      .filter((r) => r.seq === 0) // 复合外键只取第一列组合（完整组合支持留后续）
      .map((r) => ({
        name: `fk_${table}_${r.id}`,
        columns: [r.from],
        refTable: r.table,
        refColumns: [r.to ?? ''],
        onUpdate: r.on_update || undefined,
        onDelete: r.on_delete || undefined,
      }));

    const columns: ColumnSchema[] = info.map((r) => ({
      name: r.name,
      type: String(r.type || 'TEXT'),
      nullable: r.notnull === 0,
      default: r.dflt_value,
      comment: '',
      primaryKey: r.pk > 0,
      autoIncrement: /AUTOINCREMENT/i.test(ddl),
      ordinal: r.cid + 1,
    }));

    return {
      name: table,
      schema: 'main',
      kind: 'table',
      columns,
      indexes,
      foreignKeys,
      ddl,
      raw: {},
    };
  }

  getAllTableSchemas(pool: PoolHandle): IntrospectTask<TableSchema[]> {
    // SQLite 检出毫秒级，但统一走长任务执行器（进度/取消语义一致）
    const self = this;
    return createTask<TableSchema[]>(async (ctx) => {
      const tables = await self.getTableList(pool);
      const total = tables.length;
      const schemas: TableSchema[] = [];
      for (let i = 0; i < tables.length; i++) {
        if (ctx.isCancelled()) break;
        ctx.report({ stage: 'introspecting', processed: i, total, message: tables[i] });
        schemas.push(await self.getTableSchema(pool, tables[i]!));
      }
      return schemas;
    });
  }
}

/** SQLite 驱动单例 */
export const sqliteDriver = new SqliteDriver();
