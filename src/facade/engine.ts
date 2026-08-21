/**
 * SqlEngine：无状态统一入口（多数据源场景，方法级传入 config）
 * 现有 runSql(configuration, {...}) 调用方式同构
 */
import { SqlEngineError } from '../errors.js';
import { configKey } from '../core/config.js';
import { getDriver } from '../driver/registry.js';
import type { SqlDriver } from '../driver/interface.js';
import { defaultRegistry, type PoolRegistry } from '../client/registry.js';
import type { ConnectionConfig, SchemaOptions } from '../types/config.js';
import { roundDuration, type ExecResult, type Field, type RunSqlRequest, type TestResult } from '../types/result.js';
import type { TableSchema } from '../types/schema.js';
import type { IntrospectTask } from '../types/task.js';
import { wrapTask } from '../types/task.js';

export class SqlEngine {
  private registry: PoolRegistry;

  constructor(registry?: PoolRegistry) {
    this.registry = registry ?? defaultRegistry;
  }

  async testConnection(config: ConnectionConfig): Promise<TestResult> {
    return getDriver(config.type).testConnection(config);
  }

  /** 执行 SQL：SELECT → QueryResult，DML → WriteResult（池按 config 指纹共享）
   * 返回结果统一携带 duration（执行耗时 ms） */
  async runSql(config: ConnectionConfig, request: RunSqlRequest): Promise<ExecResult> {
    const start = performance.now();
    const driver = getDriver(config.type);
    const handle = await this.registry.getPool(config);
    try {
      const result = await driver.runSql(handle, request);
      if (result && typeof result === 'object') {
        (result as { duration?: number }).duration = roundDuration(performance.now() - start);
      }
      return result;
    } finally {
      this.registry.release(configKey(config));
    }
  }

  async getTableList(config: ConnectionConfig): Promise<string[]> {
    return this.withHandle(config, (driver, handle) => driver.getTableList(handle));
  }

  async getTableDDL(config: ConnectionConfig, table: string): Promise<string> {
    return this.withHandle(config, (driver, handle) => {
      if (!driver.getTableDDL) {
        throw new SqlEngineError('QUERY_FAILED', `方言 ${driver.dialect} 不支持 getTableDDL`);
      }
      return driver.getTableDDL(handle, table);
    });
  }

  async getColumns(config: ConnectionConfig, table: string): Promise<Field[]> {
    return this.withHandle(config, (driver, handle) => driver.getColumns(handle, table));
  }

  async getRowsCount(config: ConnectionConfig, table: string, whereClause?: string): Promise<number> {
    return this.withHandle(config, (driver, handle) =>
      driver.getRowsCount(handle, table, whereClause),
    );
  }

  async getPreviewRows(
    config: ConnectionConfig,
    table: string,
    offset = 0,
    limit = 100,
    whereClause?: string,
  ): Promise<any[]> {
    return this.withHandle(config, (driver, handle) =>
      driver.getPreviewRows(handle, table, offset, limit, whereClause),
    );
  }

  /** 单表结构 JSON 检出 */
  async getTableSchema(
    config: ConnectionConfig,
    table: string,
    opts?: SchemaOptions,
  ): Promise<TableSchema> {
    return this.withHandle(config, (driver, handle) =>
      driver.getTableSchema(handle, table, opts),
    );
  }

  /** 全库批量结构导出（长任务）；任务完成后自动释放引用 */
  getAllTableSchemas(config: ConnectionConfig, opts?: SchemaOptions): IntrospectTask<TableSchema[]> {
    const driver = getDriver(config.type);
    if (!driver.getAllTableSchemas) {
      throw new SqlEngineError('QUERY_FAILED', `方言 ${driver.dialect} 不支持 getAllTableSchemas`);
    }
    const fingerprint = configKey(config);
    return wrapTask<TableSchema[]>(() =>
      this.registry.getPool(config).then((handle) => {
        const task = driver.getAllTableSchemas!(handle, opts);
        task.promise.finally(() => this.registry.release(fingerprint));
        return task;
      }),
    );
  }

  /** 事务：fn 内所有查询在同一事务内执行 */
  async withTransaction<T>(
    config: ConnectionConfig,
    fn: (tx: import('../types/transaction.js').TransactionHandle) => Promise<T>,
  ): Promise<T> {
    const driver = getDriver(config.type);
    if (!driver.withTransaction) {
      throw new SqlEngineError('QUERY_FAILED', `方言 ${driver.dialect} 不支持事务`);
    }
    const handle = await this.registry.getPool(config);
    try {
      return await driver.withTransaction(handle, fn);
    } finally {
      this.registry.release(configKey(config));
    }
  }

  async exportSchemaAsJson(config: ConnectionConfig, opts?: SchemaOptions): Promise<string> {
    const task = this.getAllTableSchemas(config, opts);
    const schemas = await task.promise;
    return JSON.stringify(schemas, null, 2);
  }

  /** 全局清理 */
  async destroyAll(): Promise<void> {
    await this.registry.destroyAll();
  }

  private async withHandle<T>(
    config: ConnectionConfig,
    fn: (driver: SqlDriver, handle: import('../driver/interface.js').PoolHandle) => Promise<T> | T,
  ): Promise<T> {
    const driver = getDriver(config.type);
    const handle = await this.registry.getPool(config);
    try {
      return await fn(driver, handle);
    } finally {
      this.registry.release(configKey(config));
    }
  }
}
