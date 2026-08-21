/**
 * MySQL 连接池句柄（Knex/mysql2）
 * 懒创建：首次操作才建立连接池；版本能力探测缓存
 */
import knex, { type Knex } from 'knex';
import { resolveRuntime } from '../../runtime.js';
import { configKey } from '../../core/config.js';
import type { PoolHandle } from '../interface.js';
import type { MysqlConfig } from '../../types/config.js';
import type { MysqlCapabilities } from './version.js';
import { resolveMysqlCapabilities } from './version.js';

/** 构建 MySQL SSL 配置 */
export function buildSslConfig(config: MysqlConfig) {
  if (!config.ssl?.enabled) return undefined;
  return {
    ca: config.ssl.ca || undefined,
    cert: config.ssl.cert || undefined,
    key: config.ssl.key || undefined,
    rejectUnauthorized: config.ssl.rejectUnauthorized ?? false,
    minVersion: 'TLSv1.2',
  };
}

export class MysqlPoolHandle implements PoolHandle {
  readonly fingerprint: string;
  readonly config: MysqlConfig;
  readonly isMariaDb: boolean;
  private knexInstance: Knex | null = null;
  private caps: MysqlCapabilities | null = null;
  private destroyedFlag = false;
  /** 表主键列缓存（INSERT returning 回读用） */
  private readonly pkCache = new Map<string, string>();

  constructor(config: MysqlConfig, options: { isMariaDb?: boolean } = {}) {
    this.config = { ...config };
    this.fingerprint = configKey(config);
    this.isMariaDb = options.isMariaDb ?? (config as any).type === 'mariadb';
    void resolveRuntime; // runtime 兼容占位（mysql 驱动不依赖 runtime 差异）
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** 获取 Knex 实例（懒创建） */
  async getKnex(): Promise<Knex> {
    if (!this.knexInstance) {
      const cfg = this.config;
      this.knexInstance = knex({
        client: 'mysql2',
        connection: {
          host: cfg.host,
          port: Number(cfg.port ?? 3306),
          user: cfg.user || cfg.username,
          password: cfg.password,
          database: cfg.database,
          ssl: buildSslConfig(cfg),
          enableKeepAlive: true,
          keepAliveInitialDelay: 10000,
          connectTimeout: 10000,
        },
        pool: {
          min: 0,
          max: 20,
          acquireTimeoutMillis: 20000,
          createTimeoutMillis: 15000,
          idleTimeoutMillis: 30000,
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 100,
          propagateCreateError: false,
          // 每条连接建立后设置慢查询兜底：MySQL 用 max_execution_time(ms)，MariaDB 用 max_statement_time(s)
          afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
            const setVar = this.isMariaDb
              ? 'SET SESSION max_statement_time = 30'
              : 'SET SESSION max_execution_time = 30000';
            conn.query(setVar, (err: Error | null) => {
              done(err, conn);
            });
          },
        },
      });
    }
    return this.knexInstance;
  }

  /** 版本能力（config.version 强制时跳过探测；MariaDB 走独立解析） */
  async getCapabilities(): Promise<MysqlCapabilities> {
    this.caps ??= await resolveMysqlCapabilities(
      await this.getKnex(),
      this.config.version,
      this.isMariaDb,
    );
    return this.caps;
  }

  /** 主键列（返回空字符串表示无/多列主键） */
  async getPrimaryKeyColumn(table: string): Promise<string> {
    const cached = this.pkCache.get(table);
    if (cached !== undefined) return cached;
    const k = await this.getKnex();
    const res = (await k.raw(
      `SELECT column_name AS column_name FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'
       ORDER BY ordinal_position`,
      [table],
    )) as unknown[];
    const rows = (Array.isArray(res) ? res[0] : res) as Array<{ column_name?: string }>;
    const pk = rows?.length === 1 ? String(rows[0]!.column_name ?? '') : '';
    this.pkCache.set(table, pk);
    return pk;
  }

  get stats() {
    // tarn 连接池统计（knex 3）
    let active = 0;
    let idle = 0;
    let waiting = 0;
    try {
      const pool: any = (this.knexInstance as any)?.client?.pool;
      if (pool && typeof pool.numUsed === 'function') {
        active = pool.numUsed();
        idle = pool.numFree();
        waiting = pool.numPendingAcquires();
      }
    } catch {
      // 统计失败不影响主流程
    }
    return {
      active,
      idle,
      waiting,
      createdTotal: this.knexInstance ? 1 : 0,
      destroyedTotal: this.destroyedFlag ? 1 : 0,
    };
  }

  async ping(): Promise<void> {
    const k = await this.getKnex();
    await k.raw('SELECT 1');
  }

  async destroy(): Promise<void> {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    if (this.knexInstance) {
      try {
        await this.knexInstance.destroy();
      } catch {
        // 销毁失败不阻塞
      }
      this.knexInstance = null;
    }
  }
}
