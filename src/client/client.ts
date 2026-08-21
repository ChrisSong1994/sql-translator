/**
 * DbClient：绑定 config 的极简 API
 * 外部唯一入口：createClient(config)
 */
import { SqlEngineError } from '../errors.js';
import { configKey } from '../core/config.js';
import { TtlCache, queryCacheKey } from '../core/cache.js';
import { maybeLogSlowQuery } from '../core/slow-query.js';
import { getDriver } from '../driver/registry.js';
import type { SqlDriver, PoolHandle } from '../driver/interface.js';
import type { ConnectionConfig, SchemaOptions } from '../types/config.js';
import {
  roundDuration,
  type ExecResult,
  type Field,
  type QueryResult,
  type RunSqlRequest,
  type TestResult,
  type WriteResult,
} from '../types/result.js';
import type { TableSchema } from '../types/schema.js';
import type { IntrospectTask, TaskProgress } from '../types/task.js';
import { wrapTask } from '../types/task.js';
import type { TaskQueue } from '../types/queue.js';
import type { TransactionHandle } from '../types/transaction.js';
import { TaskQueueImpl } from '../core/task-queue.js';
import { detectStatementType } from '../core/sql/statement.js';
import { normalizeSql } from '../core/sql/normalize.js';
import type { PoolRegistry } from './registry.js';

export class DbClient {
  readonly config: ConnectionConfig;
  readonly fingerprint: string;
  /** 任务队列（多线程） */
  readonly tasks: TaskQueue;

  private registry: PoolRegistry;
  private driverCache: SqlDriver | null = null;
  private handlePromise: Promise<PoolHandle> | null = null;
  private destroyed = false;
  private queryCache: TtlCache<string, ExecResult> | null = null;

  constructor(registry: PoolRegistry, config: ConnectionConfig) {
    this.registry = registry;
    this.config = config;
    this.fingerprint = configKey(config);
    // driver 懒加载：createClient 不抛 UNSUPPORTED_DIALECT，首次操作才校验
    this.tasks = new TaskQueueImpl(config.queue ?? {});
  }

  private get driver(): SqlDriver {
    this.driverCache ??= getDriver(this.config.type);
    return this.driverCache;
  }

  // ==================== 连接生命周期 ====================

  private getHandle(): Promise<PoolHandle> {
    if (this.destroyed) {
      return Promise.reject(
        new SqlEngineError('CONNECTION_FAILED', 'client 已销毁（destroy 后不可再使用）'),
      );
    }
    this.handlePromise ??= this.registry.getPool(this.config);
    return this.handlePromise;
  }

  /** 连接测试（一次性连接，不入池） */
  testConnection(): Promise<TestResult> {
    return this.driver.testConnection(this.config);
  }

  /** 池内探活：失败触发池重建 */
  async ping(): Promise<void> {
    const handle = await this.getHandle();
    try {
      await handle.ping();
    } catch (err) {
      // 探活失败 → 销毁并重建池
      await this.registry.invalidate(this.fingerprint).catch(() => undefined);
      this.handlePromise = null;
      throw err;
    }
  }

