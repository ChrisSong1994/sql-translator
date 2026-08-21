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
    const tlsOptions: Record<string, unknown> = {};
    if (config.ssl.ca) tlsOptions.ca = Buffer.from(config.ssl.ca);
    if (config.ssl.cert) tlsOptions.cert = Buffer.from(config.ssl.cert);
    if (config.ssl.key) tlsOptions.key = Buffer.from(config.ssl.key);
    tlsOptions.rejectUnauthorized = config.ssl.rejectUnauthorized ?? false;
    if (Object.keys(tlsOptions).length > 0) options.tlsOptions = tlsOptions;
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
