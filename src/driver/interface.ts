/**
 * 驱动接口：各数据库方言适配器的统一契约
 * 连接池由 PoolHandle 持有（由 client/registry 统一管理生命周期），
 * driver 方法只接收已绑定 config 的 handle，不做重复缓存
 */
import type { ConnectionConfig, SchemaOptions } from '../types/config.js';
import type { ExecResult, Field, RunSqlRequest, TestResult } from '../types/result.js';
import type { TableSchema } from '../types/schema.js';
import type { IntrospectTask } from '../types/task.js';
import type { TransactionHandle } from '../types/transaction.js';
import type { PoolStats } from '../types/manager.js';

/** 连接池句柄（registry 生命周期管理单元） */
export interface PoolHandle {
  readonly fingerprint: string;
  readonly config: ConnectionConfig;
  readonly stats: PoolStats;
  /** 已销毁标记（invalidate/destroy 后为 true） */
  readonly destroyed: boolean;
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

export interface SqlDriver {
  readonly dialect: string;

  /** 创建连接池（纯工厂，registry 负责缓存与销毁） */
  createPool(config: ConnectionConfig): Promise<PoolHandle>;

  /** 连接测试：一次性连接，不入池 */
  testConnection(config: ConnectionConfig): Promise<TestResult>;

  runSql(pool: PoolHandle, request: RunSqlRequest): Promise<ExecResult>;

  getTableList(pool: PoolHandle): Promise<string[]>;
  getTableDDL?(pool: PoolHandle, table: string): Promise<string>;
  getPreviewRows(
    pool: PoolHandle,
    table: string,
    offset: number,
    limit: number,
    whereClause?: string,
  ): Promise<any[]>;
  getColumns(pool: PoolHandle, table: string): Promise<Field[]>;
  getRowsCount(pool: PoolHandle, table: string, whereClause?: string): Promise<number>;
  getTableSchema(pool: PoolHandle, table: string, opts?: SchemaOptions): Promise<TableSchema>;
  getAllTableSchemas?(pool: PoolHandle, opts?: SchemaOptions): IntrospectTask<TableSchema[]>;
  /** 事务：fn 内所有查询在同一事务/连接内执行；fn 抛错自动回滚 */
  withTransaction?<T>(pool: PoolHandle, fn: (tx: TransactionHandle) => Promise<T>): Promise<T>;
}
