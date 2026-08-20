/**
 * 全局连接池注册表（模块级单例）
 * 所有入口共享：createClient / ClientManager / SqlEngine / 函数式 API
 * 职责：按 config 指纹缓存池、引用计数、LRU 空闲淘汰、指标统计
 */
import { configKey } from '../core/config.js';
import { SqlEngineError } from '../errors.js';
import { getDriver, hasDriver } from '../driver/registry.js';
import type { PoolHandle } from '../driver/interface.js';
import type { ConnectionConfig } from '../types/config.js';
import type { ClientManagerOptions, PoolMetrics } from '../types/manager.js';

interface PoolRecord {
  fingerprint: string;
  config: ConnectionConfig;
  handle: PoolHandle | null;
  creating: Promise<PoolHandle> | null;
  refs: number;
  lastUsedAt: number;
}

export class PoolRegistry {
  private pools = new Map<string, PoolRecord>();
  private totalRefs = 0;
  private maxClients: number;
  private lruEnabled: boolean;
  private maxIdlePools: number;

  constructor(options: ClientManagerOptions = {}) {
    this.maxClients = options.maxClients ?? 500;
    this.lruEnabled = options.lru?.enabled ?? true;
    this.maxIdlePools = options.lru?.maxIdlePools ?? 50;
  }

  /**
   * 获取/创建连接池并 +1 引用
   * 首次遇到某指纹时懒创建池；之后复用（不按请求建池）
   */
  async getPool(config: ConnectionConfig): Promise<PoolHandle> {
    if (!hasDriver(config.type)) {
      throw new SqlEngineError(
        'UNSUPPORTED_DIALECT',
        `方言 "${config.type}" 驱动未注册（M2+ 提供 mysql/postgresql/mongodb，当前可用: sqlite）`,
        { dialect: config.type },
      );
    }
    if (this.totalRefs >= this.maxClients) {
      throw new SqlEngineError(
        'CLIENT_LIMIT_EXCEEDED',
        `全局 client 数达到上限 ${this.maxClients}（ClientManagerOptions.maxClients 可调）`,
      );
    }

    const fingerprint = configKey(config);
    let record = this.pools.get(fingerprint);
    if (!record) {
      record = { fingerprint, config, handle: null, creating: null, refs: 0, lastUsedAt: Date.now() };
      this.pools.set(fingerprint, record);
    }

    if (!record.handle) {
      record.creating ??= getDriver(config.type).createPool(config);
      try {
        record.handle = await record.creating;
      } finally {
        record.creating = null;
      }
    }

    record.refs++;
    record.lastUsedAt = Date.now();
    this.totalRefs++;
    return record.handle;
  }

  /** -1 引用；归零的池进入空闲集合（LRU 超限时回收） */
  release(fingerprint: string): void {
    const record = this.pools.get(fingerprint);
    if (!record) return;
    record.refs = Math.max(0, record.refs - 1);
    this.totalRefs = Math.max(0, this.totalRefs - 1);
    record.lastUsedAt = Date.now();
    this.maybeCollectIdle();
  }

  /** 强制销毁池（数据源 update/remove 时调用） */
  async invalidate(fingerprint: string): Promise<void> {
    const record = this.pools.get(fingerprint);
    if (!record) return;
    this.pools.delete(fingerprint);
    this.totalRefs = Math.max(0, this.totalRefs - record.refs);
    if (record.handle) {
      await record.handle.destroy().catch(() => undefined);
    }
  }

  /** 全局清理（应用退出） */
  async destroyAll(): Promise<void> {
    const records = [...this.pools.values()];
    this.pools.clear();
    this.totalRefs = 0;
    await Promise.all(
      records.map((r) =>
        r.handle ? r.handle.destroy().catch(() => undefined) : Promise.resolve(),
      ),
    );
  }

  /** 池指标（监控/容量规划） */
  metrics(): PoolMetrics {
    let active = 0;
    let idle = 0;
    let waiting = 0;
    let createdTotal = 0;
    let destroyedTotal = 0;
    for (const r of this.pools.values()) {
      if (!r.handle) continue;
      const s = r.handle.stats;
      active += s.active;
      idle += s.idle;
      waiting += s.waiting;
      createdTotal += s.createdTotal;
      destroyedTotal += s.destroyedTotal;
    }
    return {
      clients: this.totalRefs,
      pools: this.pools.size,
      active,
      idle,
      waiting,
      createdTotal,
      destroyedTotal,
    };
  }

  /** 空闲池 LRU 淘汰：引用归零的池超过 maxIdlePools 时，回收最久未用者 */
  private maybeCollectIdle(): void {
    if (!this.lruEnabled) return;
    const idleRecords = [...this.pools.values()]
      .filter((r) => r.refs === 0 && r.handle)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    const over = idleRecords.length - this.maxIdlePools;
    if (over <= 0) return;

    for (const record of idleRecords.slice(0, over)) {
      this.pools.delete(record.fingerprint);
      void record.handle!.destroy().catch(() => undefined);
    }
  }

  /** 测试辅助：清空注册表 */
  async reset(): Promise<void> {
    await this.destroyAll();
  }
}

/** 模块级默认注册表（所有入口共享） */
export const defaultRegistry = new PoolRegistry();
