/**
 * 连接配置类型（对外唯一入参）
 */

import type { TaskQueueOptions } from './queue.js';

/** 支持的数据库方言 */
export type DialectType = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'mongodb';

/** 运行时名称 */
export type RuntimeName = 'node' | 'bun';

/** 运行时选择：auto = 自动探测 */
export type RuntimeChoice = 'auto' | RuntimeName;

/** SSL 配置（mysql/pg/mongodb 通用） */
export interface SslOptions {
  enabled?: boolean;
  mode?: string;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

/** 连接池选项（driver 通用） */
export interface PoolOptions {
  /** 池上限，默认 20 */
  max?: number;
  /** 常驻连接数，默认 0 */
  min?: number;
  /** 获取连接超时，默认 20000ms */
  acquireTimeoutMs?: number;
  /** 建连超时，默认 15000ms */
  createTimeoutMs?: number;
  /** 空闲回收时间，默认 30000ms */
  idleTimeoutMs?: number;
  /** 连接超时（新建连接时），默认 10000ms */
  connectTimeoutMs?: number;
  /** 是否开启 keepAlive，默认 true */
  keepAlive?: boolean;
}

/** DML 安全护栏 */
export interface DmlOptions {
  /** 禁止无 WHERE 的 UPDATE/DELETE，默认 true */
  requireWhereForUpdateDelete?: boolean;
  /** 单次 INSERT 批量行数上限，默认 10000，0 = 不限制 */
  maxInsertRows?: number;
  /** 返回被写行（PG/SQLite 用 RETURNING；MySQL 回读成本高，默认 false） */
  returning?: boolean;
}

/** 慢查询日志条目 */
export interface SlowQueryEntry {
  type: 'slow-query';
  dialect: string;
  sql: string;
  params?: unknown[];
  durationMs: number;
  fingerprint?: string;
  /** ISO 时间 */
  at: string;
}

/** 日志选项（慢查询等） */
export interface LoggingOptions {
  /** 慢查询阈值 ms；设置后执行耗时超过该值的查询触发日志（默认不记录） */
  slowQueryMs?: number;
  /** 自定义日志函数（默认 console.warn） */
  logFn?: (entry: SlowQueryEntry) => void;
}

/** 查询结果缓存选项（仅缓存幂等 SELECT） */
export interface QueryCacheOptions {
  /** 是否启用，默认 false */
  enabled?: boolean;
  /** TTL 毫秒，默认 60000 */
  ttlMs?: number;
  /** 最大缓存条目数（LRU），默认 1000 */
  maxEntries?: number;
}

/** 结构检出选项（主要影响 MongoDB） */
export interface SchemaOptions {
  /** Mongo 采样条数，默认 100；0 = 仅集合名/索引（快速模式） */
  sampleSize?: number;
  /** Mongo 嵌套深度上限，默认 3 */
  maxDepth?: number;
  /** 全量扫描（可选） */
  analyzeAll?: boolean;
  /** 是否命中结构缓存，默认 true */
  useCache?: boolean;
  /** 结构缓存 TTL，默认 5 分钟 */
  cacheTtlMs?: number;
}

/** 所有方言配置的公共基类 */
export interface BaseConfig {
  type: DialectType;
  /** 运行时：默认 auto（自动探测） */
  runtime?: RuntimeChoice;
  /** DML 安全策略 */
  dml?: DmlOptions;
  /** 连接池选项 */
  pool?: PoolOptions;
  /** 任务队列选项 */
  queue?: TaskQueueOptions;
  /** 结构检出选项（作为各方法默认值）——注意与 PG 的 schema（schema 名）不冲突 */
  introspect?: SchemaOptions;
  /** 只读模式：拒绝一切非 SELECT 语句（数据库层强制只读，替代关键词黑名单） */
  selectOnly?: boolean;
  /** 查询结果缓存（仅幂等 SELECT；DML/DDL 后整库失效） */
  cache?: QueryCacheOptions;
  /** 日志选项（慢查询等） */
  logging?: LoggingOptions;
  [key: string]: unknown;
}

export interface MysqlConfig extends BaseConfig {
  type: 'mysql';
  host: string;
  /** 默认 3306 */
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database: string;
  /** 方言模式：'5' | '8' | 'auto'（auto = 启动时探测 VERSION()） */
  version?: '5' | '8' | 'auto';
  ssl?: SslOptions;
}

/** MariaDB 配置（协议与 MySQL 兼容，能力矩阵不同：10.2+ 支持 CTE） */
export interface MariadbConfig extends BaseConfig {
  type: 'mariadb';
  host: string;
  /** 默认 3306 */
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database: string;
  /** 方言模式：'10' | '11' | 'auto'（auto = 启动时探测 VERSION()） */
  version?: '10' | '11' | 'auto';
  ssl?: SslOptions;
}

export interface PostgresqlConfig extends BaseConfig {
  type: 'postgresql';
  host: string;
  /** 默认 5432 */
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database: string;
  /** 默认 public */
  schema?: string;
  ssl?: SslOptions;
}

export interface SqliteConfig extends BaseConfig {
  type: 'sqlite';
  /** ':memory:' 用内存库，否则为文件路径 */
  database: string;
}

export interface MongodbConfig extends BaseConfig {
  type: 'mongodb';
  /** 优先；未提供则由 host/port/database 拼装 */
  uri?: string;
  host?: string;
  /** 默认 27017 */
  port?: number;
  user?: string;
  username?: string;
  password?: string;
  database?: string;
  /** 默认 admin */
  authSource?: string;
  /** retryable writes（单实例不支持事务需 false，默认 false） */
  retryWrites?: boolean;
  ssl?: SslOptions;
}

export type ConnectionConfig =
  | MysqlConfig
  | MariadbConfig
  | PostgresqlConfig
  | SqliteConfig
  | MongodbConfig;
