/**
 * MySQL 驱动（5.7 / 8.x 双版本）
 * 连接池懒创建；分页包装按版本能力矩阵选择 CTE / 派生表；
 * DML 走 ResultSetHeader（affectedRows/insertId）；结构 JSON 检出
 */
import { createConnection } from 'mysql2/promise';
import { SqlEngineError, wrapError } from '../../errors.js';
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
} from '../../core/sql/statement.js';
import { createTask } from '../../types/task.js';
import {
  mapMysqlColumnsToFields,
  mapMysqlProtocolFields,
  type MysqlColumn,
} from '../../core/field-mapper/mysql.js';
import type { SqlDriver, PoolHandle } from '../interface.js';
import type { MysqlConfig, SchemaOptions } from '../../types/config.js';
import type {
  ExecResult,
  ExplainResult,
  QueryResult,
  RunSqlRequest,
  TestResult,
  WriteResult,
} from '../../types/result.js';
import type { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../types/schema.js';
import type { IntrospectTask } from '../../types/task.js';
import type { TransactionHandle } from '../../types/transaction.js';
import { MysqlPoolHandle, buildSslConfig } from './pool.js';

type Knex = Awaited<ReturnType<MysqlPoolHandle['getKnex']>>;

export class MysqlDriver implements SqlDriver {
  readonly dialect: 'mysql' | 'mariadb';

  constructor(dialect: 'mysql' | 'mariadb' = 'mysql') {
    this.dialect = dialect;
  }

  async createPool(config: import('../../types/config.js').ConnectionConfig): Promise<PoolHandle> {
    if (config.type !== this.dialect) {
      throw new SqlEngineError(
        'UNSUPPORTED_DIALECT',
        `${this.dialect} 驱动收到 ${config.type} 配置`,
      );
    }
    return new MysqlPoolHandle(config as MysqlConfig, { isMariaDb: this.dialect === 'mariadb' });
  }

  /** EXPLAIN 执行计划 */
  async explain(pool: PoolHandle, request: RunSqlRequest): Promise<ExplainResult> {
    const handle = pool as MysqlPoolHandle;
    const k = await handle.getKnex();
    const sql = normalizeSql(request.sql);
    const raw = (await k.raw(`EXPLAIN ${sql}`, this.bind(request.params))) as unknown[];
    const rows = (Array.isArray(raw) ? raw[0] : raw) as any[];
    return { dialect: this.dialect, sql, params: request.params, plan: rows };
  }

  // ==================== 连接测试 ====================

  /** knex 参数绑定（RawBinding 类型限制，unknown[] → any[]） */
  private bind(params?: unknown[]): any[] {
    return (params ?? []) as any[];
  }

  async testConnection(config: MysqlConfig): Promise<TestResult> {
    let connection: Awaited<ReturnType<typeof createConnection>> | null = null;
    try {
      connection = await createConnection({
        host: config.host,
        port: Number(config.port ?? 3306),
        user: config.user || config.username,
        password: config.password,
        database: config.database,
        charset: 'utf8mb4',
        ssl: buildSslConfig(config),
        connectTimeout: config.connectTimeout ?? 15000,
      });
      await connection.execute('SELECT 1');
      return { success: true, message: 'MySQL connection test successful' };
    } catch (err) {
      const e = err as Error;
      return { success: false, message: `MySQL connection test failed: ${e.message}` };
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore
        }
      }
    }
  }

  // ==================== 元信息 ====================

  async getTableList(pool: PoolHandle): Promise<string[]> {
    const k = await (pool as MysqlPoolHandle).getKnex();
    const res = (await k.raw('SHOW TABLES')) as unknown[];
    const rows = (Array.isArray(res) ? res[0] : res) as Record<string, unknown>[];
    const names: string[] = [];
    for (const row of rows) {
      const firstKey = Object.keys(row)[0];
      if (firstKey) names.push(String(row[firstKey]));
    }
    return names;
  }

  async getTableDDL(pool: PoolHandle, table: string): Promise<string> {
    const k = await (pool as MysqlPoolHandle).getKnex();
    const res = (await k.raw('SHOW CREATE TABLE ??', [table])) as unknown[];
    const rows = (Array.isArray(res) ? res[0] : res) as Array<{
      'Create Table'?: string;
      'Create View'?: string;
    }>;
    const row = rows[0];
    return row?.['Create Table'] || row?.['Create View'] || '';
  }

  async getPreviewRows(
    pool: PoolHandle,
    table: string,
    offset: number,
    limit: number,
    whereClause?: string,
  ): Promise<any[]> {
    const k = await (pool as MysqlPoolHandle).getKnex();
    let query = k(table).select('*');
    if (whereClause) query = query.whereRaw(whereClause);
    const rows = await query.limit(limit).offset(offset);
    return rows as any[];
  }

  async getColumns(pool: PoolHandle, table: string) {
    const k = await (pool as MysqlPoolHandle).getKnex();
    const res = (await k.raw('SHOW FULL COLUMNS FROM ??', [table])) as unknown[];
    const rows = (Array.isArray(res) ? res[0] : res) as MysqlColumn[];
    return mapMysqlColumnsToFields(rows);
  }

  async getRowsCount(pool: PoolHandle, table: string, whereClause?: string): Promise<number> {
    const k = await (pool as MysqlPoolHandle).getKnex();
    let query = k(table).count<{ total: number }>({ total: '*' });
    if (whereClause) query = query.whereRaw(whereClause);
    const row = await query.first();
    const total = row ? Number((row as any).total) : 0;
    return Number.isNaN(total) ? 0 : total;
  }

  // ==================== SQL 执行 ====================

  async runSql(pool: PoolHandle, request: RunSqlRequest): Promise<ExecResult> {
    const handle = pool as MysqlPoolHandle;
    const k = await handle.getKnex();
    return this.runSqlWithKnex(k, handle, request);
  }

  /** 事务/常规共用执行核心（k 可指定为事务连接） */
  runSqlWithKnex(k: Knex, handle: MysqlPoolHandle, request: RunSqlRequest): Promise<ExecResult> {
    const sql = normalizeSql(request.sql);
    const type = detectStatementType(sql);
    try {
      if (isDmlStatement(type)) {
        return this.runDml(handle, k, sql, request.params, type, request.dml);
      }
      if (type === 'SELECT') {
        return this.runSelect(handle, k, sql, request);
      }
      if (type === 'DDL' || type === 'TRANSACTION') {
        return k.raw(sql, this.bind(request.params)).then((raw: unknown) => {
          const [result] = raw as unknown[];
          const header = result as { affectedRows?: number };
          return { affectedRows: Number(header?.affectedRows ?? 0) };
        });
      }
      throw new SqlEngineError('QUERY_FAILED', `暂不支持执行 ${type} 语句`);
    } catch (err) {
      if (err instanceof SqlEngineError) return Promise.reject(err);
      return Promise.reject(wrapError('QUERY_FAILED', err));
    }
  }

  /** 事务：knex.transaction（fn 抛错自动回滚，成功自动提交） */
  async withTransaction<T>(
    pool: PoolHandle,
    fn: (tx: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    const handle = pool as MysqlPoolHandle;
    const k = await handle.getKnex();
    const self = this;
    return k.transaction(async (trx) => {
      const tx: TransactionHandle = {
        runSql: (req) => self.runSqlWithKnex(trx as Knex, handle, req),
        query: (sql, params) =>
          self.runSqlWithKnex(trx as Knex, handle, { sql, params }) as Promise<QueryResult>,
        execute: (sql, params) =>
          self.runSqlWithKnex(trx as Knex, handle, { sql, params }) as Promise<WriteResult>,
        commit: async () => {
          await (trx.commit() as unknown as Promise<void>);
        },
        rollback: async () => {
          await (trx.rollback() as unknown as Promise<void>);
        },
      };
      return fn(tx);
    });
  }

  // ---- SELECT（分页包装按版本能力矩阵） ----
  private async runSelect(
    handle: MysqlPoolHandle,
    k: Knex,
    sql: string,
    request: RunSqlRequest,
  ) {
    const offset = Math.max(Number(request.offset ?? 0), 0);
    const limit = Math.max(Number(request.limit ?? 100), 0);
    const params = request.params ?? [];
    const caps = await handle.getCapabilities();

    let baseSql = sql;
    if (request.whereClause) {
      baseSql = wrapWithWhereClause(sql, request.whereClause, { supportsCTE: caps.supportsCTE });
    }

    // 用户 SQL 自带分页 → 直接执行，不再二次包装
    if (hasPaginationClause(baseSql, [/\bfetch\s+first\b/i, /\btop\b/i])) {
      const [rows, fields] = (await k.raw(baseSql, this.bind(params))) as unknown[];
      return {
        rows: rows as any[],
        fields: mapMysqlProtocolFields((fields as Array<{ name: string; type: number }>) ?? []),
      };
    }

    const countSql = buildCountSql(baseSql);
    const [countRows] = (await k.raw(countSql, this.bind(params))) as unknown[];
    const countArr = countRows as Array<{ total?: number }>;
    const total = Number(countArr?.[0]?.total ?? 0);

    const pageSql = buildPagedSql(baseSql, limit, offset);
    const [rows, fields] = (await k.raw(pageSql, this.bind(params))) as unknown[];
    return {
      rows: rows as any[],
      fields: mapMysqlProtocolFields((fields as Array<{ name: string; type: number }>) ?? []),
      total: Number.isNaN(total) ? 0 : total,
      offset,
      limit,
    };
  }

  // ---- DML ----
  private async runDml(
    handle: MysqlPoolHandle,
    k: Knex,
    sql: string,
    params: unknown[] | undefined,
    type: DmlStatementType,
    dmlOverride?: import('../../types/config.js').DmlOptions,
  ): Promise<WriteResult> {
    const dml = dmlOverride ?? handle.config.dml ?? {};
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
        throw new SqlEngineError('DML_BLOCKED', `INSERT 行数 ${rows} 超过上限 ${dml.maxInsertRows}`);
      }
    }

    const [result] = (await k.raw(sql, this.bind(args))) as unknown[];
    const header = result as { affectedRows?: number; insertId?: number };
    const writeResult: WriteResult = { affectedRows: Number(header?.affectedRows ?? 0) };

    if (type === 'INSERT' && header?.insertId !== undefined && header?.insertId !== 0) {
      writeResult.insertId = header.insertId;
      // returning=true：按自增主键回读插入行（仅限单自增主键表）
      if (dml.returning) {
        const table = extractInsertTable(sql);
        if (table) {
          const pk = await handle.getPrimaryKeyColumn(table);
          if (pk) {
            const rows = await this.getPreviewRows(handle, table, 0, 1, `${pk} = ${Number(header.insertId)}`);
            writeResult.returning = rows;
          }
        }
      }
    }
    return writeResult;
  }

  // ==================== 结构 JSON 检出 ====================

  async getTableSchema(pool: PoolHandle, table: string): Promise<TableSchema> {
    const handle = pool as MysqlPoolHandle;
    const k = await handle.getKnex();

    // 字段
    const colRes = (await k.raw('SHOW FULL COLUMNS FROM ??', [table])) as unknown[];
    const columns = (Array.isArray(colRes) ? colRes[0] : colRes) as Array<{
      Field: string;
      Type: string;
      Null: 'YES' | 'NO';
      Key: string;
      Default: any;
      Extra: string;
      Comment: string;
    }>;
    if (!columns.length) {
      throw new SqlEngineError('TABLE_NOT_FOUND', `表 ${table} 不存在`);
    }

    // 索引
    const idxRes = (await k.raw('SHOW INDEX FROM ??', [table])) as unknown[];
    const idxRows = (Array.isArray(idxRes) ? idxRes[0] : idxRes) as Array<{
      Key_name: string;
      Non_unique: number;
      Seq_in_index: number;
      Column_name: string | null;
      Index_type: string;
    }>;
    const indexMap = new Map<string, IndexSchema>();
    for (const r of idxRows) {
      let idx = indexMap.get(r.Key_name);
      if (!idx) {
        idx = { name: r.Key_name, unique: r.Non_unique === 0, columns: [], type: r.Index_type };
        indexMap.set(r.Key_name, idx);
      }
      if (r.Column_name) idx.columns.push(r.Column_name);
    }

    // 外键
    const fkRes = (await k.raw(
      `SELECT kcu.constraint_name AS constraint_name, kcu.column_name AS column_name,
              kcu.referenced_table_name AS referenced_table_name, kcu.referenced_column_name AS referenced_column_name,
              rc.delete_rule AS delete_rule, rc.update_rule AS update_rule
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON kcu.constraint_name = rc.constraint_name AND kcu.table_schema = rc.constraint_schema
       WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL
       ORDER BY kcu.constraint_name, kcu.ordinal_position`,
      [table],
    )) as unknown[];
    const fkRows = (Array.isArray(fkRes) ? fkRes[0] : fkRes) as Array<{
      constraint_name: string;
      column_name: string;
      referenced_table_name: string;
      referenced_column_name: string;
      delete_rule: string;
      update_rule: string;
    }>;
    const fkMap = new Map<string, ForeignKeySchema>();
    for (const r of fkRows) {
      let fk = fkMap.get(r.constraint_name);
      if (!fk) {
        fk = {
          name: r.constraint_name,
          columns: [],
          refTable: r.referenced_table_name,
          refColumns: [],
          onDelete: r.delete_rule || undefined,
          onUpdate: r.update_rule || undefined,
        };
        fkMap.set(r.constraint_name, fk);
      }
      fk.columns.push(r.column_name);
      fk.refColumns.push(r.referenced_column_name);
    }

    // 引擎/字符集/表注释
    const tblRes = (await k.raw(
      `SELECT engine AS engine, table_collation AS table_collation, table_comment AS table_comment
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    )) as unknown[];
    const tblRows = (Array.isArray(tblRes) ? tblRes[0] : tblRes) as Array<{
      engine?: string;
      table_collation?: string;
      table_comment?: string;
    }>;
    const tbl = tblRows[0];

    // 原始 DDL
    const ddl = await this.getTableDDL(handle, table);

    const columnSchemas: ColumnSchema[] = columns.map((c, i) => ({
      name: c.Field,
      type: c.Type,
      nullable: c.Null !== 'NO',
      default: c.Default,
      comment: c.Comment,
      primaryKey: String(c.Key || '').toUpperCase() === 'PRI',
      autoIncrement: /auto_increment/i.test(c.Extra || ''),
      ordinal: i + 1,
    }));

    return {
      name: table,
      schema: handle.config.database,
      kind: 'table',
      comment: tbl?.table_comment || undefined,
      columns: columnSchemas,
      indexes: [...indexMap.values()],
      foreignKeys: [...fkMap.values()],
      engine: tbl?.engine,
      charset: tbl?.table_collation,
      ddl,
      raw: {},
    };
  }

  getAllTableSchemas(pool: PoolHandle, opts?: SchemaOptions): IntrospectTask<TableSchema[]> {
    const handle = pool as MysqlPoolHandle;
    const self = this;
    return createTask<TableSchema[]>(async (ctx) => {
      const tables = await self.getTableList(handle);
      const total = tables.length;
      const schemas: TableSchema[] = [];
      for (let i = 0; i < tables.length; i++) {
        if (ctx.isCancelled()) break;
        ctx.report({ stage: 'introspecting', processed: i, total, message: tables[i] });
        try {
          schemas.push(await self.getTableSchema(handle, tables[i]!));
        } catch {
          // 单表失败不中断整体导出
        }
      }
      void opts;
      return schemas;
    });
  }
}

/** 从 INSERT 语句提取目标表名（returning 回读用） */
function extractInsertTable(sql: string): string | null {
  const m = sql.match(/\bINSERT\s+INTO\s+([`"\[]?[^\s`"\[(]+[`"\]]?)/i);
  if (!m) return null;
  return String(m[1]!).replace(/[`"[\]]/g, '');
}

export const mysqlDriver = new MysqlDriver('mysql');
export const mariadbDriver = new MysqlDriver('mariadb');
