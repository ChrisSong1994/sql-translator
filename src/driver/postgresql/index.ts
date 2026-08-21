/**
 * PostgreSQL 驱动
 * 元数据：pg_tables / information_schema / pg_type OID 解析
 * 执行：SELECT 分页（CTE 包装）、DML（rowCount + RETURNING）、DDL 透传
 */
import knex from 'knex';
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
import { mapPostgresColumnsToFields } from '../../core/field-mapper/postgresql.js';
import type { SqlDriver, PoolHandle } from '../interface.js';
import type { PostgresqlConfig, SchemaOptions } from '../../types/config.js';
import type {
  ExecResult,
  Field,
  RunSqlRequest,
  TestResult,
  WriteResult,
} from '../../types/result.js';
import type { ColumnSchema, ForeignKeySchema, IndexSchema, TableSchema } from '../../types/schema.js';
import type { IntrospectTask } from '../../types/task.js';
import { PostgresqlPoolHandle, buildPgSslConfig } from './pool.js';

type Knex = Awaited<ReturnType<PostgresqlPoolHandle['getKnex']>>;

/** PG $n 占位符 → knex '?'（knex pg 只支持 ? bindings） */
export function pgParamsToQuestion(sql: string): string {
  return String(sql).replace(/\$(\d+)/g, '?');
}

/** pg 驱动返回的 field 元数据 */
interface PgRawField {
  name: string;
  dataTypeID: number;
}

/** 批量解析 OID → typname */
async function resolvePostgresTypeOids(k: Knex, oids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!oids.length) return map;
  const res = (await k.raw('SELECT oid, typname FROM pg_type WHERE oid = ANY(?)', [oids])) as {
    rows?: Array<{ oid: number; typname: string }>;
  };
  for (const row of res.rows || []) map.set(row.oid, row.typname);
  return map;
}

export class PostgresqlDriver implements SqlDriver {
  readonly dialect = 'postgresql';

  async createPool(config: PostgresqlConfig): Promise<PoolHandle> {
    if (config.type !== 'postgresql') {
      throw new SqlEngineError('UNSUPPORTED_DIALECT', `postgresql 驱动收到 ${config.type} 配置`);
    }
    return new PostgresqlPoolHandle(config);
  }

  // ==================== 连接测试 ====================

  async testConnection(config: PostgresqlConfig): Promise<TestResult> {
    let k: Knex | null = null;
    try {
      k = knex({
        client: 'pg',
        connection: {
          host: config.host,
          port: Number(config.port ?? 5432),
          user: config.user || config.username,
          password: config.password,
          database: config.database,
          ssl: buildPgSslConfig(config),
          connectionTimeoutMillis: 5000,
        },
      });
      await k.raw('SELECT 1');
      return { success: true, message: 'PostgreSQL connection test successful' };
    } catch (err) {
      const e = err as Error;
      return { success: false, message: `PostgreSQL connection test failed: ${e.message}` };
    } finally {
      if (k) {
        try {
          await k.destroy();
        } catch {
          // ignore
        }
      }
    }
  }

  // ==================== 元信息 ====================

  async getTableList(pool: PoolHandle): Promise<string[]> {
    const k = await (pool as PostgresqlPoolHandle).getKnex();
    const schema = (pool as PostgresqlPoolHandle).config.schema || 'public';
    const res = (await k.raw(
      'SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename',
      [schema],
    )) as { rows?: Array<{ tablename: string }> };
    return (res.rows || []).map((r) => r.tablename);
  }

