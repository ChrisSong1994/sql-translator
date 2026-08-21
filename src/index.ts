/**
 * @fett/sql-translator 公共 API 入口
 *
 * 三层使用方式：
 * 1. createClient(config)  —— 极简客户端（单/多数据源都可用）
 * 2. createClientManager() —— 多数据源注册表
 * 3. 函数式 API            —— runSql(config, req) 等
 */
import './driver/index.js'; // 注册内置驱动（sqlite）

export * from './types/index.js';
export { roundDuration } from './types/result.js';
export type { TransactionHandle } from './types/transaction.js';
export * from './errors.js';
export * from './runtime.js';
export * from './client/index.js';
export * from './facade/engine.js';
export * from './driver/index.js';
export * from './core/task-queue.js';
export * from './core/worker/index.js';
export * from './core/sql/normalize.js';
export * from './core/sql/pagination.js';
export * from './core/sql/statement.js';
export * from './core/field-mapper/mysql.js';
export * from './core/field-mapper/postgresql.js';
export {
  replaceTableNamesInSql,
  validateTableNameReplacement,
  stripQuotes,
  extractTableNamesFromSql as extractMappedTableNames,
} from './core/sql/table-mapper.js';
export * from './optional/static-source.js';
export * from './core/config.js';
export * from './core/cache.js';

import { SqlEngine } from './facade/engine.js';
import type { ConnectionConfig, SchemaOptions } from './types/config.js';
import type { ExecResult, ExplainResult, Field, RunSqlRequest, TestResult } from './types/result.js';
import type { TableSchema } from './types/schema.js';
import type { IntrospectTask } from './types/task.js';

/** 默认无状态 engine（函数式 API 共享全局池注册表） */
const defaultEngine = new SqlEngine();

// ==================== 函数式 API  ====================

export const testConnection = (config: ConnectionConfig): Promise<TestResult> =>
  defaultEngine.testConnection(config);

export const runSql = (config: ConnectionConfig, req: RunSqlRequest): Promise<ExecResult> =>
  defaultEngine.runSql(config, req);

export const explain = (config: ConnectionConfig, sql: string, params?: unknown[]): Promise<ExplainResult> =>
  defaultEngine.explain(config, sql, params);

export const getTableList = (config: ConnectionConfig): Promise<string[]> =>
  defaultEngine.getTableList(config);

export const getTableDDL = (config: ConnectionConfig, table: string): Promise<string> =>
  defaultEngine.getTableDDL(config, table);

export const getColumns = (config: ConnectionConfig, table: string): Promise<Field[]> =>
  defaultEngine.getColumns(config, table);

export const getRowsCount = (
  config: ConnectionConfig,
  table: string,
  whereClause?: string,
): Promise<number> => defaultEngine.getRowsCount(config, table, whereClause);

export const getPreviewRows = (
  config: ConnectionConfig,
  table: string,
  offset = 0,
  limit = 100,
  whereClause?: string,
): Promise<any[]> => defaultEngine.getPreviewRows(config, table, offset, limit, whereClause);

export const getTableSchema = (
  config: ConnectionConfig,
  table: string,
  opts?: SchemaOptions,
): Promise<TableSchema> => defaultEngine.getTableSchema(config, table, opts);

export const getAllTableSchemas = (
  config: ConnectionConfig,
  opts?: SchemaOptions,
): IntrospectTask<TableSchema[]> => defaultEngine.getAllTableSchemas(config, opts);

export const exportSchemaAsJson = (config: ConnectionConfig, opts?: SchemaOptions): Promise<string> =>
  defaultEngine.exportSchemaAsJson(config, opts);