  /** 释放引用（引用归零且空闲超限时池被回收）；不是「立即销毁共享池」 */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.registry.release(this.fingerprint);
    if (this.tasks && typeof (this.tasks as TaskQueueImpl).close === 'function') {
      await (this.tasks as TaskQueueImpl).close();
    }
  }

  // ==================== SQL 执行 ====================

  /** 完整执行入口（SELECT → QueryResult，DML → WriteResult）
   * dml 选项按本 client 配置注入（池共享时 handle 配置不可靠）
   * 查询结果缓存：仅幂等 SELECT；写操作（DML/DDL）后整库失效
   * selectOnly 只读模式：拒绝一切非 SELECT 语句
   * 返回结果统一携带 duration（执行耗时 ms，含缓存命中） */
  async run(request: RunSqlRequest): Promise<ExecResult> {
    const start = performance.now();
    const finish = (result: ExecResult): ExecResult => {
      const durationMs = performance.now() - start;
      if (result && typeof result === 'object') {
        (result as { duration?: number }).duration = roundDuration(durationMs);
      }
      // 慢查询日志（仅当配置 slowQueryMs 且超过阈值）
      maybeLogSlowQuery((this.config as any).logging, {
        dialect: this.driver.dialect,
        sql: request.sql,
        params: request.params,
        durationMs,
        fingerprint: this.fingerprint,
      });
      return result;
    };

    const type = detectStatementType(request.sql);
    this.assertWritable(type);

    const handle = await this.getHandle();
    const req: RunSqlRequest = request.dml ? request : { ...request, dml: this.config.dml };
    const cacheOpts = (this.config as any).cache as
      | import('../types/config.js').QueryCacheOptions
      | undefined;
    const cache = cacheOpts?.enabled ? this.getQueryCache() : null;

    if (cache && type === 'SELECT') {
      const key = queryCacheKey(this.fingerprint, request.sql, request);
      const hit = cache.get(key);
      if (hit !== undefined) return finish(hit);
      const result = await this.driver.runSql(handle, req);
      cache.set(key, structuredClone(result));
      return finish(result);
    }

    const result = await this.driver.runSql(handle, req);
    // 写操作后失效（粗粒度：本 client 缓存全清；精确按表失效留后续）
    if (cache && type !== 'SELECT') cache.clear();
    return finish(result);
  }

  /** selectOnly 只读模式护栏：拒绝非 SELECT 语句 */
  private assertWritable(type: import('../core/sql/statement.js').StatementType): void {
    if (this.config.selectOnly && type !== 'SELECT') {
      throw new SqlEngineError(
        'READ_ONLY',
        `只读模式（selectOnly: true）禁止 ${type} 语句，仅允许 SELECT`,
      );
    }
  }

  private getQueryCache(): TtlCache<string, ExecResult> {
    const opts = (this.config as any).cache as
      | import('../types/config.js').QueryCacheOptions
      | undefined;
    this.queryCache ??= new TtlCache(opts?.ttlMs ?? 60000, opts?.maxEntries ?? 1000);
    return this.queryCache;
  }

  /** SELECT 查询 */
  async query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult> {
    const type = detectStatementType(sql);
    if (type !== 'SELECT') {
      throw new SqlEngineError(
        'QUERY_FAILED',
        `query() 仅支持 SELECT，收到 ${type}（写操作请用 execute()）`,
      );
    }
    const result = await this.run({ sql, params });
    return result as QueryResult;
  }

  /** 写操作：DML（INSERT/UPDATE/DELETE）+ DDL（CREATE/ALTER/DROP 透传） */
  async execute(sql: string, params?: unknown[]): Promise<WriteResult> {
    const type = detectStatementType(sql);
    if (type !== 'INSERT' && type !== 'UPDATE' && type !== 'DELETE' && type !== 'DDL') {
      throw new SqlEngineError(
        'QUERY_FAILED',
        `execute() 仅支持写操作（INSERT/UPDATE/DELETE/DDL），收到 ${type}（查询请用 query()）`,
      );
    }
    const result = await this.run({ sql, params });
    return result as WriteResult;
  }

  /** EXPLAIN 执行计划（SQLite QUERY PLAN / MySQL / PG / Mongo） */
  async explain(sql: string, params?: unknown[]): Promise<import('../types/result.js').ExplainResult> {
    if (!this.driver.explain) {
      throw new SqlEngineError('QUERY_FAILED', `方言 ${this.driver.dialect} 不支持 explain`);
    }
    const handle = await this.getHandle();
    const start = performance.now();
    const result = await this.driver.explain(handle, { sql, params });
    result.duration = roundDuration(performance.now() - start);
    return result;
  }

  /** 透传原始驱动结果（不包装）——M2 提供方言原生透传 */
  async raw(sql: string, params?: unknown[]): Promise<unknown> {
    void sql;
    void params;
    throw new SqlEngineError(
      'QUERY_FAILED',
      'raw() 暂未在驱动层暴露（M2 提供方言原生透传）',
    );
  }

  // ==================== 元信息检出 ====================

  async getTables(): Promise<string[]> {
    const handle = await this.getHandle();
    return this.driver.getTableList(handle);
  }

  async getTableDDL(table: string): Promise<string> {
    const handle = await this.getHandle();
    if (!this.driver.getTableDDL) {
      throw new SqlEngineError('QUERY_FAILED', `方言 ${this.driver.dialect} 不支持 getTableDDL`);
    }
    return this.driver.getTableDDL(handle, table);
  }

  async getColumns(table: string): Promise<Field[]> {
    const handle = await this.getHandle();
    return this.driver.getColumns(handle, table);
  }

  async getRowsCount(table: string, whereClause?: string, params?: unknown[]): Promise<number> {
    void params;
    const handle = await this.getHandle();
    return this.driver.getRowsCount(handle, table, whereClause);
  }

  async getPreviewRows(
    table: string,
    offset = 0,
    limit = 100,
    whereClause?: string,
  ): Promise<any[]> {
    const handle = await this.getHandle();
    return this.driver.getPreviewRows(handle, table, offset, limit, whereClause);
  }

  /** 单表结构 JSON 检出 */
  getTableSchema(table: string, opts?: SchemaOptions): Promise<TableSchema> {
    return this.getHandle().then((handle) => this.driver.getTableSchema(handle, table, opts));
  }

  /** 全库批量结构导出（长任务：进度/取消）
   * 引用语义：client 持有池引用直到 destroy()，任务期间不额外计 ref */
  getAllTableSchemas(opts?: SchemaOptions): IntrospectTask<TableSchema[]> {
    return wrapTask<TableSchema[]>(() =>
      this.getHandle().then((handle) => {
        if (!this.driver.getAllTableSchemas) {
          throw new SqlEngineError(
            'QUERY_FAILED',
            `方言 ${this.driver.dialect} 不支持 getAllTableSchemas`,
          );
        }
        return this.driver.getAllTableSchemas(handle, opts);
      }),
    );
  }

  /** 全库结构 → JSON 字符串 */
  async exportSchemaAsJson(opts?: SchemaOptions): Promise<string> {
    const task = this.getAllTableSchemas(opts);
    const schemas = await task.promise;
    return JSON.stringify(schemas, null, 2);
  }

  /** 事务：fn 内所有查询在同一事务/连接内执行；fn 抛错自动回滚 */
  async withTransaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    if (this.config.selectOnly) {
      throw new SqlEngineError('READ_ONLY', '只读模式（selectOnly: true）禁止事务');
    }
    if (!this.driver.withTransaction) {
      throw new SqlEngineError('QUERY_FAILED', `方言 ${this.driver.dialect} 不支持事务`);
    }
    const handle = await this.getHandle();
    return this.driver.withTransaction(handle, fn);
  }
}

/** 判断 SQL 是否为写操作（供上层语义判断） */
export function isWriteSql(sql: string): boolean {
  return detectStatementType(normalizeSql(sql)) !== 'SELECT';
}