  async getTableDDL(pool: PoolHandle, table: string): Promise<string> {
    const k = await (pool as PostgresqlPoolHandle).getKnex();
    const schema = (pool as PostgresqlPoolHandle).config.schema || 'public';
    const res = (await k.raw(
      `SELECT column_name, data_type, character_maximum_length,
              numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [schema, table],
    )) as { rows?: Array<Record<string, unknown>> };
    const columns = res.rows || [];
    if (!columns.length) return '';
    const lines = columns.map((col: any) => {
      let typeStr = col.data_type;
      if (col.character_maximum_length) typeStr += `(${col.character_maximum_length})`;
      if (col.numeric_precision && col.numeric_scale)
        typeStr += `(${col.numeric_precision},${col.numeric_scale})`;
      const nullable = col.is_nullable === 'YES' ? '' : ' NOT NULL';
      const defaultVal = col.column_default ? ` DEFAULT ${col.column_default}` : '';
      return `  "${col.column_name}" ${typeStr}${nullable}${defaultVal}`;
    });
    return `CREATE TABLE "${table}" (\n${lines.join(',\n')}\n);`;
  }

  async getPreviewRows(
    pool: PoolHandle,
    table: string,
    offset: number,
    limit: number,
    whereClause?: string,
  ): Promise<any[]> {
    const k = await (pool as PostgresqlPoolHandle).getKnex();
    let query = k(table).select('*');
    if (whereClause) query = query.whereRaw(whereClause);
    const rows = await query.limit(limit).offset(offset);
    return rows as any[];
  }

  async getColumns(pool: PoolHandle, table: string): Promise<Field[]> {
    const k = await (pool as PostgresqlPoolHandle).getKnex();
    const schema = (pool as PostgresqlPoolHandle).config.schema || 'public';
    const res = (await k.raw(
      `SELECT
         c.column_name AS "Field",
         c.data_type AS "Type",
         c.is_nullable AS "Null",
         c.column_default AS "Default",
         col_description(
           (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
           c.ordinal_position
         ) AS "Comment",
         (CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = ?
             AND kcu.table_name = ?
             AND kcu.column_name = c.column_name
         ) THEN 'PRI' ELSE '' END) AS "Key"
       FROM information_schema.columns c
       WHERE c.table_schema = ? AND c.table_name = ?
       ORDER BY c.ordinal_position`,
      [schema, table, schema, table],
    )) as { rows?: Array<Record<string, unknown>> };
    return mapPostgresColumnsToFields((res.rows || []) as any[]);
  }

  async getRowsCount(pool: PoolHandle, table: string, whereClause?: string): Promise<number> {
    const k = await (pool as PostgresqlPoolHandle).getKnex();
    let query = k(table).count<{ total: string }>({ total: '*' });
    if (whereClause) query = query.whereRaw(whereClause);
    const row = await query.first();
    const total = row ? Number(row.total) : 0;
    return Number.isNaN(total) ? 0 : total;
  }

  // ==================== SQL 执行 ====================

  async runSql(pool: PoolHandle, request: RunSqlRequest): Promise<ExecResult> {
    const handle = pool as PostgresqlPoolHandle;
    const k = await handle.getKnex();
    const sql = pgParamsToQuestion(normalizeSql(request.sql));
    const type = detectStatementType(sql);
    try {
      if (isDmlStatement(type)) {
        return await this.runDml(handle, k, sql, request.params, type, request.dml);
      }
      if (type === 'SELECT') {
        return await this.runSelect(k, sql, request);
      }
      if (type === 'DDL' || type === 'TRANSACTION') {
        const res = (await k.raw(sql, this.bind(request.params))) as { rowCount?: number };
        return { affectedRows: Number(res.rowCount ?? 0) };
      }
      throw new SqlEngineError('QUERY_FAILED', `暂不支持执行 ${type} 语句`);
    } catch (err) {
      if (err instanceof SqlEngineError) throw err;
      throw wrapError('QUERY_FAILED', err);
    }
  }

  private bind(params?: unknown[]): any[] {
    return (params ?? []) as any[];
  }

  private async runSelect(
    k: Knex,
    sql: string,
    request: RunSqlRequest,
  ): Promise<{ rows: any[]; fields: Field[]; total: number; offset: number; limit: number }> {
    const offset = Math.max(Number(request.offset ?? 0), 0);
    const limit = Math.max(Number(request.limit ?? 100), 0);
    const params = this.bind(request.params);

    let baseSql = sql;
    if (request.whereClause) {
      baseSql = wrapWithWhereClause(sql, request.whereClause, { supportsCTE: true }); // PG 8.4+
    }

    // 用户 SQL 自带分页 → 直接执行
    if (hasPaginationClause(baseSql, [/\bfetch\s+first\b/i, /\btop\b/i])) {
      const res = (await k.raw(baseSql, params)) as { rows: any[]; fields?: PgRawField[] };
      const fields = await this.mapFields(k, res.fields || []);
      return { rows: res.rows, fields, total: res.rows.length, offset, limit };
    }

    const countRes = (await k.raw(buildCountSql(baseSql), params)) as {
      rows?: Array<{ total?: string | number }>;
    };
    const total = Number(countRes.rows?.[0]?.total ?? 0);

    const pageRes = (await k.raw(buildPagedSql(baseSql, limit, offset), params)) as {
      rows: any[];
      fields?: PgRawField[];
    };
    const fields = await this.mapFields(k, pageRes.fields || []);
    return {
      rows: pageRes.rows,
      fields,
      total: Number.isNaN(total) ? 0 : total,
      offset,
      limit,
    };
  }

  private async mapFields(k: Knex, rawFields: PgRawField[]): Promise<Field[]> {
    const oidMap = await resolvePostgresTypeOids(
      k,
      rawFields.map((f) => f.dataTypeID).filter(Boolean),
    );
    const columns = rawFields.map((field) => ({
      Field: field.name,
      Type: oidMap.get(field.dataTypeID) || 'text',
      Default: null,
    }));
    return mapPostgresColumnsToFields(columns);
  }

  private async runDml(
    handle: PostgresqlPoolHandle,
    k: Knex,
    sql: string,
    params: unknown[] | undefined,
    type: DmlStatementType,
    dmlOverride?: import('../../types/config.js').DmlOptions,
  ): Promise<WriteResult> {
    const dml = dmlOverride ?? handle.config.dml ?? {};
    const args = this.bind(params);

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
    if (type === 'INSERT' && dml.maxInsertRows) {
      const rows = countInsertValueRows(sql);
      if (rows > dml.maxInsertRows) {
        throw new SqlEngineError('DML_BLOCKED', `INSERT 行数 ${rows} 超过上限 ${dml.maxInsertRows}`);
      }
    }

    let execSql = sql;
    const hasReturning = /\breturning\b/i.test(sql);
    const needReturning = dml.returning && !hasReturning;
    if (needReturning) {
      execSql = `${sql} RETURNING *`;
    }
    const res = (await k.raw(execSql, args)) as { rowCount?: number; rows?: any[] };

    const writeResult: WriteResult = { affectedRows: Number(res.rowCount ?? 0) };
    // SQL 自带 RETURNING 或 dml.returning → 回传被写行
    if (hasReturning || needReturning) {
      writeResult.returning = res.rows || [];
      writeResult.affectedRows = writeResult.returning.length;
    }
    return writeResult;
  }

  // ==================== 结构 JSON 检出 ====================

  async getTableSchema(pool: PoolHandle, table: string): Promise<TableSchema> {
    const handle = pool as PostgresqlPoolHandle;
    const k = await handle.getKnex();
    const schema = handle.config.schema || 'public';

    // 字段（复用 getColumns 的查询，扩展序号与注释）
    const colRes = (await k.raw(
      `SELECT
         c.column_name AS "Field", c.data_type AS "Type", c.is_nullable AS "Null",
         c.column_default AS "Default", c.ordinal_position,
         col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position) AS "Comment",
         (CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ? AND kcu.table_name = ? AND kcu.column_name = c.column_name
         ) THEN 'PRI' ELSE '' END) AS "Key"
       FROM information_schema.columns c
       WHERE c.table_schema = ? AND c.table_name = ?
       ORDER BY c.ordinal_position`,
      [schema, table, schema, table],
    )) as { rows?: any[] };
    const columns = colRes.rows || [];
    if (!columns.length) {
      throw new SqlEngineError('TABLE_NOT_FOUND', `表 ${table} 不存在`);
    }

    // 索引
    const idxRes = (await k.raw(
      `SELECT i.relname AS index_name, ix.indisunique AS is_unique,
              x.attname AS column_name, ix.indkey
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute x ON x.attrelid = t.oid AND x.attnum = k.attnum
       WHERE n.nspname = ? AND t.relname = ?
       ORDER BY i.relname, k.ord`,
      [schema, table],
    )) as { rows?: Array<{ index_name: string; is_unique: boolean; column_name: string }> };
    const indexMap = new Map<string, IndexSchema>();
    for (const r of idxRes.rows || []) {
      let idx = indexMap.get(r.index_name);
      if (!idx) {
        idx = { name: r.index_name, unique: r.is_unique, columns: [], type: undefined };
        indexMap.set(r.index_name, idx);
      }
      idx.columns.push(r.column_name);
    }

    // 外键
    const fkRes = (await k.raw(
      `SELECT tc.constraint_name, kcu.column_name AS column_name,
              ccu.table_name AS ref_table, ccu.column_name AS ref_column,
              rc.delete_rule, rc.update_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ? AND tc.table_name = ?
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
      [schema, table],
    )) as {
      rows?: Array<{
        constraint_name: string;
        column_name: string;
        ref_table: string;
        ref_column: string;
        delete_rule: string;
        update_rule: string;
      }>;
    };
    const fkMap = new Map<string, ForeignKeySchema>();
    for (const r of fkRes.rows || []) {
      let fk = fkMap.get(r.constraint_name);
      if (!fk) {
        fk = {
          name: r.constraint_name,
          columns: [],
          refTable: r.ref_table,
          refColumns: [],
          onDelete: r.delete_rule || undefined,
          onUpdate: r.update_rule || undefined,
        };
        fkMap.set(r.constraint_name, fk);
      }
      fk.columns.push(r.column_name);
      fk.refColumns.push(r.ref_column);
    }

    // 表注释
    const cmtRes = (await k.raw(
      `SELECT obj_description((quote_ident(?) || '.' || quote_ident(?))::regclass) AS comment`,
      [schema, table],
    )) as { rows?: Array<{ comment?: string }> };
    const comment = cmtRes.rows?.[0]?.comment || undefined;

    const columnSchemas: ColumnSchema[] = columns.map((c: any) => ({
      name: c.Field,
      type: String(c.Type),
      nullable: c.Null === 'YES',
      default: c.Default,
      comment: c.Comment || undefined,
      primaryKey: String(c.Key || '').toUpperCase() === 'PRI',
      autoIncrement: false, // PG 无列级 auto_increment 概念（serial 反映在 default）
      ordinal: Number(c.ordinal_position),
    }));

    return {
      name: table,
      schema,
      kind: 'table',
      comment,
      columns: columnSchemas,
      indexes: [...indexMap.values()],
      foreignKeys: [...fkMap.values()],
      ddl: await this.getTableDDL(handle, table),
      raw: {},
    };
  }

  getAllTableSchemas(pool: PoolHandle, opts?: SchemaOptions): IntrospectTask<TableSchema[]> {
    const handle = pool as PostgresqlPoolHandle;
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
          // 单表失败不中断
        }
      }
      void opts;
      return schemas;
    });
  }
}

export const postgresqlDriver = new PostgresqlDriver();
