/**
 * 事务句柄：内部所有查询在同一个事务/连接内执行
 */
import type { ExecResult, QueryResult, RunSqlRequest, WriteResult } from './result.js';

export interface TransactionHandle {
  /** 执行 SQL（SELECT → QueryResult，DML → WriteResult） */
  runSql(request: RunSqlRequest): Promise<ExecResult>;
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult>;
  execute(sql: string, params?: unknown[]): Promise<WriteResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
