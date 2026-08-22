/**
 * MongoDB 连接池句柄（mongodb 原生驱动 MongoClient）
 */
import { MongoClient, type Db } from 'mongodb';
import { configKey } from '../../core/config.js';
import type { PoolHandle } from '../interface.js';
import type { MongodbConfig } from '../../types/config.js';

/** 由 host/port/database 拼装连接串 */
export function buildMongoUri(config: MongodbConfig): string {
  if (config.uri) return config.uri;
  const user = config.user || config.username;
  const pass = config.password;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@` : '';
  const host = config.host ?? 'localhost';
  const port = config.port ? `:${config.port}` : '';
  const db = config.database ? `/${encodeURIComponent(config.database)}` : '';
  const authSource = user && config.authSource ? `?authSource=${encodeURIComponent(config.authSource)}` : '';
  return `mongodb://${auth}${host}${port}${db}${authSource}`;
}

export function buildMongoOptions(config: MongodbConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    serverSelectionTimeoutMS: 10000,
    // 单实例部署不支持 retryable writes（事务/会话需要），默认关闭
    retryWrites: config.retryWrites ?? false,
  };
  if (config.ssl?.enabled) {
    options.tls = true;
    // mongodb driver 7.x 支持 Node TLS socket 选项（ca/cert/key/rejectUnauthorized）直接放顶层；
    // 注意 tlsOptions 仅用于 CSFLE KMS，不能用于普通连接
    if (config.ssl.ca) options.ca = Buffer.from(config.ssl.ca);
    if (config.ssl.cert) options.cert = Buffer.from(config.ssl.cert);
    if (config.ssl.key) options.key = Buffer.from(config.ssl.key);
    options.rejectUnauthorized = config.ssl.rejectUnauthorized ?? false;
  }
  return options;
}

export class MongoPoolHandle implements PoolHandle {
  readonly fingerprint: string;
  readonly config: MongodbConfig;
  private client: MongoClient | null = null;
  private destroyedFlag = false;

  constructor(config: MongodbConfig) {
    this.config = { ...config };
    this.fingerprint = configKey(config);
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** 获取 MongoClient（懒连接） */
  async getClient(): Promise<MongoClient> {
    if (!this.client) {
      const uri = buildMongoUri(this.config);
      this.client = new MongoClient(uri, buildMongoOptions(this.config) as any);
      await this.client.connect();
    }
    return this.client;
  }

  /** 获取数据库实例 */
  async getDb(): Promise<Db> {
    const client = await this.getClient();
    return client.db(this.config.database);
  }

  get stats() {
    return {
      active: 0,
      idle: this.client ? 1 : 0,
      waiting: 0,
      createdTotal: this.client ? 1 : 0,
      destroyedTotal: this.destroyedFlag ? 1 : 0,
    };
  }

  async ping(): Promise<void> {
    const client = await this.getClient();
    await client.db().command({ ping: 1 });
  }

  async destroy(): Promise<void> {
    if (this.destroyedFlag) return;
    this.destroyedFlag = true;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }
}
