/**
 * ClientManager：多数据源注册表
 * 核心：连接池按 config 指纹全局共享，client 是廉价句柄；每请求 getClient 命中缓存，不建新池
 */
import { SqlEngineError } from '../errors.js';
import { configKey } from '../core/config.js';
import type { ConnectionConfig } from '../types/config.js';
import type { ClientManagerOptions, PoolMetrics } from '../types/manager.js';
import { DbClient } from './client.js';
import { PoolRegistry } from './registry.js';

interface RegisteredClient {
  config: ConnectionConfig;
  client: DbClient;
}

export class ClientManager {
  /** 底层池注册表（只读暴露）：供自定义 SqlEngine 绑定 / 监控使用 */
  readonly registry: PoolRegistry;
  private byId = new Map<string, RegisteredClient>();
  private maxClients: number;

  constructor(options: ClientManagerOptions = {}) {
    this.registry = new PoolRegistry(options);
    this.maxClients = options.maxClients ?? 500;
  }

  /**
   * 获取/创建绑定 config 的 client（首次懒建池，之后命中共享池）
   * 创建本身零成本：不建立连接，首次调用才真实建连
   */
  getClient(config: ConnectionConfig): DbClient {
    // 立即抛错校验方言（避免把错误延迟到首次调用）
    void configKey(config);
    return new DbClient(this.registry, config);
  }

  /** 注册业务 ID → client（避免每次从库读 config 后重复计算指纹） */
  async register(dsId: string, config: ConnectionConfig): Promise<DbClient> {
    if (this.byId.size >= this.maxClients) {
      throw new SqlEngineError(
        'CLIENT_LIMIT_EXCEEDED',
        `已注册 client 数达到上限 ${this.maxClients}（ClientManagerOptions.maxClients 可调）`,
      );
    }
    const client = this.getClient(config);
    // 预热：立即建池并探活，让后续请求零延迟命中
    await client.ping();
    this.byId.set(dsId, { config, client });
    return client;
  }

  getClientById(dsId: string): DbClient | undefined {
    return this.byId.get(dsId)?.client;
  }

  getConfigById(dsId: string): ConnectionConfig | undefined {
    return this.byId.get(dsId)?.config;
  }

  /** 释放 client 引用（数据源删除：引用归零即回收池） */
  async release(dsId: string): Promise<void> {
    const rec = this.byId.get(dsId);
    this.byId.delete(dsId);
    if (rec) {
      await rec.client.destroy();
    }
  }

  /** 强制销毁池（数据源配置更新：下次按新 config 重建） */
  async invalidate(target: string | ConnectionConfig): Promise<void> {
    if (typeof target === 'string') {
      const rec = this.byId.get(target);
      if (rec) {
        await this.registry.invalidate(configKey(rec.config));
        this.byId.delete(target);
      }
      return;
    }
    await this.registry.invalidate(configKey(target));
  }

  /** 应用退出清理 */
  async destroyAll(): Promise<void> {
    await this.registry.destroyAll();
    this.byId.clear();
  }

  /** 池指标 */
  metrics(): PoolMetrics {
    return this.registry.metrics();
  }
}
