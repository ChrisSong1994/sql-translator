/**
 * PostgreSQL 连接池句柄（Knex/pg）
 */
import knex, { type Knex } from 'knex';
import { configKey } from '../../core/config.js';
import type { PoolHandle } from '../interface.js';
import type { PostgresqlConfig } from '../../types/config.js';

/** 构建 PostgreSQL SSL 配置 */
export function buildPgSslConfig(config: PostgresqlConfig) {
  if (!config.ssl?.enabled) return undefined;
  return {
    ca: config.ssl.ca || undefined,
    cert: config.ssl.cert || undefined,
    key: config.ssl.key || undefined,
    rejectUnauthorized: config.ssl.rejectUnauthorized ?? false,
  };
}

export class PostgresqlPoolHandle implements PoolHandle {
  readonly fingerprint: string;
  readonly config: PostgresqlConfig;
  private knexInstance: Knex | null = null;
  private destroyedFlag = false;

  constructor(config: PostgresqlConfig) {
    this.config = { ...config };
    this.fingerprint = configKey(config);
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** 获取 Knex 实例（懒创建） */
  async getKnex(): Promise<Knex> {
    if (!this.knexInstance) {
      const cfg = this.config;
      const schema = cfg.schema || 'public';
      this.knexInstance = knex({
        client: 'pg',
        connection: {
          host: cfg.host,
          port: Number(cfg.port ?? 5432),
          user: cfg.user || cfg.username,
          password: cfg.password,
          database: cfg.database,
          ssl: buildPgSslConfig(cfg),
        },
        pool: {
          min: 0,
          max: 20,
          acquireTimeoutMillis: 30000,
          createTimeoutMillis: 15000,
          idleTimeoutMillis: 30000,
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 100,
          propagateCreateError: false,
          // 每条连接设置 search_path 和 statement_timeout
          afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
            conn.query(
              `SET search_path TO "${schema}", public; SET statement_timeout = '30s'`,
              (err: Error | null) => done(err, conn),
            );
          },
        },
      });
    }
    return this.knexInstance;
  }

  get stats() {
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
      // ignore
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
        // ignore
      }
      this.knexInstance = null;
    }
  }
}
