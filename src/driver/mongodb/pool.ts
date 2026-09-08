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
  // MONGODB-X509 用客户端证书认证，连接串中不携带 username/password
  const x509 = config.authMethod === 'MONGODB-X509';
  const user = x509 ? null : (config.user || config.username);
  const pass = config.password;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass ?? '')}@` : '';
  const host = config.host ?? 'localhost';
  const port = config.port ? `:${config.port}` : '';
  const db = config.database ? `/${encodeURIComponent(config.database)}` : '';
  // 认证库缺省默认 admin（与 MongoDB Compass/mongosh 惯例一致）：不传 authSource 时在 admin 上认证
  const authSource = user && (config.authSource || 'admin') ? `?authSource=${encodeURIComponent(config.authSource || 'admin')}` : '';
  const authMechanism = config.authMethod ? `${authSource ? '&' : '?'}authMechanism=${encodeURIComponent(config.authMethod)}` : '';
  return `mongodb://${auth}${host}${port}${db}${authSource}${authMechanism}`;
}

export function buildMongoOptions(config: MongodbConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    // 连接/服务器选择超时可配置，默认 10s（连接测试可在测试配置中放宽）
    connectTimeoutMS: config.connectTimeoutMS ?? 10000,
    socketTimeoutMS: config.socketTimeoutMS ?? 30000,
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMS ?? 10000,
    // 单实例部署不支持 retryable writes（事务/会话需要），默认关闭
    retryWrites: config.retryWrites ?? false,
  };
  // 认证方式（MONGODB-X509 / SCRAM-SHA-256 / SCRAM-SHA-1），驱动默认 SCRAM-SHA-256
  if (config.authMethod) {
    options.authMechanism = config.authMethod;
  }
  // MONGODB-X509 必须在 $external 库上认证（驱动对非 $external 的 X509 直接报错）
  if (config.authMethod === 'MONGODB-X509' && !config.authSource) {
    options.authSource = '$external';
  }
  if (config.ssl?.enabled) {
    options.tls = true;
    // driver 7.x：Node TLS 选项（ca/cert/key/rejectUnauthorized）直接放顶层，
    // 不再用 5.x 遗留的 tlsOptions 嵌套
    options.rejectUnauthorized = config.ssl.rejectUnauthorized ?? false;
    if (config.ssl.ca) options.ca = Buffer.from(config.ssl.ca);
    if (config.ssl.cert) options.cert = Buffer.from(config.ssl.cert);
    if (config.ssl.key) options.key = Buffer.from(config.ssl.key);
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
